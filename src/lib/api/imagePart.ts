import { File } from "expo-file-system";

import { UploadError } from "./errors";

type ImageRef = { uri: string; fileName?: string | null; mimeType?: string | null };

/**
 * Native: the multipart file part for an image.
 *
 * Expo SDK 58 replaces the global `fetch` with `expo/fetch`, which can't send
 * React Native's `{ uri, name, type }` FormData parts ("uri is not supported").
 * An expo-file-system `File` implements `Blob`, so `expo/fetch` reads its bytes.
 */
export function imagePart(image: ImageRef, fallbackName: string): { value: Blob; filename: string } {
  const file = new File(image.uri);
  if (!file.exists) {
    throw new UploadError("rejected", "A photo file is missing from this device. Remove it and add it again.", {
      code: "file_missing",
    });
  }
  return { value: file as unknown as Blob, filename: image.fileName ?? fallbackName };
}
