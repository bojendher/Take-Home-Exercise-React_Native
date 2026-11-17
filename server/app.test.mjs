import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';

import { createApp } from './app.mjs';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

let server;
let base;
let uploadDir;

before(async () => {
  uploadDir = await mkdtemp(path.join(tmpdir(), 'uploads-test-'));
  server = http.createServer(createApp({ uploadDir, maxImageBytes: 1024, maxImages: 5, log: () => {} }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await rm(uploadDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await fetch(`${base}/__sim`, { method: 'DELETE' });
});

const json = (method, p, body, headers = {}) =>
  fetch(`${base}${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

function putImage(id, index, bytes = JPEG, name = 'a.jpg', type = 'image/jpeg') {
  const fd = new FormData();
  if (bytes) fd.append('image', new File([bytes], name, { type }));
  return fetch(`${base}/api/uploads/${id}/images/${index}`, { method: 'PUT', body: fd });
}

async function createUpload(total = 2, headers) {
  const res = await json('POST', '/api/uploads', { brand: 'Caterpillar', model: '320', totalImages: total }, headers);
  return { res, body: await res.json() };
}

const sim = (patch) => json('PUT', '/__sim', patch);
const queue = (outcomes) => json('POST', '/__sim/next', { outcomes });

describe('upload contract', () => {
  test('happy path: create, sequential PUTs, complete', async () => {
    const { res, body } = await createUpload(2);
    assert.equal(res.status, 201);
    assert.deepEqual(body.received, []);

    assert.equal((await putImage(body.uploadId, 0)).status, 201);
    const second = await putImage(body.uploadId, 1, PNG, 'b.png', 'image/png');
    assert.equal(second.status, 201);
    assert.deepEqual((await second.json()).received, [0, 1]);

    const done = await json('POST', `/api/uploads/${body.uploadId}/complete`);
    assert.equal(done.status, 200);
    assert.equal((await done.json()).status, 'complete');
    assert.deepEqual((await readdir(path.join(uploadDir, body.uploadId))).sort(), ['0.jpg', '1.png']);

    // complete is idempotent
    assert.equal((await json('POST', `/api/uploads/${body.uploadId}/complete`)).status, 200);
    // no more images after completion
    assert.equal((await putImage(body.uploadId, 0)).status, 409);
  });

  test('re-uploading the same index replaces it (retry-safe)', async () => {
    const { body } = await createUpload(1);
    await putImage(body.uploadId, 0);
    const again = await putImage(body.uploadId, 0);
    assert.equal(again.status, 200);
    assert.equal((await again.json()).replaced, true);
  });

  test('Idempotency-Key makes create retry-safe', async () => {
    const a = await createUpload(2, { 'idempotency-key': 'k1' });
    const b = await createUpload(2, { 'idempotency-key': 'k1' });
    assert.equal(a.res.status, 201);
    assert.equal(b.res.status, 200);
    assert.equal(a.body.uploadId, b.body.uploadId);
    const c = await createUpload(3, { 'idempotency-key': 'k1' });
    assert.equal(c.res.status, 422);
  });

  test('complete with missing images returns 409 listing them', async () => {
    const { body } = await createUpload(3);
    await putImage(body.uploadId, 1);
    const res = await json('POST', `/api/uploads/${body.uploadId}/complete`);
    assert.equal(res.status, 409);
    assert.deepEqual((await res.json()).error.missing, [0, 2]);
  });

  test('validation and edge cases', async () => {
    const bad = async (res, status, code) => {
      assert.equal(res.status, status);
      assert.equal((await res.json()).error.code, code);
    };
    await bad(await json('POST', '/api/uploads', { brand: ' ', model: 'x', totalImages: 1 }), 400, 'validation_failed');
    await bad(await json('POST', '/api/uploads', { brand: 'a', model: 'x', totalImages: 0 }), 400, 'validation_failed');
    await bad(await json('POST', '/api/uploads', { brand: 'a', model: 'x', totalImages: 6 }), 400, 'validation_failed');
    await bad(await json('POST', '/api/uploads', { brand: 'a'.repeat(101), model: 'x', totalImages: 1 }), 400, 'validation_failed');
    await bad(
      await fetch(`${base}/api/uploads`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' }),
      400,
      'invalid_json',
    );
    await bad(await fetch(`${base}/api/uploads`, { method: 'POST', body: 'x' }), 415, 'unsupported_media_type');
    await bad(await json('GET', '/api/uploads/nope'), 404, 'upload_not_found');
    await bad(await json('DELETE', '/api/uploads'), 405, 'method_not_allowed');
    await bad(await json('GET', '/nowhere'), 404, 'not_found');

    const { body } = await createUpload(2);
    const id = body.uploadId;
    await bad(await putImage(id, 2), 400, 'invalid_index');
    await bad(await putImage(id, 'x'), 400, 'invalid_index');
    await bad(await putImage(id, 0, null), 400, 'validation_failed');
    await bad(await putImage(id, 0, Buffer.alloc(0)), 400, 'empty_file');
    await bad(await putImage(id, 0, Buffer.from('not an image at all')), 415, 'unsupported_image');
    // claims to be a jpeg but is text: rejected by magic-byte sniffing
    await bad(await putImage(id, 0, Buffer.from('hello'), 'x.jpg', 'image/jpeg'), 415, 'unsupported_image');
    await bad(await putImage(id, 0, Buffer.concat([JPEG, Buffer.alloc(2048)])), 413, 'payload_too_large');
    await bad(await putImage('missing', 0), 404, 'upload_not_found');
  });
});

describe('network simulation', () => {
  test('latency delays responses', async () => {
    await sim({ latencyMs: 200 });
    const t = Date.now();
    await fetch(`${base}/health`);
    assert.ok(Date.now() - t >= 190);
  });

  test('forced error, then ok', async () => {
    await queue(['503', 'ok']);
    const first = await fetch(`${base}/health`);
    assert.equal(first.status, 503);
    assert.equal(first.headers.get('retry-after'), '1');
    assert.equal((await fetch(`${base}/health`)).status, 200);
  });

  test('drop resets the connection', async () => {
    await queue(['drop']);
    await assert.rejects(fetch(`${base}/health`), TypeError);
  });

  test('timeout hangs until the client aborts', async () => {
    await queue(['timeout']);
    await assert.rejects(fetch(`${base}/health`, { signal: AbortSignal.timeout(300) }), { name: 'TimeoutError' });
  });

  test('lost response: the side effect happens but the client sees a network error', async () => {
    const { body } = await createUpload(1);
    await queue(['lost']);
    await assert.rejects(putImage(body.uploadId, 0), TypeError);
    const status = await (await json('GET', `/api/uploads/${body.uploadId}`)).json();
    assert.deepEqual(status.received, [0]);
  });

  test('down mode 503s every API route but admin still works', async () => {
    await sim({ preset: 'down' });
    assert.equal((await fetch(`${base}/health`)).status, 503);
    assert.equal((await json('POST', '/api/uploads', {})).status, 503);
    assert.equal((await json('GET', '/__sim')).status, 200);
    await sim({ down: 'drop' });
    await assert.rejects(fetch(`${base}/health`), TypeError);
  });

  test('admin validates input', async () => {
    assert.equal((await sim({ errorRate: 2 })).status, 400);
    assert.equal((await sim({ preset: 'nope' })).status, 400);
    assert.equal((await sim({ bogus: 1 })).status, 400);
    assert.equal((await queue(['explode'])).status, 400);
  });
});
