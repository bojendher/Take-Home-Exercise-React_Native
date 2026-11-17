import { fireEvent, screen } from "@testing-library/react-native";

import {
  advance,
  alerts,
  prepareSubmission,
  pressSubmit,
  renderForm,
  settle,
  submitLabel,
  press,
  setOnline,
} from "./support/app";
import { requests, server } from "./support/fakeServer";

const UPLOADED = "Uploaded: Caterpillar 320 was uploaded with 2 photos.";

describe("failures and retries", () => {
  test("a transient 503 on a photo is retried with backoff and succeeds", async () => {
    server.fail(/PUT .*\/images\/0$/, 503, 2);
    await renderForm();
    await prepareSubmission(2);
    await pressSubmit();

    expect(screen.getByText(/Problem sending photo 1\. Retrying in \ds \(attempt 2\)/)).toBeTruthy();

    await settle();
    expect(server.count(/images\/0$/)).toBe(3); // 2 failures + 1 success
    expect(alerts()).toContain(UPLOADED);
  });

  test("a request with no response is timed out after 30s and retried", async () => {
    server.fail(/PUT .*\/images\/0$/, "hang");
    await renderForm();
    await prepareSubmission(2);
    await pressSubmit();

    await advance(29_000);
    expect(server.received("u1")).toEqual([]);
    await advance(1_100); // timed out at 30s; the retry waits ≥250ms
    expect(screen.getByText(/Problem sending photo 1\. Retrying/)).toBeTruthy();

    await settle();
    expect(alerts()).toContain(UPLOADED);
  });

  test("a lost response (saved on the server, reply never arrived) is retried without duplicates", async () => {
    server.fail(/^POST \/api\/uploads$/, "lost");
    server.fail(/PUT .*\/images\/1$/, "lost");
    await renderForm();
    await prepareSubmission(2);
    await pressSubmit();
    await settle();

    expect(server.uploads.size).toBe(1); // idempotency key prevented a second session
    expect(server.count(/images\/1$/)).toBe(2); // re-sent, replaced on the server
    expect(server.uploads.get("u1")?.status).toBe("complete");
    expect(alerts()).toContain(UPLOADED);
  });

  test("when the server is down, the whole upload retries automatically with a countdown", async () => {
    server.down();
    await renderForm();
    await prepareSubmission(2);
    await pressSubmit();
    await advance(4_000); // per-request retries (0.5s → 2s) give up first

    expect(screen.getByText(/Can't reach the upload server/)).toBeTruthy();
    expect(screen.getByText(/Retrying automatically in \ds \(attempt 1 of 5\)/)).toBeTruthy();

    // Counts down.
    const before = screen.getByText(/Retrying automatically in/).props.children.join("");
    await advance(1_000);
    expect(screen.getByText(/Retrying automatically in/).props.children.join("")).not.toBe(before);

    server.up();
    await settle();
    expect(alerts()).toContain(UPLOADED);
  });

  test("'Retry now' skips the remaining backoff", async () => {
    server.down();
    await renderForm();
    await prepareSubmission(2);
    await pressSubmit();
    await advance(4_000);
    expect(screen.getByText("Retry now")).toBeTruthy();

    server.up();
    await press(screen.getByText("Retry now"));
    await advance(0);

    expect(alerts()).toContain(UPLOADED);
  });

  test("automatic retries follow the policy: 3 request retries × (1 + 5 upload retries), then stop", async () => {
    server.fail(/PUT .*\/images\/1$/, "network", Infinity);
    await renderForm();
    await prepareSubmission(2);
    await pressSubmit();
    await settle();

    expect(server.attempted(/images\/1$/)).toBe(4 * 6);
    expect(screen.getByText(/Can't reach the upload server at http:\/\/upload\.test/)).toBeTruthy();
    expect(screen.getByText(/1 of 2 photos are already on the server/)).toBeTruthy();
    expect(submitLabel()).toBe("Resume upload (1/2 sent)");
  });

  test("a rejected photo (4xx) fails immediately with the server's message, without retries", async () => {
    server.fail(/PUT .*\/images\/0$/, 415);
    await renderForm();
    await prepareSubmission(2);
    await pressSubmit();
    await settle();

    expect(server.attempted(/images\/0$/)).toBe(1);
    expect(screen.getByText("Simulated 415")).toBeTruthy();
    expect(screen.queryByText(/Retrying automatically/)).toBeNull();
    expect(submitLabel()).toBe("Upload"); // a rejected submission isn't resumable
  });

  test("a 5xx on 'complete' is retried and the upload still finishes", async () => {
    server.fail(/complete$/, 500, 2);
    await renderForm();
    await prepareSubmission(2);
    await pressSubmit();
    await settle();

    expect(server.count(/complete$/)).toBe(3);
    expect(alerts()).toContain(UPLOADED);
  });

  test("double-tapping Upload doesn't start a second upload", async () => {
    server.fail(/PUT .*\/images\/0$/, "hang");
    await renderForm();
    await prepareSubmission(2);
    await pressSubmit();
    await pressSubmit();
    await settle();

    expect(requests.filter((r) => r === "POST /api/uploads")).toHaveLength(1);
  });
});
