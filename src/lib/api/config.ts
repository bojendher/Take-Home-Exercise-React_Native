import Constants from "expo-constants";
import { Platform } from "react-native";

const DEV_SERVER_PORT = 4000;

/**
 * Resolves the upload server's base URL.
 * 1. EXPO_PUBLIC_API_URL, if set (required for production builds).
 * 2. In development, the same host Metro is served from, so a physical phone,
 *    simulator, emulator and web all reach the dev machine's server/ on :4000.
 */
export function getApiBaseUrl(): string | null {
  const explicit = process.env.EXPO_PUBLIC_API_URL;
  if (explicit) return explicit.replace(/\/+$/, "");

  if (!__DEV__) return null;

  if (Platform.OS === "web" && typeof window !== "undefined") {
    return `http://${window.location.hostname}:${DEV_SERVER_PORT}`;
  }
  // e.g. "192.168.1.20:8081" (LAN) or "10.0.2.2:8081" (Android emulator)
  const hostUri = Constants.expoConfig?.hostUri;
  const host = hostUri?.split(":")[0] ?? "localhost";
  return `http://${host}:${DEV_SERVER_PORT}`;
}
