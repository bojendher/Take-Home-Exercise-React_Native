import { UploadError } from "./errors";

export type BackoffPolicy = {
  /** Delay before the first retry (attempt 0), before jitter. */
  baseMs: number;
  /** Upper bound for any single delay. */
  maxMs: number;
  /** Growth per attempt. Default 2 (doubling). */
  factor?: number;
  /**
   * "equal": random in [d/2, d] — spreads clients out but keeps a floor.
   * "full":  random in [0, d]   — maximum spread.
   * "none":  exactly d.
   */
  jitter?: "equal" | "full" | "none";
};

/** Retries of a single HTTP request: 0.5s, 1s, 2s, … capped at 8s. */
export const REQUEST_BACKOFF: BackoffPolicy = { baseMs: 500, maxMs: 8_000, jitter: "equal" };

/**
 * Retries of a whole upload after its requests gave up (e.g. server down for
 * a while): 5s, 10s, 20s, 40s, 60s.
 */
export const UPLOAD_BACKOFF: BackoffPolicy = { baseMs: 5_000, maxMs: 60_000, jitter: "equal" };

/** Exponential backoff delay for a 0-based retry attempt. */
export function backoffDelay(
  attempt: number,
  policy: BackoffPolicy,
  random: () => number = Math.random,
): number {
  const { baseMs, maxMs, factor = 2, jitter = "equal" } = policy;
  const exp = Math.min(maxMs, baseMs * factor ** Math.max(0, attempt));
  switch (jitter) {
    case "none":
      return Math.round(exp);
    case "full":
      return Math.round(random() * exp);
    case "equal":
      return Math.round(exp / 2 + random() * (exp / 2));
  }
}

/** Lets a caller end a backoff wait early ("Retry now"). */
export type Waker = {
  wake(): void;
  /** @internal */
  subscribe(fn: () => void): () => void;
};

export function createWaker(): Waker {
  const listeners = new Set<() => void>();
  return {
    wake() {
      const fns = [...listeners];
      listeners.clear();
      fns.forEach((fn) => fn());
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/** Waits `ms`; rejects with a "canceled" UploadError on abort; resolves early on wake. */
export function sleep(ms: number, signal?: AbortSignal, waker?: Waker): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new UploadError("canceled", "Upload canceled"));
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      unsubscribe?.();
    };
    const onAbort = () => {
      done();
      reject(new UploadError("canceled", "Upload canceled"));
    };
    const timer = setTimeout(() => {
      done();
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
    const unsubscribe = waker?.subscribe(() => {
      done();
      resolve();
    });
  });
}
