import { UploadError } from "./errors";

type ImageRef = { uri: string; fileName?: string | null; file?: Blob };

/** Web: the browser File captured by the picker (kept in memory). */
export function imagePart(image: ImageRef, fallbackName: string): { value: Blob; filename: string } {
  if (!image.file) {
    throw new UploadError("rejected", "This photo is no longer available. Remove it and add it again.", {
      code: "file_missing",
    });
  }
  return { value: image.file, filename: image.fileName ?? fallbackName };
}
