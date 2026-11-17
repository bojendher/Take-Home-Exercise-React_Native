/** Controllable fake for `expo-network`. */
import { act } from "@testing-library/react-native";
import { useEffect, useState } from "react";

type NetworkState = { isConnected: boolean; isInternetReachable: boolean };
type Listener = (state: NetworkState) => void;

let state: NetworkState = { isConnected: true, isInternetReachable: true };
const listeners = new Set<Listener>();

export const network = {
  get online() {
    return state.isConnected;
  },
  /** Flip connectivity and notify listeners (inside act, for React updates). */
  async set(online: boolean) {
    state = { isConnected: online, isInternetReachable: online };
    await act(async () => {
      [...listeners].forEach((l) => l(state));
    });
  },
  /** Set initial state before rendering, without notifying. */
  start(online: boolean) {
    state = { isConnected: online, isInternetReachable: online };
  },
  reset() {
    state = { isConnected: true, isInternetReachable: true };
    listeners.clear();
  },
};

/** Go offline from inside an in-flight request (already within act). */
export function setOfflineSilently() {
  state = { isConnected: false, isInternetReachable: false };
  [...listeners].forEach((l) => l(state));
}

export const expoNetworkMock = {
  getNetworkStateAsync: async () => ({ ...state }),
  addNetworkStateListener: (fn: Listener) => {
    listeners.add(fn);
    return { remove: () => listeners.delete(fn) };
  },
  useNetworkState: () => {
    const [s, setS] = useState(state);
    useEffect(() => {
      const l: Listener = (next) => setS({ ...next });
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    }, []);
    return s;
  },
};
