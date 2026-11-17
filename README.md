# Take-Home-Exercise-React_Native
CodingTask using AI 

## equipment-appraisal (Expo + TypeScript)

```bash
cd equipment-appraisal
npm install
npm start          # then press i / a / w, or scan the QR code with Expo Go
npm run typecheck
```

Navigation uses Expo Router; routes live in `equipment-appraisal/src/app/`.

### Local upload server

```bash
npm run server        # upload API on :4000 (the app finds it automatically in dev)
npm run test:server
```

See [server/README.md](server/README.md) for the API contract and the network-simulation controls (latency, errors, timeouts, server-down).

### Tests

```bash
npm test                  # app: offline submissions, failures, retries, recovery, local persistence (Jest)
npm run test:integration  # real upload client against the real server with injected network faults
npm run test:server       # server API contract and network simulation
npm run test:all          # all of the above
```

- `__tests__/` (Jest, `jest-expo`, React Native Testing Library) drives the real `EquipmentUploadForm` on a fake clock. Only the native boundaries are faked, in `__tests__/support/`: network state, file system, SQLite store, image picker, and an in-memory upload server behind `expo/fetch` that can inject faults.
- `tests/integration/` (`node:test`) runs the TypeScript client from `src/lib` in Node against `server/` and uses the server's `/__sim` controls to inject faults.
