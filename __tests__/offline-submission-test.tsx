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
import { storedPhotos } from "./support/fileSystem";
import { network } from "./support/network";
import { savedDraft } from "./support/storage";

const FULL_UPLOAD = [
  "POST /api/uploads",
  "PUT /api/uploads/u1/images/0",
  "PUT /api/uploads/u1/images/1",
  "POST /api/uploads/u1/complete",
];

const QUEUED = /It will upload automatically when you're back online/;

describe("offline submissions", () => {
  test("submitting while offline saves the submission locally instead of sending", async () => {
    network.start(false);
    await renderForm();
    await prepareSubmission(2);

    expect(screen.getByText("You're offline. Your work is saved on this device.")).toBeTruthy();
    expect(submitLabel()).toBe("Upload when online");

    await pressSubmit();
    await advance(1_000);

    expect(screen.getByText(QUEUED)).toBeTruthy();
    expect(requests).toEqual([]);
    expect(savedDraft()?.resume?.queued).toBe(true);
    expect(storedPhotos()).toHaveLength(2);
  });

  test("a queued submission uploads automatically when connectivity returns", async () => {
    network.start(false);
    await renderForm();
    await prepareSubmission(2);
    await pressSubmit();

    await setOnline(true);
    await settle();

    expect(requests).toEqual(FULL_UPLOAD);
    expect(alerts()).toContain("Uploaded: Caterpillar 320 was uploaded with 2 photos.");
    expect(screen.getByText("No photos yet")).toBeTruthy();
    expect(savedDraft()).toMatchObject({ brand: "", model: "", images: [], resume: null });
    expect(storedPhotos()).toEqual([]); // local copies cleaned up after success
  });

  test("a queued submission survives an app restart and uploads on next launch", async () => {
    network.start(false);
    const view = await renderForm();
    await prepareSubmission(2);
    await pressSubmit();

    // App is killed while still offline, then reopened with connectivity.
    network.start(true);
    await restartApp(view);
    await settle();

    expect(requests).toEqual(FULL_UPLOAD);
    expect(alerts()).toContain("Uploaded: Caterpillar 320 was uploaded with 2 photos.");
  });

  test("after a restart while still offline, the submission stays queued", async () => {
    network.start(false);
    const view = await renderForm();
    await prepareSubmission(2);
    await pressSubmit();

    await restartApp(view);

    expect(screen.getByText(QUEUED)).toBeTruthy();
    expect(screen.getByDisplayValue("Caterpillar")).toBeTruthy();
    expect(requests).toEqual([]);

    await setOnline(true);
    await settle();
    expect(requests).toEqual(FULL_UPLOAD);
  });

  test("'Don't upload automatically' cancels the queued submission", async () => {
    network.start(false);
    await renderForm();
    await prepareSubmission(1);
    await pressSubmit();

    await fireEvent.press(screen.getByText("Don't upload automatically"));
    await setOnline(true);
    await settle();

    expect(requests).toEqual([]);
    expect(submitLabel()).toBe("Upload");
  });

  test("losing connectivity mid-upload pauses, then continues where it left off", async () => {
    server.fail(/PUT .*\/images\/1$/, "offline");
    await renderForm();
    await prepareSubmission(2);
    await pressSubmit();

    expect(screen.getByText("You're offline. Waiting for connection…")).toBeTruthy();
    expect(server.received("u1")).toEqual([0]);

    await setOnline(true);
    await settle();

    expect(server.count(/images\/0$/)).toBe(1); // photo 1 was not re-sent
    expect(server.received("u1")).toEqual([0, 1]);
    expect(alerts()).toContain("Uploaded: Caterpillar 320 was uploaded with 2 photos.");
  });

  test("staying offline too long mid-upload queues the rest for when connectivity returns", async () => {
    server.fail(/PUT .*\/images\/1$/, "offline");
    await renderForm();
    await prepareSubmission(2);
    await pressSubmit();

    await advance(61_000); // the upload waits up to 60s for the connection

    expect(screen.getByText(QUEUED)).toBeTruthy();
    expect(server.received("u1")).toEqual([0]);

    await setOnline(true);
    await settle();

    expect(server.count(/images\/0$/)).toBe(1);
    expect(server.uploads.get("u1")?.status).toBe("complete");
  });
});
