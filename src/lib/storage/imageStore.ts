import { Directory, File, Paths } from "expo-file-system";
import type { ImagePickerAsset } from "expo-image-picker";

import { newId } from "@/lib/id";

import type { StoredImage } from "./types";

/** Native: images are copied into documents/, which the OS never clears. */
export const PERSISTS_IMAGES = true;

const DIR_NAME = "equipment-images";

function imageDir(): Directory {
  const dir = new Directory(Paths.document, DIR_NAME);
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/webp": "webp",
  "image/gif": "gif",
};

function extensionFor(asset: ImagePickerAsset): string {
  const fromName = (asset.fileName ?? asset.uri).match(/\.([a-z0-9]{2,5})(?:\?|$)/i)?.[1];
  return (fromName ?? EXT_BY_MIME[asset.mimeType ?? ""] ?? "jpg").toLowerCase();
}

export function uriFor(name: string): string {
  return new File(imageDir(), name).uri;
}

export function imageExists(image: Pick<StoredImage, "name">): boolean {
  try {
    return new File(imageDir(), image.name).exists;
  } catch {
    return false;
  }
}

/**
 * Copies a picked/captured photo into app storage. The picker's copy lives in
 * the cache directory, which the OS may purge at any time (even mid-draft).
 */
export async function importAsset(asset: ImagePickerAsset): Promise<StoredImage> {
  const id = newId();
  const name = `${id}.${extensionFor(asset)}`;
  const source = new File(asset.uri);
  const dest = new File(imageDir(), name);
  await source.copy(dest);

  // The picker's temporary copy is no longer needed.
  if (asset.uri.startsWith(Paths.cache.uri)) {
    try {
      source.delete();
    } catch {
      // best effort
    }
  }

  return {
    id,
    name,
    uri: dest.uri,
    sourceKey: asset.assetId ?? asset.uri,
    fileName: asset.fileName ?? null,
    mimeType: asset.mimeType ?? null,
    width: asset.width,
    height: asset.height,
  };
}

export function deleteImage(image: StoredImage): void {
  try {
    const file = new File(imageDir(), image.name);
    if (file.exists) file.delete();
  } catch (e) {
    console.warn("Failed to delete image", image.name, e);
  }
}

/** Deletes files not referenced by the draft (e.g. left by a crash mid-import). */
export function cleanupOrphans(keep: ReadonlySet<string>): number {
  let removed = 0;
  try {
    for (const entry of imageDir().list()) {
      if (entry instanceof File && !keep.has(entry.name)) {
        entry.delete();
        removed++;
      }
    }
  } catch (e) {
    console.warn("Image cleanup failed", e);
  }
  return removed;
}
