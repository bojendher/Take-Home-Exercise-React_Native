// Tests can swap the implementation (globalThis.__fetchImpl) to simulate failures.
globalThis.__fetchImpl = (...args) => globalThis.fetch(...args);
export const fetch = (...args) => globalThis.__fetchImpl(...args);
