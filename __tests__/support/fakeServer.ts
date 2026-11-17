/**
 * In-memory upload server behind the mocked `expo/fetch`, following the
 * contract in server/README.md, with injectable faults.
 */
import { network, setOfflineSilently } from "./network";

export type Fault =
  | "network" // connection refused / dropped (fetch rejects)
  | "hang" // never responds (until aborted)
  | "lost" // handled, but the response never arrives
  | "offline" // the device loses connectivity while sending this request
  | number; // respond with this HTTP status

type Upload = {
  uploadId: string;
  brand: string;
  model: string;
  totalImages: number;
  received: Set<number>;
  status: "pending" | "complete";
};

type Rule = { match: RegExp; fault: Fault; times: number };

const uploads = new Map<string, Upload>();
const idempotency = new Map<string, string>();
let rules: Rule[] = [];
let down: false | "network" | 503 = false;
let nextId = 1;

/** Every request that reached the server, e.g. "PUT /api/uploads/u1/images/0". */
export const requests: string[] = [];
/** Every request the client attempted, including ones that never got through. */
export const attempts: string[] = [];

export const server = {
  /** Inject `fault` for the next `times` requests matching `match` ("METHOD /path"). */
  fail(match: RegExp, fault: Fault, times = 1) {
    rules.push({ match, fault, times });
  },
  /** Take the whole server down (until `up()`). */
  down(mode: "network" | 503 = "network") {
    down = mode;
  },
  up() {
    down = false;
  },
  /** Stop injecting faults (sessions and logs are kept). */
  clearFaults() {
    rules = [];
    down = false;
  },
  /** Simulate a restart: all sessions are forgotten. */
  restart() {
    uploads.clear();
    idempotency.clear();
  },
  uploads,
  reset() {
    uploads.clear();
    idempotency.clear();
    rules = [];
    down = false;
    nextId = 1;
    requests.length = 0;
    attempts.length = 0;
  },
  /** Indexes stored for an upload. */
  received(uploadId: string) {
    return [...(uploads.get(uploadId)?.received ?? [])].sort();
  },
  count(re: RegExp) {
    return requests.filter((r) => re.test(r)).length;
  },
  attempted(re: RegExp) {
    return attempts.filter((r) => re.test(r)).length;
  },
};

class FetchError extends Error {
  constructor(message: string) {
    super(`fetch failed: ${message}`);
  }
}

function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => lower[k.toLowerCase()] ?? null },
    text: async () => JSON.stringify(body),
  };
}

const error = (status: number, code: string, message: string, extra: object = {}) =>
  respond(status, { error: { code, message, ...extra } });

const serialize = (u: Upload) => ({
  uploadId: u.uploadId,
  brand: u.brand,
  model: u.model,
  totalImages: u.totalImages,
  received: [...u.received].sort(),
  status: u.status,
});

/** Mirrors expo/fetch: only Blob-like parts with readable bytes are encodable. */
async function readImagePart(body: unknown): Promise<Uint8Array> {
  const parts: [string, unknown][] =
    (body as { _parts?: [string, unknown][] })?._parts ??
    [...((body as FormData).entries?.() ?? [])];
  const part = parts.find(([name]) => name === "image")?.[1] as { bytes?: () => Promise<Uint8Array> } | undefined;
  if (!part || typeof part.bytes !== "function") {
    throw new Error("Unsupported FormDataPart implementation");
  }
  return part.bytes();
}

function route(method: string, path: string, init: RequestInit & { body?: unknown }) {
  const headers = (init.headers ?? {}) as Record<string, string>;
  let m: RegExpMatchArray | null;

  if (method === "POST" && path === "/api/uploads") {
    const { brand, model, totalImages } = JSON.parse(String(init.body));
    const key = headers["idempotency-key"];
    if (key && idempotency.has(key) && uploads.has(idempotency.get(key)!)) {
      return respond(200, serialize(uploads.get(idempotency.get(key)!)!));
    }
    const upload: Upload = {
      uploadId: `u${nextId++}`,
      brand,
      model,
      totalImages,
      received: new Set(),
      status: "pending",
    };
    uploads.set(upload.uploadId, upload);
    if (key) idempotency.set(key, upload.uploadId);
    return respond(201, serialize(upload));
  }
  if ((m = path.match(/^\/api\/uploads\/([^/]+)$/)) && method === "GET") {
    const u = uploads.get(m[1]);
    return u ? respond(200, serialize(u)) : error(404, "upload_not_found", "Upload not found");
  }
  if ((m = path.match(/^\/api\/uploads\/([^/]+)\/images\/(\d+)$/)) && method === "PUT") {
    const u = uploads.get(m[1]);
    if (!u) return error(404, "upload_not_found", "Upload not found");
    const index = Number(m[2]);
    const replaced = u.received.has(index);
    u.received.add(index);
    return respond(replaced ? 200 : 201, { index, replaced, received: serialize(u).received });
  }
  if ((m = path.match(/^\/api\/uploads\/([^/]+)\/complete$/)) && method === "POST") {
    const u = uploads.get(m[1]);
    if (!u) return error(404, "upload_not_found", "Upload not found");
    const missing = [...Array(u.totalImages).keys()].filter((i) => !u.received.has(i));
    if (missing.length) return error(409, "missing_images", "Missing images", { missing });
    u.status = "complete";
    return respond(200, serialize(u));
  }
  return error(404, "not_found", "No route");
}

export async function fakeFetch(url: string, init: RequestInit & { body?: unknown } = {}) {
  const method = (init.method ?? "GET").toUpperCase();
  const path = new URL(url).pathname;
  const signal = init.signal ?? undefined;

  // expo/fetch encodes the body before sending anything.
  const image = init.body && typeof init.body === "object" ? await readImagePart(init.body) : null;

  await Promise.resolve();
  if (signal?.aborted) throw new FetchError("The operation was aborted.");
  const label = `${method} ${path}`;
  attempts.push(label);
  if (!network.online) throw new FetchError("Unable to resolve host");

  const rule = rules.find((r) => r.match.test(label) && r.times > 0);
  if (rule) rule.times--;
  const fault: Fault | undefined = down || rule?.fault;

  if (fault === "offline") {
    setOfflineSilently();
    throw new FetchError("Unable to resolve host");
  }
  if (fault === "network") throw new FetchError("Failed to connect");
  if (fault === "hang") {
    requests.push(label);
    return new Promise((_, reject) =>
      signal?.addEventListener("abort", () => reject(new FetchError("The operation was aborted."))),
    );
  }
  requests.push(label);
  if (typeof fault === "number") {
    return error(fault, "simulated_error", `Simulated ${fault}`);
  }
  if (image && image.length === 0) return error(400, "empty_file", "Image file is empty");
  const res = route(method, path, init);
  if (fault === "lost") throw new FetchError("Connection reset");
  return res;
}
