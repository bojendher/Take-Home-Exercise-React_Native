// Starts the real upload server (server/app.mjs) on a random port for a test file.
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createApp } from '../../server/app.mjs';

export async function startServer() {
  const uploadDir = await mkdtemp(path.join(tmpdir(), 'upload-it-'));
  const logs = [];
  const server = http.createServer(createApp({ uploadDir, log: (line) => logs.push(line) }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.EXPO_PUBLIC_API_URL = base;

  const admin = (method, p, body) =>
    fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });

  return {
    base,
    logs,
    uploadDir,
    /** Network simulation, e.g. sim({ down: 'drop' }) or sim({ preset: 'flaky' }). */
    sim: (patch) => admin('PUT', '/__sim', patch),
    /** Force the outcomes of the next requests, e.g. ['lost', '503', 'ok']. */
    next: (outcomes) => admin('POST', '/__sim/next', { outcomes }),
    async reset() {
      await admin('DELETE', '/__sim');
      logs.length = 0;
    },
    /** Server log lines matching a pattern, e.g. /^PUT .*images\/0 -> 20/. */
    count: (re) => logs.filter((l) => re.test(l)).length,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(uploadDir, { recursive: true, force: true });
    },
  };
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);

/** Photos in the shape the client uploads (web build: browser File). */
export function photos(count, bytes = JPEG) {
  return Array.from({ length: count }, (_, i) => ({
    uri: `blob:photo-${i}`,
    fileName: `photo-${i}.jpg`,
    mimeType: 'image/jpeg',
    file: new File([bytes], `photo-${i}.jpg`, { type: 'image/jpeg' }),
  }));
}
