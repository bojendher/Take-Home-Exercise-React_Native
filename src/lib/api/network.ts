import * as Network from "expo-network";

import { UploadError } from "./errors";

/**
 * Note: only `isConnected` is used. `isInternetReachable` can be false on a LAN
 * without internet access, which is exactly where the local dev server lives.
 */
export async function isOffline(): Promise<boolean> {
  try {
    const state = await Network.getNetworkStateAsync();
    return state.isConnected === false;
  } catch {
    return false; // unknown: let the request decide
  }
}

/**
 * Resolves as soon as the device is connected. Rejects with an "offline"
 * UploadError if it stays offline for `timeoutMs`, or "canceled" on abort.
 */
export async function waitForOnline(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<void> {
  if (!(await isOffline())) return;

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      sub.remove();
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(new UploadError("canceled", "Upload canceled"));
    };
    const sub = Network.addNetworkStateListener((state) => {
      if (state.isConnected !== false) {
        cleanup();
        resolve();
      }
    });
    const timer = setTimeout(() => {
      cleanup();
      reject(new UploadError("offline", "Device is offline"));
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort);
  });
}
