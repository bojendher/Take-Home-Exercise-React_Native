import Constants from "expo-constants";
import { Platform } from "react-native";

const DEV_SERVER_PORT = 4000;

let logged = false;

/**
 * Resolves the upload server's base URL.
 * 1. EXPO_PUBLIC_API_URL, if set (required for production builds).
 * 2. In development, the same host Metro is served from, port 4000.
 *
 * Host by setup:
 *   Expo Go / LAN                → 192.168.x.x  (direct)
 *   `expo run:android` (USB/emu) → localhost    (needs `adb reverse tcp:4000 tcp:4000`;
 *                                                `npm run server` applies it automatically)
 *   iOS simulator                → localhost    (shares the Mac's network)
 *   web                          → page host
 */
export function getApiBaseUrl(): string | null {
  const url = resolveApiBaseUrl();
  if (__DEV__ && !logged) {
    logged = true;
    console.info(
      `[api] upload server: ${url ?? "(not configured)"} (hostUri: ${Constants.expoConfig?.hostUri ?? "n/a"})`,
    );
  }
  return url;
}

function resolveApiBaseUrl(): string | null {
  const explicit = process.env.EXPO_PUBLIC_API_URL;
  if (explicit) return explicit.replace(/\/+$/, "");

  if (!__DEV__) return null;

  if (Platform.OS === "web" && typeof window !== "undefined") {
    return `http://${window.location.hostname}:${DEV_SERVER_PORT}`;
  }
  // e.g. "192.168.1.20:8081" (LAN) or "localhost:8081" (adb reverse)
  const hostUri = Constants.expoConfig?.hostUri;
  const host = hostUri?.split(":")[0] ?? "localhost";
  return `http://${host}:${DEV_SERVER_PORT}`;
}
