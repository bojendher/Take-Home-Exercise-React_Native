import { fireEvent, screen } from "@testing-library/react-native";

import {
  addPhotos,
  advance,
  alerts,
  fillIn,
  photoCount,
  renderForm,
  restartApp,
  takePhoto,
} from "./support/app";
import { disk, Paths, storedPhotos } from "./support/fileSystem";
import { expoImagePickerMock, makeAsset } from "./support/picker";
import { savedDraft } from "./support/storage";

describe("local persistence", () => {
  test("brand, model and photos are restored after an app restart", async () => {
    const view = await renderForm();
    await addPhotos(2);
    await takePhoto();
    await fillIn("Komatsu", "PC210");

    await restartApp(view);

    expect(screen.getByDisplayValue("Komatsu")).toBeTruthy();
    expect(screen.getByDisplayValue("PC210")).toBeTruthy();
    expect(photoCount()).toBe(3);
  });

  test("photos are copied out of the picker cache into app storage", async () => {
    await renderForm();
    await addPhotos(2);

    expect(storedPhotos()).toHaveLength(2);
    expect(storedPhotos().every((uri) => uri.startsWith(Paths.document.uri))).toBe(true);
    // The picker's temporary copies were removed.
    expect([...disk.keys()].filter((k) => k.includes("/ImagePicker/"))).toEqual([]);
    // Only the file name is persisted (absolute paths change across app updates).
    expect(JSON.stringify(savedDraft())).not.toContain("file://");
  });

  test("typing is saved after a short pause", async () => {
    await renderForm();
    await fireEvent.changeText(screen.getByTestId("brand-input"), "Vol");
    await advance(100);
    expect(savedDraft()?.brand ?? "").toBe("");
    await advance(400);
    expect(savedDraft()?.brand).toBe("Vol");
  });

  test("removing a photo deletes its file; Clear all deletes the rest", async () => {
    await renderForm();
    await addPhotos(3);
    expect(storedPhotos()).toHaveLength(3);

    await fireEvent.press(screen.getByLabelText("Remove photo 2"));
    await advance();
    expect(storedPhotos()).toHaveLength(2);
    expect(savedDraft()?.images).toHaveLength(2);

    await fireEvent.press(screen.getByText("Clear all"));
    await advance();
    expect(storedPhotos()).toEqual([]);
    expect(photoCount()).toBe(0);
  });

  test("picking the same photo twice adds it once", async () => {
    await renderForm();
    const asset = makeAsset("dup");
    expoImagePickerMock.launchImageLibraryAsync
      .mockResolvedValueOnce({ canceled: false, assets: [asset] } as never)
      .mockResolvedValueOnce({ canceled: false, assets: [makeAsset("dup")] } as never);
    await fireEvent.press(screen.getByTestId("pick-library"));
    await advance();
    await fireEvent.press(screen.getByTestId("pick-library"));
    await advance();

    expect(photoCount()).toBe(1);
  });

  test("photos whose files disappeared are dropped on launch, with a notice", async () => {
    const view = await renderForm();
    await addPhotos(2);
    await advance(500);
    disk.delete(storedPhotos()[0]); // e.g. app storage partially cleared

    await restartApp(view);

    expect(photoCount()).toBe(1);
    expect(alerts()).toContainEqual(expect.stringContaining("Some photos are missing"));
  });

  test("files not referenced by the draft (e.g. after a crash) are cleaned up on launch", async () => {
    const view = await renderForm();
    await addPhotos(1);
    disk.set(`${Paths.document.uri}/equipment-images/orphan.jpg`, new Uint8Array([1]));

    await restartApp(view);

    expect(storedPhotos()).toHaveLength(1);
    expect(storedPhotos()[0]).not.toContain("orphan");
  });

  test("corrupted saved data doesn't crash the app", async () => {
    const { kv } = jest.requireActual<typeof import("./support/storage")>("./support/storage");
    kv.set("equipment-draft:v1", "{not json");
    await renderForm();
    expect(screen.getByText("No photos yet")).toBeTruthy();
  });
});
