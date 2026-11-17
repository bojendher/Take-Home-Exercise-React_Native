# Local upload server

A zero-dependency Node (≥ 22) dev server for the equipment upload flow, with a
network-simulation layer that injects latency, errors, timeouts and dropped
connections, so you can see how the app copes with a bad network.

```bash
npm run server          # http://localhost:4000, simulation off
npm run server:flaky    # start with the "flaky" preset
npm run test:server     # contract + simulation tests
```

The server listens on `0.0.0.0` and prints its LAN address. In development the
app reaches it automatically on the same host Metro uses, port 4000. That works
for a physical phone, the iOS simulator, the Android emulator and web. To point
the app somewhere else, set `EXPO_PUBLIC_API_URL`.

| Env var       | Default         | Meaning                                  |
| ------------- | --------------- | ---------------------------------------- |
| `PORT`        | `4000`          |                                          |
| `HOST`        | `0.0.0.0`       |                                          |
| `SIM_PRESET`  | `off`           | `off`, `slow`, `flaky`, `down`           |
| `MAX_IMAGE_MB`| `15`            | Per-image size limit                     |
| `UPLOAD_DIR`  | `server/uploads`| Where images are written (git-ignored)   |

## Upload contract

Images are sent **one at a time**, so a failure costs one image instead of the
whole batch, and an interrupted upload can resume where it left off.

```
POST /api/uploads                      → create an upload session
PUT  /api/uploads/:id/images/:index    → send image #index (0-based), one per request
POST /api/uploads/:id/complete         → finalize once every index is present
GET  /api/uploads/:id                  → which indexes the server already has (for resume)
GET  /health
```

**Create.** JSON `{ brand, model, totalImages }`. `brand` and `model` must be
non-empty, at most 100 characters. `totalImages` must be 1–50. Send an
`Idempotency-Key` header: retrying with the same key returns the original
session (200) instead of creating a duplicate. The same key with a different
body returns 422 `idempotency_mismatch`.

**Image.** `multipart/form-data` with a file field named `image`. A `PUT` to the
same index replaces that image (200 instead of 201), so retries are always safe.
The real type comes from the file's magic bytes; the client's declared MIME type
is ignored. Accepted: JPEG, PNG, GIF, WebP, HEIC.

**Complete.** Returns 409 `missing_images` with `missing: [indexes]` if any image
is absent. Completing an upload that is already complete returns 200.

All responses are JSON. Errors look like this:

```json
{ "error": { "code": "unsupported_image", "message": "…", "...": "extra fields" } }
```

| Status | `code`                                    | Retry? |
| ------ | ----------------------------------------- | ------ |
| 400    | `validation_failed`, `invalid_json`, `invalid_multipart`, `invalid_index`, `empty_file` | no |
| 404    | `upload_not_found` (unknown id, or the server restarted: sessions are in memory) | start a new session |
| 405    | `method_not_allowed`                      | no     |
| 409    | `upload_complete`, `missing_images`       | no / re-send missing |
| 413    | `payload_too_large`                       | no     |
| 415    | `unsupported_media_type`, `unsupported_image` | no |
| 422    | `idempotency_mismatch`                    | no     |
| 5xx    | `simulated_error`, `internal_error` (503 sends `Retry-After`) | yes |

## Network simulation

Applies to every route except `/__sim*` and CORS preflights. Each request first
waits `latencyMs + random × jitterMs`, then gets one outcome:

| Outcome   | What the client sees |
| --------- | -------------------- |
| `ok`      | Normal response |
| `error`   | A random status from `errorStatuses` (503 includes `Retry-After: 1`) |
| `timeout` | The connection stays open and no response comes; the socket is destroyed after `hangMs` |
| `drop`    | Connection reset before handling (network error) |
| `lost`    | **The request is processed** (the image is saved), then the connection is reset, so the client can't tell it succeeded. This tests that retries are idempotent. |

`down: "503"` makes every request return 503. `down: "drop"` resets every
connection, which looks like a crashed server. To test "server not running",
just stop the server.

```bash
# inspect
curl localhost:4000/__sim
# presets: off | slow | flaky | down
curl -X PUT localhost:4000/__sim -H 'content-type: application/json' -d '{"preset":"flaky"}'
# fine-tune (merged into the current config)
curl -X PUT localhost:4000/__sim -H 'content-type: application/json' \
  -d '{"latencyMs":2000,"jitterMs":500,"errorRate":0.3,"errorStatuses":[502,503]}'
curl -X PUT localhost:4000/__sim -H 'content-type: application/json' -d '{"down":"drop"}'
# deterministic: force the outcomes of the next N requests
curl -X POST localhost:4000/__sim/next -H 'content-type: application/json' \
  -d '{"outcomes":["lost","503","timeout","drop","ok"]}'
# back to normal
curl -X DELETE localhost:4000/__sim
```

Rates (`errorRate`, `timeoutRate`, `dropRate`, `lostResponseRate`) are
probabilities from 0 to 1, and their sum should be at most 1.

## How the app handles failures

See `src/lib/api/` and `src/lib/uploadEquipment.ts`.

- **Per-request timeout**: 10s for create/complete, 30s per image.
- **Retries, two layers** (`src/lib/api/retry.ts`). Both use exponential
  backoff with "equal jitter", meaning a random delay between half and all of the
  computed value.
  1. *Per request*: 3 retries at 0.5s → 1s → 2s (capped at 8s). A server
     `Retry-After` header overrides the delay, up to 30s.
  2. *Per upload*: if the requests still give up (server down, unreachable,
     timing out), the whole upload is retried automatically up to 5 times at
     5s → 10s → 20s → 40s → 60s. Each retry resumes the same server session, so
     images that were already sent are skipped. The app shows a countdown with
     **Retry now** and **Cancel**.

  Only network errors, timeouts, 408/425/429 and 5xx are retried. Other 4xx
  errors fail immediately with the server's message. Being offline isn't
  retried on a timer: the upload waits for the connection to return instead.
- **Offline**: before each attempt the app checks `expo-network`. If the device
  is offline, it waits up to 60s for the connection to return, then fails as
  "offline". An offline banner is shown in the meantime.
- **Offline vs server down**: when a fetch fails while the device is online,
  the error is reported as "can't reach the server".
- **Resume**: after any failure, the button becomes "Resume upload (n/N sent)".
  It asks the server which images it already has and sends only the rest.
  Changing the photos or fields starts a new session.
- **Server restart**: the session's 404 triggers one automatic restart with a
  new session.
- **Cancel**: aborts the in-flight request and any pending backoff.
