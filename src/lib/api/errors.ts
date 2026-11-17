export type UploadErrorKind =
  | "not_configured" // no server URL
  | "offline" // device has no network
  | "unreachable" // device online, but the server can't be reached (down, wrong URL)
  | "timeout" // server accepted the connection but didn't answer in time
  | "server" // 5xx / 408 / 429
  | "rejected" // other 4xx: the request itself is wrong; retrying won't help
  | "canceled"; // user canceled

const RETRYABLE: ReadonlySet<UploadErrorKind> = new Set([
  "offline",
  "unreachable",
  "timeout",
  "server",
]);

export class UploadError extends Error {
  readonly kind: UploadErrorKind;
  readonly status?: number;
  /** Server error code from `{ error: { code } }`, when present. */
  readonly code?: string;
  readonly details?: Record<string, unknown>;
  readonly retryAfterMs?: number;

  constructor(
    kind: UploadErrorKind,
    message: string,
    opts: {
      status?: number;
      code?: string;
      details?: Record<string, unknown>;
      retryAfterMs?: number;
    } = {},
  ) {
    super(message);
    // Keep `instanceof` working if Babel transpiles classes extending Error.
    Object.setPrototypeOf(this, UploadError.prototype);
    this.name = "UploadError";
    this.kind = kind;
    Object.assign(this, opts);
  }

  get retryable(): boolean {
    return RETRYABLE.has(this.kind);
  }
}

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/** Human-readable message for the UI. */
export function describeUploadError(e: unknown): string {
  if (!(e instanceof UploadError)) {
    return e instanceof Error ? e.message : "Something went wrong.";
  }
  switch (e.kind) {
    case "not_configured":
      return "No upload server is configured. Set EXPO_PUBLIC_API_URL.";
    case "offline":
      return "You're offline. Reconnect and tap Resume — photos already sent won't be re-sent.";
    case "unreachable": {
      const url = typeof e.details?.url === "string" ? ` at ${e.details.url}` : "";
      const cause = __DEV__ && typeof e.details?.cause === "string" ? ` (${e.details.cause})` : "";
      return `Can't reach the upload server${url}${cause}. It may be down — check it's running, then tap Resume.`;
    }
    case "timeout":
      return "The server took too long to respond. Tap Resume to try again.";
    case "server":
      return `The server had a problem (${e.status}). Tap Resume to try again.`;
    case "rejected":
      return e.message;
    case "canceled":
      return "Upload canceled.";
  }
}
