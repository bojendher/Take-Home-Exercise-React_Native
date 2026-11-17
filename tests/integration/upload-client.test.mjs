// The real upload client (src/lib) against the real server (server/), with
// network faults injected by the server's simulation layer.
import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';

import { photos, startServer } from '../support/server.mjs';

const srv = await startServer();
const { uploadEquipment, uploadWithAutoRetry } = await import('@/lib/uploadEquipment');
const { UploadError } = await import('@/lib/api/errors');

const FAST_BACKOFF = { baseMs: 50, maxMs: 200, jitter: 'none' };

function upload(opts = {}) {
  const events = [];
  const promise = uploadEquipment({
    images: photos(3),
    brand: 'Caterpillar',
    model: '320',
    idempotencyKey: `k-${Math.random()}`,
    onEvent: (e) => events.push(e),
    ...opts,
  });
  return { events, promise };
}

const retriesOf = (events) =>
  events.filter((e) => e.type === 'retry').map((e) => `${e.index ?? '-'}:${e.error.kind}${e.error.status ? `/${e.error.status}` : ''}`);
const sessionsOf = (events) => new Set(events.filter((e) => e.type === 'session').map((e) => e.uploadId));

beforeEach(() => {
  globalThis.__network.isConnected = true;
  return srv.reset();
});
after(() => srv.close());

describe('happy path', () => {
  test('creates a session, uploads images one at a time in order, completes', async () => {
    const { promise } = upload();
    const session = await promise;
    assert.equal(session.status, 'complete');
    assert.deepEqual(session.received, [0, 1, 2]);
    const puts = srv.logs.filter((l) => l.startsWith('PUT')).map((l) => l.split(' ')[1].split('/').pop());
    assert.deepEqual(puts, ['0', '1', '2']);
  });
});

describe('failures recovered by request retries', () => {
  test('lost create, 503, dropped connection, lost image response, 500: all recovered, no duplicates', async () => {
    await srv.next(['lost', '503', 'ok', 'drop', 'ok', 'lost', 'ok', '500', 'ok']);
    const { events, promise } = upload();
    const session = await promise;
    assert.equal(session.status, 'complete');
    assert.deepEqual(retriesOf(events), ['-:unreachable', '-:server/503', '0:unreachable', '1:unreachable', '2:server/500']);
    assert.equal(sessionsOf(events).size, 1, 'one server session');
    assert.equal(srv.count(/^POST \/api\/uploads -> 200 /), 1, 'retried create replayed the lost one (idempotency)');
  });

  test('a hung request times out on the client and is retried', { timeout: 30_000 }, async () => {
    await srv.next(['timeout']);
    const { events, promise } = upload({ images: photos(1) });
    assert.equal((await promise).status, 'complete');
    assert.deepEqual(retriesOf(events), ['-:timeout']);
  });

  test('503 with Retry-After: retries 3 times, then fails as a server error', async () => {
    await srv.sim({ down: '503' });
    const err = await upload({ images: photos(1) }).promise.catch((e) => e);
    assert.ok(err instanceof UploadError);
    assert.equal(err.kind, 'server');
    assert.equal(err.status, 503);
    assert.equal(srv.count(/^POST/), 4);
  });
});

describe('failures that must not be retried', () => {
  test('a rejected image (415) fails immediately', async () => {
    const bad = [...photos(1), ...photos(1, new TextEncoder().encode('not an image'))];
    const { events, promise } = upload({ images: bad });
    const err = await promise.catch((e) => e);
    assert.equal(err.kind, 'rejected');
    assert.equal(err.code, 'unsupported_image');
    assert.deepEqual(retriesOf(events), []);
    assert.deepEqual(
      events.filter((e) => e.type === 'image').map((e) => `${e.index}:${e.status}`),
      ['0:uploading', '0:done', '1:uploading', '1:failed'],
    );
  });

  test('cancel stops the upload', async () => {
    await srv.sim({ latencyMs: 300 });
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 450);
    const err = await upload({ signal: ctrl.signal }).promise.catch((e) => e);
    assert.equal(err.kind, 'canceled');
  });
});

describe('recovery', () => {
  test('server goes down mid-upload; Resume skips images already sent', async () => {
    let uploadId;
    const first = upload({
      onEvent: (e) => {
        if (e.type === 'session') uploadId = e.uploadId;
        if (e.type === 'image' && e.index === 0 && e.status === 'done') srv.sim({ down: 'drop' });
      },
    });
    const err = await first.promise.catch((e) => e);
    assert.equal(err.kind, 'unreachable');

    await srv.reset();
    const session = await upload({ resumeUploadId: uploadId }).promise;
    assert.equal(session.uploadId, uploadId);
    assert.equal(srv.count(/^PUT .*\/images\/0 /), 0, 'image 0 not re-sent');
    assert.equal(srv.count(/^PUT /), 2);
  });

  test('server restarted (session unknown): starts a fresh session automatically', async () => {
    const session = await upload({ resumeUploadId: 'forgotten-by-restart' }).promise;
    assert.equal(session.status, 'complete');
    assert.notEqual(session.uploadId, 'forgotten-by-restart');
  });

  test('device offline: waits for connectivity, then continues', async () => {
    globalThis.__network.isConnected = false;
    setTimeout(() => globalThis.__network.set(true), 300);
    const started = Date.now();
    const session = await upload({ images: photos(2) }).promise;
    assert.equal(session.status, 'complete');
    assert.ok(Date.now() - started >= 280);
  });
});

describe('upload-level automatic retry', () => {
  function autoUpload(opts = {}) {
    const events = [];
    const promise = uploadWithAutoRetry({
      images: photos(3),
      brand: 'Caterpillar',
      model: '320',
      idempotencyKey: `k-${Math.random()}`,
      backoff: FAST_BACKOFF,
      onEvent: (e) => events.push(e),
      ...opts,
    });
    return { events, promise };
  }
  const autos = (events) => events.filter((e) => e.type === 'auto-retry');

  test('server down for a while: retries with growing backoff, resumes the same session', { timeout: 30_000 }, async () => {
    let downed = false;
    const { events, promise } = autoUpload({
      onEvent: (e) => {
        events.push(e);
        if (!downed && e.type === 'image' && e.index === 0 && e.status === 'done') {
          downed = true;
          srv.sim({ down: 'drop' });
          setTimeout(() => srv.sim({ down: false }), 5_000); // back up after 5s
        }
      },
    });
    const session = await promise;
    assert.equal(session.status, 'complete');
    const delays = autos(events).map((e) => e.delayMs);
    assert.ok(delays.length >= 1);
    assert.deepEqual(delays, [50, 100, 200, 200, 200].slice(0, delays.length));
    assert.equal(sessionsOf(events).size, 1);
    assert.equal(srv.count(/^PUT .*\/images\/0 -> 20/), 1, 'image 0 stored exactly once');
  });

  test('gives up after maxAutoRetries', { timeout: 30_000 }, async () => {
    await srv.sim({ down: '503' });
    const { events, promise } = autoUpload({ images: photos(1), maxAutoRetries: 2 });
    const err = await promise.catch((e) => e);
    assert.equal(err.kind, 'server');
    assert.deepEqual(autos(events).map((e) => `${e.attempt}/${e.maxAttempts}`), ['1/2', '2/2']);
    assert.equal(srv.count(/^POST \/api\/uploads /), 12, '3 runs × (1 + 3 request retries)');
  });

  test('rejected errors are never auto-retried', async () => {
    const { events, promise } = autoUpload({ images: photos(1, new TextEncoder().encode('nope')) });
    assert.equal((await promise.catch((e) => e)).kind, 'rejected');
    assert.equal(autos(events).length, 0);
  });
});
