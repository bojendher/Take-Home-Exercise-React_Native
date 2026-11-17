// Network-simulation layer. Decides, per request, whether to add latency and
// how the request should "go wrong" before or after the real handler runs.

export const PRESETS = {
  off: {
    latencyMs: 0,
    jitterMs: 0,
    errorRate: 0,
    errorStatuses: [500, 502, 503],
    timeoutRate: 0,
    dropRate: 0,
    lostResponseRate: 0,
    hangMs: 60_000,
    down: false,
  },
  // Slow mobile link: every request takes 1.5–3s.
  slow: { latencyMs: 1500, jitterMs: 1500 },
  // Unreliable server: ~35% of requests fail in some way.
  flaky: {
    latencyMs: 300,
    jitterMs: 700,
    errorRate: 0.15,
    timeoutRate: 0.05,
    dropRate: 0.08,
    lostResponseRate: 0.07,
  },
  // Server "down": every API call gets 503 (use down: "drop" to reset connections instead).
  down: { down: '503' },
};

/**
 * Forced outcomes (for deterministic testing via POST /__sim/next):
 *   "ok"      – handle normally
 *   "error"   – respond with a random status from errorStatuses
 *   "500"…    – respond with that exact status code
 *   "timeout" – never respond (socket held open for hangMs, then destroyed)
 *   "drop"    – destroy the socket before handling (client sees a network error)
 *   "lost"    – run the handler (side effects happen!) then destroy the socket
 *               instead of responding; exercises client retry idempotency
 */
export const OUTCOMES = ['ok', 'error', 'timeout', 'drop', 'lost'];

const NUMERIC_KEYS = ['latencyMs', 'jitterMs', 'errorRate', 'timeoutRate', 'dropRate', 'lostResponseRate', 'hangMs'];
const RATE_KEYS = ['errorRate', 'timeoutRate', 'dropRate', 'lostResponseRate'];

export function validatePatch(patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return 'Body must be a JSON object';
  }
  if ('preset' in patch && !(patch.preset in PRESETS)) {
    return `Unknown preset "${patch.preset}". Use one of: ${Object.keys(PRESETS).join(', ')}`;
  }
  for (const key of NUMERIC_KEYS) {
    if (key in patch && (typeof patch[key] !== 'number' || !Number.isFinite(patch[key]) || patch[key] < 0)) {
      return `${key} must be a non-negative number`;
    }
  }
  for (const key of RATE_KEYS) {
    if (key in patch && patch[key] > 1) return `${key} must be between 0 and 1`;
  }
  if ('down' in patch && ![false, '503', 'drop'].includes(patch.down)) {
    return 'down must be false, "503" or "drop"';
  }
  if (
    'errorStatuses' in patch &&
    (!Array.isArray(patch.errorStatuses) ||
      patch.errorStatuses.length === 0 ||
      !patch.errorStatuses.every((s) => Number.isInteger(s) && s >= 400 && s <= 599))
  ) {
    return 'errorStatuses must be a non-empty array of 4xx/5xx status codes';
  }
  const known = new Set(['preset', 'down', 'errorStatuses', ...NUMERIC_KEYS]);
  const unknown = Object.keys(patch).filter((k) => !known.has(k));
  if (unknown.length) return `Unknown field(s): ${unknown.join(', ')}`;
  return null;
}

function isValidOutcome(o) {
  return OUTCOMES.includes(o) || /^[45]\d\d$/.test(String(o));
}

export function createSimulator(presetName = 'off', random = Math.random) {
  let config = { ...PRESETS.off, ...PRESETS[presetName] };
  let queue = [];

  return {
    get config() {
      return { ...config };
    },
    get queue() {
      return [...queue];
    },
    /** Apply a validated patch. `preset` resets to that preset first. */
    update(patch) {
      const { preset, ...rest } = patch;
      if (preset) config = { ...PRESETS.off, ...PRESETS[preset] };
      config = { ...config, ...rest };
    },
    /** Queue forced outcomes; returns an error string if any is invalid. */
    enqueue(outcomes) {
      if (!Array.isArray(outcomes) || !outcomes.every(isValidOutcome)) {
        return `outcomes must be an array of: ${OUTCOMES.join(', ')} or an HTTP status code`;
      }
      queue.push(...outcomes.map(String));
      return null;
    },
    reset() {
      config = { ...PRESETS.off };
      queue = [];
    },
    latency() {
      return Math.round(config.latencyMs + random() * config.jitterMs);
    },
    /** Pick the outcome for one request. */
    decide() {
      if (config.down) return config.down === 'drop' ? 'drop' : '503';
      if (queue.length) return queue.shift();
      const r = random();
      let acc = 0;
      for (const [rate, outcome] of [
        [config.dropRate, 'drop'],
        [config.timeoutRate, 'timeout'],
        [config.errorRate, 'error'],
        [config.lostResponseRate, 'lost'],
      ]) {
        acc += rate;
        if (r < acc) return outcome;
      }
      return 'ok';
    },
    errorStatus(outcome) {
      if (/^\d+$/.test(outcome)) return Number(outcome);
      return config.errorStatuses[Math.floor(random() * config.errorStatuses.length)];
    },
  };
}
