import { fireEvent, screen } from "@testing-library/react-native";

import {
  advance,
  alerts,
  prepareSubmission,
  pressSubmit,
  renderForm,
  restartApp,
  settle,
  submitLabel,
  press,
  setOnline,
} from "./support/app";
import { requests, server } from "./support/fakeServer";
import { savedDraft } from "./support/storage";

const UPLOADED = "Uploaded: Caterpillar 320 was uploaded with 2 photos.";

/** Upload photo 1, then fail photo 2 until all automatic retries are exhausted. */
async function failAfterFirstPhoto() {
  server.fail(/PUT .*\/images\/1$/, "network", Infinity);
  const view = await renderForm();
  await prepareSubmission(2);
  await pressSubmit();
  await settle();
  expect(submitLabel()).toBe("Resume upload (1/2 sent)");
  server.reset(); // clears faults and the request log, keeps nothing else
  return view;
}

describe("recovery", () => {
  test("Resume sends only the photos the server doesn't have", async () => {
    server.fail(/PUT .*\/images\/1$/, "network", Infinity);
    await renderForm();
    await prepareSubmission(2);
    await pressSubmit();
    await settle(); // all automatic retries exhausted
    expect(submitLabel()).toBe("Resume upload (1/2 sent)");

    server.clearFaults();
    requests.length = 0;
    await pressSubmit();
    await settle();

    expect(requests).toEqual([
      "GET /api/uploads/u1",
      "PUT /api/uploads/u1/images/1",
      "POST /api/uploads/u1/complete",
    ]);
    expect(alerts()).toContain(UPLOADED);
  });

  test("progress survives an app restart, and Resume continues the same server session", async () => {
    // Session state lives on the fake server; keep it across the simulated app restart.
    server.fail(/PUT .*\/images\/1$/, "network", 24);
    const view = await renderForm();
    await prepareSubmission(2);
    await pressSubmit();
    await settle();
    expect(savedDraft()?.resume).toMatchObject({ uploadId: "u1", queued: false });

    await restartApp(view);
    expect(submitLabel()).toBe("Resume upload (1/2 sent)");

    requests.length = 0;
    await pressSubmit();
    await settle();

    expect(requests).toEqual([
      "GET /api/uploads/u1",
      "PUT /api/uploads/u1/images/1",
      "POST /api/uploads/u1/complete",
    ]);
    expect(alerts()).toContain(UPLOADED);
  });

  test("if the server forgot the session (restart), a fresh session is created automatically", async () => {
    await failAfterFirstPhoto();
    // server.reset() above also forgot all sessions, like a server restart.

    await pressSubmit();
    await settle();

    expect(requests).toEqual([
      "GET /api/uploads/u1", // → 404
      "POST /api/uploads",
      "PUT /api/uploads/u1/images/0",
      "PUT /api/uploads/u1/images/1",
      "POST /api/uploads/u1/complete",
    ]);
    expect(alerts()).toContain(UPLOADED);
  });

  test("Cancel stops the upload; Try again reuses the same session", async () => {
    server.fail(/PUT .*\/images\/0$/, "hang");
    await renderForm();
    await prepareSubmission(2);
    await pressSubmit();

    await press(screen.getByText("Cancel"));
    await advance();
    expect(screen.getByText("Upload canceled.")).toBeTruthy();
    expect(submitLabel()).toBe("Try again");

    await pressSubmit();
    await settle();

    expect(server.uploads.size).toBe(1);
    expect(alerts()).toContain(UPLOADED);
  });

  test("editing the submission after a failure starts a new session", async () => {
    server.fail(/PUT .*\/images\/1$/, "network", 24);
    await renderForm();
    await prepareSubmission(2);
    await pressSubmit();
    await settle();

    await fireEvent.changeText(screen.getByTestId("model-input"), "320 GC");
    await advance(500);
    expect(submitLabel()).toBe("Upload");

    await pressSubmit();
    await settle();

    expect(server.uploads.size).toBe(2);
    expect(server.received("u2")).toEqual([0, 1]);
    expect(alerts()).toContain("Uploaded: Caterpillar 320 GC was uploaded with 2 photos.");
  });

  test("after a rejected photo, removing it and uploading again succeeds", async () => {
    server.fail(/PUT .*\/images\/1$/, 415);
    await renderForm();
    await prepareSubmission(2);
    await pressSubmit();
    await settle();
    expect(screen.getByText("Simulated 415")).toBeTruthy();

    await fireEvent.press(screen.getByLabelText("Remove photo 2"));
    await pressSubmit();
    await settle();

    expect(alerts()).toContain("Uploaded: Caterpillar 320 was uploaded with 1 photo.");
  });
});
