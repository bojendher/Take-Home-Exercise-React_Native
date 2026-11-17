import http from 'node:http';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { keepAdbReverse } from './adbReverse.mjs';
import { createApp } from './app.mjs';
import { PRESETS } from './simulate.mjs';

const PORT = Number(process.env.PORT ?? 4000);
const HOST = process.env.HOST ?? '0.0.0.0'; // listen on the LAN so phones can reach it
const SIM_PRESET = process.env.SIM_PRESET ?? 'off';
const UPLOAD_DIR = process.env.UPLOAD_DIR ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'uploads');

if (!(SIM_PRESET in PRESETS)) {
  console.error(`Unknown SIM_PRESET "${SIM_PRESET}". Use one of: ${Object.keys(PRESETS).join(', ')}`);
  process.exit(1);
}

const server = http.createServer(
  createApp({
    uploadDir: UPLOAD_DIR,
    maxImageBytes: Number(process.env.MAX_IMAGE_MB ?? 15) * 1024 * 1024,
    simPreset: SIM_PRESET,
  }),
);

// Must exceed the simulator's hangMs so "timeout" outcomes hang for real.
server.requestTimeout = 120_000;

server.listen(PORT, HOST, () => {
  const lan = Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => `http://${i.address}:${PORT}`);
  console.log(`Upload server listening on http://localhost:${PORT}`);
  for (const addr of lan) console.log(`  LAN: ${addr}`);
  console.log(`  Simulation preset: ${SIM_PRESET}  (change at runtime: PUT /__sim)`);
  console.log(`  Files saved to: ${UPLOAD_DIR}`);
  keepAdbReverse(PORT);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close();
    server.closeAllConnections();
    process.exit(0);
  });
}
