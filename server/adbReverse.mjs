// `expo run:android` serves Metro to the device through `adb reverse`, so the
// app sees its dev host as "localhost" and calls http://localhost:4000, which
// on the device is the device itself. Forwarding the API port the same way
// makes that address reach this server, on USB devices and emulators alike.
// The rule is lost when a device is replugged or adb restarts, so it's re-applied
// whenever a new device appears.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const POLL_MS = 5_000;

function findAdb() {
  const candidates = [
    process.env.ANDROID_HOME && path.join(process.env.ANDROID_HOME, 'platform-tools', 'adb'),
    process.env.ANDROID_SDK_ROOT && path.join(process.env.ANDROID_SDK_ROOT, 'platform-tools', 'adb'),
    path.join(homedir(), 'Library', 'Android', 'sdk', 'platform-tools', 'adb'), // macOS default
    path.join(homedir(), 'Android', 'Sdk', 'platform-tools', 'adb'), // Linux default
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) ?? 'adb'; // fall back to PATH
}

async function listDevices(adb) {
  const { stdout } = await run(adb, ['devices'], { timeout: 5_000 });
  return stdout
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter(([id, state]) => id && state === 'device')
    .map(([id]) => id);
}

/** Keeps `adb reverse tcp:PORT tcp:PORT` applied to every connected device. Returns a stop function. */
export function keepAdbReverse(port, log = console.log) {
  if (process.env.ADB_REVERSE === '0') return () => {};
  const adb = findAdb();
  const applied = new Set();
  let warned = false;

  async function sync() {
    let devices;
    try {
      devices = await listDevices(adb);
    } catch {
      if (!warned) {
        warned = true;
        log('  adb not found: Android devices must reach this server via the LAN address above');
      }
      return;
    }
    for (const id of devices) {
      if (applied.has(id)) continue;
      try {
        await run(adb, ['-s', id, 'reverse', `tcp:${port}`, `tcp:${port}`], { timeout: 5_000 });
        applied.add(id);
        log(`  adb reverse tcp:${port} → ${id} (device can use http://localhost:${port})`);
      } catch (e) {
        log(`  adb reverse failed for ${id}: ${e.message.split('\n')[0]}`);
      }
    }
    // Forget unplugged devices so the rule is re-applied when they come back.
    for (const id of applied) if (!devices.includes(id)) applied.delete(id);
  }

  sync();
  const timer = setInterval(sync, POLL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
