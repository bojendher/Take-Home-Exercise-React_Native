import { fetch } from "expo/fetch";

import { getApiBaseUrl } from "./config";
import { UploadError, isRetryableStatus } from "./errors";
import { isOffline, waitForOnline } from "./network";
import { REQUEST_BACKOFF, backoffDelay, sleep, type BackoffPolicy } from "./retry";

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
  /** Number of retries after the first attempt. Default 3. */
  retries?: number;
  /** Delay schedule between retries. Default REQUEST_BACKOFF. */
  backoff?: BackoffPolicy;
  onRetry?: (info: RetryInfo) => void;
};

/** How long to wait for connectivity to come back before failing as "offline". */
const OFFLINE_WAIT_MS = 60_000;
/** Never wait longer than this for a server-provided Retry-After. */
const MAX_RETRY_AFTER_MS = 30_000;

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, secs * 1000));
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.min(MAX_RETRY_AFTER_MS, Math.max(0, date - Date.now()));
}

/**
 * Did fetch fail in transport (no/broken connection), as opposed to a local
 * problem preparing the request? Transport failures surface as:
 *   expo/fetch → FetchError "fetch failed: …"
 *   RN fetch   → TypeError "Network request failed"
 *   browsers   → TypeError "Failed to fetch" / "NetworkError …" / "Load failed"
 * Anything else (e.g. "Unsupported FormDataPart implementation") is a client
 * bug and must not be reported as "server unreachable".
 */
export function isTransportError(e: unknown): boolean {
  if (e instanceof TypeError) return true;
  const message = e instanceof Error ? e.message : String(e);
  return /^fetch failed|network request failed|failed to fetch|networkerror|load failed/i.test(message);
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function attempt<T>(base: string, opts: RequestOptions): Promise<T> {
  // Build the body first: failures here are local, not network problems.
  const headers: Record<string, string> = { accept: "application/json", ...opts.headers };
  let body: BodyInit | undefined;
  try {
    if (opts.form) body = opts.form();
    else if (opts.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.json);
    }
  } catch (e) {
    if (e instanceof UploadError) throw e;
    throw new UploadError("rejected", `Couldn't prepare the request: ${errorMessage(e)}`, {
      code: "client_error",
    });
  }

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
    res = (await fetch(`${base}${opts.path}`, {
      method: opts.method,
      headers,
      body: body as never,
      signal: ctrl.signal,
    })) as unknown as Response;
  } catch (e) {
    if (opts.signal?.aborted) throw new UploadError("canceled", "Upload canceled");
    if (timedOut) throw new UploadError("timeout", `No response within ${opts.timeoutMs / 1000}s`);
    const cause = errorMessage(e);
    if (!isTransportError(e)) {
      // e.g. the fetch implementation can't encode this body. Retrying won't help.
      throw new UploadError("rejected", `Couldn't send the request: ${cause}`, {
        code: "client_error",
        details: { cause },
      });
    }
    // Transport failure: tell "offline" apart from "server down".
    if (await isOffline()) throw new UploadError("offline", "Device is offline");
    throw new UploadError("unreachable", `Could not connect to ${base}`, {
      details: { url: base, cause },
    });
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

/**
 * fetch + per-attempt timeout + retries with exponential backoff + offline waiting.
 * Only transient failures are retried (network, timeout, 408/425/429/5xx);
 * a server Retry-After overrides the computed delay.
 */
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
      const delayMs = error.kind === "offline" ? 0 : (error.retryAfterMs ?? backoffDelay(n, opts.backoff ?? REQUEST_BACKOFF));
      opts.onRetry?.({ attempt: n + 1, delayMs, error });
      await sleep(delayMs, opts.signal);
    }
  }
}
