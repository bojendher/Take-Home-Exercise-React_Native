import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { createSimulator, validatePatch } from './simulate.mjs';

const MAX_JSON_BYTES = 16 * 1024;
const MAX_FIELD_LENGTH = 100;

/** Detects the real image type from magic bytes; never trust the client's mimeType. */
function sniffImageType(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { type: 'image/jpeg', ext: 'jpg' };
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { type: 'image/png', ext: 'png' };
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString('latin1'))) return { type: 'image/gif', ext: 'gif' };
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return { type: 'image/webp', ext: 'webp' };
  if (buf.length >= 12 && buf.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = buf.subarray(8, 12).toString('latin1');
    if (['heic', 'heix', 'hevc', 'heim', 'heis', 'mif1', 'msf1'].includes(brand)) return { type: 'image/heic', ext: 'heic' };
  }
  return null;
}

class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

async function readBody(req, limit) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    throw new HttpError(413, 'payload_too_large', `Body exceeds ${limit} bytes`, { limit });
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'payload_too_large', `Body exceeds ${limit} bytes`, { limit });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const ct = req.headers['content-type'] ?? '';
  if (!ct.startsWith('application/json')) {
    throw new HttpError(415, 'unsupported_media_type', 'Content-Type must be application/json');
  }
  const buf = await readBody(req, MAX_JSON_BYTES);
  try {
    return JSON.parse(buf.toString('utf8') || 'null');
  } catch {
    throw new HttpError(400, 'invalid_json', 'Body is not valid JSON');
  }
}

async function readMultipart(req, limit) {
  const ct = req.headers['content-type'] ?? '';
  if (!ct.startsWith('multipart/form-data')) {
    throw new HttpError(415, 'unsupported_media_type', 'Content-Type must be multipart/form-data');
  }
  const buf = await readBody(req, limit);
  try {
    // Node's built-in (undici) multipart parser.
    return await new Request('http://local/', { method: 'POST', headers: { 'content-type': ct }, body: buf }).formData();
  } catch {
    throw new HttpError(400, 'invalid_multipart', 'Body is not valid multipart/form-data');
  }
}

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, 'validation_failed', `${field} is required`, { field });
  }
  if (value.trim().length > MAX_FIELD_LENGTH) {
    throw new HttpError(400, 'validation_failed', `${field} must be at most ${MAX_FIELD_LENGTH} characters`, { field });
  }
  return value.trim();
}

function serializeUpload(u) {
  return {
    uploadId: u.id,
    brand: u.brand,
    model: u.model,
    totalImages: u.totalImages,
    received: [...u.images.keys()].sort((a, b) => a - b),
    status: u.status,
    createdAt: u.createdAt,
  };
}

/**
 * Builds the request handler. Route handlers return { status, body, headers }
 * instead of writing to `res`, so the simulator can discard a response after
 * the handler's side effects have happened ("lost" outcome).
 */
export function createApp({
  uploadDir,
  maxImageBytes = 15 * 1024 * 1024,
  maxImages = 50,
  simPreset = 'off',
  random,
  log = console.log,
} = {}) {
  const sim = createSimulator(simPreset, random);
  const uploads = new Map();
  const idempotency = new Map(); // Idempotency-Key -> { uploadId, fingerprint }

  function getUpload(id) {
    const u = uploads.get(id);
    if (!u) throw new HttpError(404, 'upload_not_found', `Upload ${id} not found (it may have expired or the server restarted)`);
    return u;
  }

  const routes = [
    ['GET', /^\/health$/, async () => ({ status: 200, body: { ok: true, time: new Date().toISOString() } })],

    ['POST', /^\/api\/uploads$/, async (req) => {
      const body = await readJson(req);
      if (!body || typeof body !== 'object') throw new HttpError(400, 'validation_failed', 'Body must be a JSON object');
      const brand = requireText(body.brand, 'brand');
      const model = requireText(body.model, 'model');
      const total = body.totalImages;
      if (!Number.isInteger(total) || total < 1 || total > maxImages) {
        throw new HttpError(400, 'validation_failed', `totalImages must be an integer from 1 to ${maxImages}`, { field: 'totalImages' });
      }

      // Idempotent create: a retried create (e.g. after a lost response) returns the same upload.
      const key = req.headers['idempotency-key'];
      const fingerprint = JSON.stringify([brand, model, total]);
      if (key) {
        const prior = idempotency.get(key);
        if (prior && uploads.has(prior.uploadId)) {
          if (prior.fingerprint !== fingerprint) {
            throw new HttpError(422, 'idempotency_mismatch', 'Idempotency-Key was already used with a different body');
          }
          return { status: 200, body: serializeUpload(uploads.get(prior.uploadId)) };
        }
      }

      const upload = {
        id: randomUUID(),
        brand,
        model,
        totalImages: total,
        images: new Map(),
        status: 'pending',
        createdAt: new Date().toISOString(),
      };
      uploads.set(upload.id, upload);
      if (key) idempotency.set(key, { uploadId: upload.id, fingerprint });
      return { status: 201, body: serializeUpload(upload) };
    }],

    ['GET', /^\/api\/uploads\/([^/]+)$/, async (_req, [id]) => ({ status: 200, body: serializeUpload(getUpload(id)) })],

    ['PUT', /^\/api\/uploads\/([^/]+)\/images\/([^/]+)$/, async (req, [id, rawIndex]) => {
      const upload = getUpload(id);
      if (upload.status === 'complete') throw new HttpError(409, 'upload_complete', 'Upload is already complete');
      const index = Number(rawIndex);
      if (!/^\d+$/.test(rawIndex) || index >= upload.totalImages) {
        throw new HttpError(400, 'invalid_index', `Image index must be an integer from 0 to ${upload.totalImages - 1}`);
      }

      const form = await readMultipart(req, maxImageBytes + 64 * 1024);
      const file = form.get('image');
      if (!(file instanceof File)) throw new HttpError(400, 'validation_failed', 'Multipart field "image" (a file) is required', { field: 'image' });
      if (file.size === 0) throw new HttpError(400, 'empty_file', 'Image file is empty');
      if (file.size > maxImageBytes) throw new HttpError(413, 'payload_too_large', `Image exceeds ${maxImageBytes} bytes`, { limit: maxImageBytes });

      const bytes = Buffer.from(await file.arrayBuffer());
      const detected = sniffImageType(bytes);
      if (!detected) {
        throw new HttpError(415, 'unsupported_image', 'File is not a supported image (JPEG, PNG, GIF, WebP, HEIC)', { declaredType: file.type || null });
      }

      // Write to a temp file then rename, so an aborted/retried request never leaves a partial file.
      const dir = path.join(uploadDir, upload.id);
      await mkdir(dir, { recursive: true });
      const finalPath = path.join(dir, `${index}.${detected.ext}`);
      const tmpPath = `${finalPath}.${randomUUID()}.tmp`;
      await writeFile(tmpPath, bytes);
      const previous = upload.images.get(index);
      await rename(tmpPath, finalPath);
      if (previous && previous.path !== finalPath) await rm(previous.path, { force: true });

      const replaced = !!previous;
      upload.images.set(index, {
        index,
        fileName: file.name || null,
        size: file.size,
        type: detected.type,
        path: finalPath,
      });
      return {
        status: replaced ? 200 : 201,
        body: { index, size: file.size, type: detected.type, replaced, received: serializeUpload(upload).received },
      };
    }],

    ['POST', /^\/api\/uploads\/([^/]+)\/complete$/, async (_req, [id]) => {
      const upload = getUpload(id);
      const missing = [];
      for (let i = 0; i < upload.totalImages; i++) if (!upload.images.has(i)) missing.push(i);
      if (missing.length) {
        throw new HttpError(409, 'missing_images', `Missing ${missing.length} image(s)`, { missing });
      }
      upload.status = 'complete'; // idempotent: completing twice returns the same result
      return { status: 200, body: serializeUpload(upload) };
    }],
  ];

  async function handleAdmin(req, res, url) {
    if (url.pathname === '/__sim' && req.method === 'GET') {
      return send(res, 200, { config: sim.config, queue: sim.queue });
    }
    if (url.pathname === '/__sim' && req.method === 'PUT') {
      const patch = await readJson(req);
      const problem = validatePatch(patch);
      if (problem) throw new HttpError(400, 'validation_failed', problem);
      sim.update(patch);
      log(`[sim] config ${JSON.stringify(sim.config)}`);
      return send(res, 200, { config: sim.config, queue: sim.queue });
    }
    if (url.pathname === '/__sim' && req.method === 'DELETE') {
      sim.reset();
      log('[sim] reset');
      return send(res, 200, { config: sim.config, queue: sim.queue });
    }
    if (url.pathname === '/__sim/next' && req.method === 'POST') {
      const body = await readJson(req);
      const problem = sim.enqueue(body?.outcomes);
      if (problem) throw new HttpError(400, 'validation_failed', problem);
      log(`[sim] queued ${JSON.stringify(sim.queue)}`);
      return send(res, 200, { config: sim.config, queue: sim.queue });
    }
    throw new HttpError(404, 'not_found', `No route for ${req.method} ${url.pathname}`);
  }

  function send(res, status, body, headers = {}) {
    if (res.headersSent || res.destroyed) return;
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
    res.end(JSON.stringify(body));
  }

  function errorResult(err) {
    if (err instanceof HttpError) {
      return { status: err.status, body: { error: { code: err.code, message: err.message, ...err.extra } } };
    }
    if (err?.code === 'ECONNRESET') {
      // Client disconnected mid-request (canceled/timed out). Nothing to send.
      return { status: 499, body: { error: { code: 'client_closed', message: 'Client closed the request' } } };
    }
    console.error(err);
    return { status: 500, body: { error: { code: 'internal_error', message: 'Unexpected server error' } } };
  }

  async function route(req, url) {
    const matching = routes.filter(([, pattern]) => pattern.test(url.pathname));
    if (!matching.length) throw new HttpError(404, 'not_found', `No route for ${req.method} ${url.pathname}`);
    const hit = matching.find(([method]) => method === req.method);
    if (!hit) {
      throw new HttpError(405, 'method_not_allowed', `${req.method} not allowed`, { allowed: matching.map(([m]) => m) });
    }
    const params = url.pathname.match(hit[1]).slice(1).map(decodeURIComponent);
    return hit[2](req, params);
  }

  return async function handler(req, res) {
    const started = Date.now();
    const url = new URL(req.url, 'http://localhost');
    let outcome = 'ok';
    res.on('close', () => {
      const status = res.headersSent ? res.statusCode : '---';
      log(`${req.method} ${url.pathname} -> ${status} [${outcome}] ${Date.now() - started}ms`);
    });

    // CORS for Expo web. Preflights and admin routes bypass the simulator.
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type,idempotency-key');
    res.setHeader('access-control-expose-headers', 'retry-after');
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    try {
      if (url.pathname.startsWith('/__sim')) return await handleAdmin(req, res, url);

      const latency = sim.latency();
      if (latency > 0) await delay(latency);

      outcome = sim.decide();
      if (outcome === 'drop') {
        req.socket.destroy();
        return;
      }
      if (outcome === 'timeout') {
        // Hold the connection open without responding; give up after hangMs.
        const timer = setTimeout(() => req.socket.destroy(), sim.config.hangMs);
        res.on('close', () => clearTimeout(timer));
        req.resume(); // drain the body so the client finishes sending
        return;
      }
      if (/^\d+$/.test(outcome) || outcome === 'error') {
        const status = sim.errorStatus(outcome);
        req.resume();
        return send(
          res,
          status,
          { error: { code: 'simulated_error', message: `Simulated ${status} response` } },
          status === 503 ? { 'retry-after': '1' } : {},
        );
      }

      let result;
      try {
        result = await route(req, url);
      } catch (err) {
        result = errorResult(err);
      }
      if (outcome === 'lost') {
        // Side effects already happened; the client never learns about them.
        req.socket.destroy();
        return;
      }
      send(res, result.status, result.body, result.headers);
    } catch (err) {
      const { status, body } = errorResult(err);
      send(res, status, body);
    }
  };
}
