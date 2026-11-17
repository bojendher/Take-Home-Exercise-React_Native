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
