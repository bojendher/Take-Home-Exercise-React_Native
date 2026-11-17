/** Short unique id; good enough for local file names and idempotency keys. */
export function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
