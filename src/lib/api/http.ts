import { getApiBaseUrl } from "./config";
import { UploadError, isRetryableStatus } from "./errors";
import { isOffline, waitForOnline } from "./network";

export type RetryInfo = { attempt: number; delayMs: number; error: UploadError };

export type RequestOptions = {
  method: "GET" | "POST" | "PUT";
  path: string;
  /** JSON body, or a factory for a fresh FormData per attempt. */
  json?: unknown;
  form?: () => FormData;
  headers?: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Number of retries after the first attempt. */
  retries?: number;
  onRetry?: (info: RetryInfo) => void;
};

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 8_000;
/** How long to wait for connectivity to come back before failing as "offline". */
const OFFLINE_WAIT_MS = 60_000;

function backoff(attempt: number): number {
  const exp = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
  return Math.round(exp / 2 + Math.random() * (exp / 2)); // "equal jitter"
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new UploadError("canceled", "Upload canceled"));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new UploadError("canceled", "Upload canceled"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.min(MAX_DELAY_MS * 4, Math.max(0, secs * 1000));
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

async function attempt<T>(base: string, opts: RequestOptions): Promise<T> {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, opts.timeoutMs);
  const onAbort = () => ctrl.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  let res: Response;
  try {
    const headers: Record<string, string> = { accept: "application/json", ...opts.headers };
    let body: BodyInit | undefined;
    if (opts.form) body = opts.form();
    else if (opts.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.json);
    }
    res = await fetch(`${base}${opts.path}`, { method: opts.method, headers, body, signal: ctrl.signal });
  } catch {
    if (opts.signal?.aborted) throw new UploadError("canceled", "Upload canceled");
    if (timedOut) throw new UploadError("timeout", `No response within ${opts.timeoutMs / 1000}s`);
    // fetch only rejects for transport failures: tell "offline" apart from "server down".
    if (await isOffline()) throw new UploadError("offline", "Device is offline");
    throw new UploadError("unreachable", `Could not connect to ${base}`);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }

  // Bodies may be non-JSON (proxies, captive portals) or empty: parse defensively.
  const text = await res.text().catch(() => "");
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (res.ok) {
    if (data === null) {
      throw new UploadError("server", "Server returned an invalid response", { status: res.status });
    }
    return data as T;
  }

  const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
  const { code, message, ...details } = err ?? {};
  throw new UploadError(
    isRetryableStatus(res.status) ? "server" : "rejected",
    message ?? `Request failed with status ${res.status}`,
    {
      status: res.status,
      code,
      details,
      retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
    },
  );
}

/** fetch + per-attempt timeout + retries with backoff + offline waiting. */
export async function request<T>(opts: RequestOptions): Promise<T> {
  const base = getApiBaseUrl();
  if (!base) throw new UploadError("not_configured", "No API URL configured");
  const retries = opts.retries ?? 3;

  for (let n = 0; ; n++) {
    if (opts.signal?.aborted) throw new UploadError("canceled", "Upload canceled");
    await waitForOnline(opts.signal, OFFLINE_WAIT_MS);
    try {
      return await attempt<T>(base, opts);
    } catch (e) {
      const error =
        e instanceof UploadError ? e : new UploadError("unreachable", String(e));
      if (!error.retryable || n >= retries) throw error;
      // Offline: no point backing off; waitForOnline at the top handles it.
      const delayMs = error.kind === "offline" ? 0 : (error.retryAfterMs ?? backoff(n));
      opts.onRetry?.({ attempt: n + 1, delayMs, error });
      await sleep(delayMs, opts.signal);
    }
  }
}
