/* Wires the native-boundary fakes in for every test. */
import { Alert } from "react-native";

import { server } from "./fakeServer";
import { resetDisk } from "./fileSystem";
import { network } from "./network";
import { kv } from "./storage";

process.env.EXPO_PUBLIC_API_URL = "http://upload.test";

// The app runs on React Native's FormData (Hermes), not Node's undici FormData.
globalThis.FormData = require("react-native/Libraries/Network/FormData").default;

// React Native's Jest preset runs animation frames as setTimeout(cb, 0). With
// fake timers, a running animation (e.g. a spinner) then schedules frames
// forever without the clock moving. Use a realistic ~60fps frame instead.
// (It's defined non-writable, so it must be redefined, not assigned.)
Object.defineProperty(globalThis, "requestAnimationFrame", {
  configurable: true,
  writable: true,
  value: (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 16),
});

jest.mock("expo-network", () => require("./network").expoNetworkMock);
jest.mock("expo-file-system", () => require("./fileSystem").expoFileSystemMock);
jest.mock("expo-sqlite/kv-store", () => require("./storage").kvStoreMock);
jest.mock("expo-image-picker", () => require("./picker").expoImagePickerMock);
jest.mock("expo/fetch", () => ({ fetch: (...args: unknown[]) => require("./fakeServer").fakeFetch(...args) }));

beforeEach(() => {
  // Fake only clock-based timers. React's act() drains its queue via
  // setImmediate; faking that (or microtasks) deadlocks act() when an async
  // flow updates state while waiting on a faked timer (e.g. a retry backoff).
  jest.useFakeTimers({ doNotFake: ["setImmediate", "clearImmediate", "queueMicrotask", "nextTick"] });
  network.reset();
  server.reset();
  resetDisk();
  kv.clear();
  jest.spyOn(Alert, "alert").mockImplementation(() => {});
  jest.spyOn(console, "info").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  // Nothing may be left running (uploads, retries, timers) after a test.
  await require("./app").settle();
  jest.useRealTimers();
  jest.restoreAllMocks();
});
