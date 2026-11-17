## Assumptions

- Losing a submission is worse than sending it late. Sending a duplicate is also bad, because an appraiser would see the same machine twice.
- The server can de-duplicate using an `Idempotency-Key` header. If the real server can't, this is the first thing to agree with the backend team.
- Dealers often reopen the app later, so "send when the app is open" is acceptable for now.

## What I prioritised and why

1. **Never lose data:** persist before sending, and copy photos out of the cache.
2. **No duplicates:** use an idempotency key, because retries are only safe with one.
3. **Recovery:** timeouts, backoff, retry on reconnect, foreground and app start.

4. **Tests** for the queue logic, which is pure TypeScript with injected clock, storage and network.

## Considered and rejected

- **Uploading photos in parallel:** on bad wifi, parallel uploads compete for the same bandwidth. Sending one at a time is more predictable.
- **Redux / React Query offline:** too much for a single queue, and harder to explain.

- **Visibility:** each submission shows its status, so dealers trust the app and don't submit twice, because of time constrints not able to touch this scenario.

## Next steps

- Compress and resize photos before upload.
