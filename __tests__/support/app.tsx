/**
 * Helpers to drive <EquipmentUploadForm> like a user, with a fake clock.
 *
 * Why actions are "started" rather than awaited: React's act() keeps its scope
 * open until async work started inside it (the whole upload, including retry
 * backoffs on the fake clock) has finished. Awaiting such a press would wait
 * forever, because time can't advance while we're stuck awaiting. So
 * long-running actions are started, and `advance()` moves the fake clock
 * forward in steps, letting React flush and promises run in between.
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react-native";
import { Alert } from "react-native";

import { EquipmentUploadForm } from "@/components/EquipmentUploadForm";

import { network } from "./network";
import { picker } from "./picker";

const realTimers = jest.requireActual("timers") as { setImmediate: (cb: (...args: unknown[]) => void) => unknown };
const STEP_MS = 250;

/** Long-running actions (presses, connectivity changes) still in flight. */
const inFlight = new Set<Promise<unknown>>();

function track(p: Promise<unknown>) {
  const tracked: Promise<unknown> = p.finally(() => inFlight.delete(tracked));
  inFlight.add(tracked);
  tracked.catch(() => {});
  return tracked;
}

/** Let promises and React's act() flush (which runs on real setImmediate). */
async function flushReal() {
  for (let i = 0; i < 4; i++) await new Promise((r) => realTimers.setImmediate(r));
}

/** Move the fake clock forward by `ms`, letting async work run along the way. */
export async function advance(ms = 0) {
  await flushReal();
  jest.advanceTimersByTime(0); // run anything due now (e.g. immediate saves)
  await flushReal();
  for (let elapsed = 0; elapsed < ms; ) {
    const step = Math.min(STEP_MS, ms - elapsed);
    jest.advanceTimersByTime(step);
    elapsed += step;
    await flushReal();
  }
}

/** Run until every started action has finished and no timers are pending. */
export async function settle(maxMs = 15 * 60_000) {
  for (let elapsed = 0; elapsed < maxMs; elapsed += STEP_MS) {
    await flushReal();
    if (inFlight.size === 0 && jest.getTimerCount() === 0) return;
    jest.advanceTimersByTime(STEP_MS);
  }
  throw new Error(`settle(): still busy after ${maxMs}ms of fake time`);
}

/** Press something that may start a long-running flow. */
export async function press(target: Parameters<typeof fireEvent.press>[0]) {
  track(fireEvent.press(target));
  await advance();
}

export async function setOnline(online: boolean) {
  track(network.set(online));
  await advance();
}

export async function renderForm() {
  const view = await render(<EquipmentUploadForm />);
  await advance();
  return view;
}

/** Simulates killing and reopening the app: unmount, then mount fresh from storage. */
export async function restartApp(view: { unmount: () => void | Promise<void> }) {
  await advance(1_000); // let debounced draft saves flush, as the AppState flush would
  await act(async () => {
    await view.unmount();
  });
  return renderForm();
}

export async function addPhotos(count: number) {
  picker.libraryReturns(count);
  await fireEvent.press(screen.getByTestId("pick-library"));
  await advance();
}

export async function takePhoto() {
  picker.cameraReturns();
  await fireEvent.press(screen.getByTestId("take-photo"));
  await advance();
}

export async function fillIn(brand = "Caterpillar", model = "320") {
  await fireEvent.changeText(screen.getByTestId("brand-input"), brand);
  await fireEvent.changeText(screen.getByTestId("model-input"), model);
  await advance(500);
}

export async function prepareSubmission(photos = 2) {
  await addPhotos(photos);
  await fillIn();
}

export async function pressSubmit() {
  await press(screen.getByTestId("submit-upload"));
}

/** The submit button's visible label (ignores the icon glyph). */
export function submitLabel(): string {
  const button = screen.getByTestId("submit-upload");
  return within(button)
    .queryAllByText(/[A-Za-z]/)
    .map((n) => [n.props.children].flat().join(""))
    .join(" ");
}

export function alerts(): string[] {
  return (Alert.alert as jest.Mock).mock.calls.map(([title, message]) => `${title}: ${message}`);
}

export function photoCount() {
  return screen.queryAllByLabelText(/^Photo \d+$/).length;
}

/** Called after each test: nothing may be left running. */
export async function assertIdle() {
  await settle();
}
