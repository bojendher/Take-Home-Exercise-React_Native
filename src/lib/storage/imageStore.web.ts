import type { ImagePickerAsset } from "expo-image-picker";

import { newId } from "@/lib/id";

import type { StoredImage } from "./types";

/**
 * Web: expo-file-system isn't available, so photos stay in memory (the
 * browser File + its object URL) and are not restored after a reload.
 */
export const PERSISTS_IMAGES = false;

export function uriFor(name: string): string {
  return name;
}

export function imageExists(): boolean {
  return true;
}

export async function importAsset(asset: ImagePickerAsset): Promise<StoredImage> {
  const id = newId();
  return {
    id,
    name: id,
    uri: asset.uri,
    sourceKey: asset.assetId ?? asset.uri,
    fileName: asset.fileName ?? null,
    mimeType: asset.mimeType ?? null,
    width: asset.width,
    height: asset.height,
    file: asset.file,
  };
}

export function deleteImage(image: StoredImage): void {
  if (image.uri.startsWith("blob:")) URL.revokeObjectURL(image.uri);
}

export function cleanupOrphans(): number {
  return 0;
}
