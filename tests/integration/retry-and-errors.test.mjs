// Backoff maths, cancellable sleep, and error classification.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

process.env.EXPO_PUBLIC_API_URL = 'http://127.0.0.1:9'; // nothing listens on port 9

const { REQUEST_BACKOFF, UPLOAD_BACKOFF, backoffDelay, createWaker, sleep } = await import('@/lib/api/retry');
const { isTransportError, request } = await import('@/lib/api/http');
const { UploadError, describeUploadError } = await import('@/lib/api/errors');

describe('backoffDelay', () => {
  const schedule = (policy) => [0, 1, 2, 3, 4, 5, 6].map((n) => backoffDelay(n, { ...policy, jitter: 'none' }));

  test('doubles and caps: requests 0.5s → 8s, uploads 5s → 60s', () => {
    assert.deepEqual(schedule(REQUEST_BACKOFF), [500, 1000, 2000, 4000, 8000, 8000, 8000]);
    assert.deepEqual(schedule(UPLOAD_BACKOFF), [5000, 10000, 20000, 40000, 60000, 60000, 60000]);
  });

  test('custom factor and negative attempts', () => {
    assert.equal(backoffDelay(2, { baseMs: 100, maxMs: 1e6, factor: 3, jitter: 'none' }), 900);
    assert.equal(backoffDelay(-1, { baseMs: 100, maxMs: 1e6, jitter: 'none' }), 100);
  });

  test('jitter stays within bounds', () => {
    for (let n = 0; n < 8; n++) {
      const cap = Math.min(8000, 500 * 2 ** n);
      assert.equal(backoffDelay(n, REQUEST_BACKOFF, () => 0), cap / 2); // equal: [d/2, d]
      assert.equal(backoffDelay(n, REQUEST_BACKOFF, () => 0.999999), cap);
      assert.equal(backoffDelay(n, { ...REQUEST_BACKOFF, jitter: 'full' }, () => 0), 0); // full: [0, d]
    }
  });
});

describe('sleep', () => {
  test('waits', async () => {
    const t = Date.now();
    await sleep(100);
    assert.ok(Date.now() - t >= 90);
  });

  test('"Retry now" wakes it early', async () => {
    const waker = createWaker();
    const t = Date.now();
    setTimeout(() => waker.wake(), 30);
    await sleep(10_000, undefined, waker);
    assert.ok(Date.now() - t < 1000);
    waker.wake(); // no sleepers: no-op
  });

  test('cancel rejects with a "canceled" error', async () => {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 30);
    await assert.rejects(sleep(10_000, ctrl.signal), (e) => e.kind === 'canceled');
    const pre = new AbortController();
    pre.abort();
    await assert.rejects(sleep(10, pre.signal), (e) => e.kind === 'canceled');
  });
});

describe('error classification', () => {
  class FetchError extends Error {
    constructor(m) {
      super(`fetch failed: ${m}`);
    }
  }

  test('transport errors from each fetch implementation are recognised', () => {
    assert.equal(isTransportError(new FetchError('Failed to connect to /192.168.1.13:4000')), true); // expo/fetch
    assert.equal(isTransportError(new TypeError('Network request failed')), true); // RN fetch
    assert.equal(isTransportError(new TypeError('Failed to fetch')), true); // browsers
    assert.equal(isTransportError(new Error('Unsupported FormDataPart implementation')), false);
    assert.equal(isTransportError(new Error('Unsupported BodyInit type')), false);
  });

  test('regression: a body fetch cannot encode is a client error, not "server unreachable", and is not retried', async () => {
    let calls = 0;
    globalThis.__fetchImpl = async () => {
      calls++;
      throw new Error('Unsupported FormDataPart implementation');
    };
    try {
      const err = await request({ method: 'PUT', path: '/x', form: () => new FormData(), timeoutMs: 1000 }).catch((e) => e);
      assert.equal(err.kind, 'rejected');
      assert.equal(err.code, 'client_error');
      assert.equal(calls, 1);
      assert.match(describeUploadError(err), /Unsupported FormDataPart/);
    } finally {
      globalThis.__fetchImpl = (...a) => globalThis.fetch(...a);
    }
  });

  test('a missing photo file fails before anything is sent', async () => {
    let calls = 0;
    globalThis.__fetchImpl = async () => {
      calls++;
    };
    try {
      const err = await request({
        method: 'PUT',
        path: '/x',
        form: () => {
          throw new UploadError('rejected', 'A photo file is missing', { code: 'file_missing' });
        },
        timeoutMs: 1000,
      }).catch((e) => e);
      assert.equal(err.code, 'file_missing');
      assert.equal(calls, 0);
    } finally {
      globalThis.__fetchImpl = (...a) => globalThis.fetch(...a);
    }
  });

  test('connection refused is "unreachable" (after retries), with the URL and cause', async () => {
    const err = await request({ method: 'GET', path: '/health', timeoutMs: 1000, retries: 1 }).catch((e) => e);
    assert.equal(err.kind, 'unreachable');
    assert.equal(err.details.url, 'http://127.0.0.1:9');
    assert.equal(typeof err.details.cause, 'string');
    assert.match(describeUploadError(err), /Can't reach the upload server at http:\/\/127\.0\.0\.1:9/);
  });
});
