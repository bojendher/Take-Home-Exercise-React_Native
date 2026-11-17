const listeners = new Set();
globalThis.__network = {
  isConnected: true,
  set(online) {
    this.isConnected = online;
    for (const l of listeners) l({ isConnected: online });
  },
};
export async function getNetworkStateAsync() {
  return { isConnected: globalThis.__network.isConnected };
}
export function addNetworkStateListener(fn) {
  listeners.add(fn);
  return { remove: () => listeners.delete(fn) };
}
export function useNetworkState() {
  return { isConnected: globalThis.__network.isConnected };
}
