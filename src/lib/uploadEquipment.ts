import type { ImagePickerAsset } from 'expo-image-picker';
import { Platform } from 'react-native';

export type EquipmentUpload = {
  images: ImagePickerAsset[];
  brand: string;
  model: string;
};

// Set EXPO_PUBLIC_UPLOAD_URL in a .env file to point at your backend.
const UPLOAD_URL = process.env.EXPO_PUBLIC_UPLOAD_URL;

export class UploadNotConfiguredError extends Error {
  constructor() {
    super('No upload endpoint configured. Set EXPO_PUBLIC_UPLOAD_URL in .env.');
  }
}

/**
 * Sends all images plus brand/model as one multipart/form-data request.
 * Each image is appended under the repeated field name `images`.
 */
export async function uploadEquipment({ images, brand, model }: EquipmentUpload): Promise<void> {
  if (!UPLOAD_URL) throw new UploadNotConfiguredError();

  const body = new FormData();
  images.forEach((image, i) => {
    const name = image.fileName ?? `equipment-${Date.now()}-${i}.jpg`;
    const type = image.mimeType ?? 'image/jpeg';
    if (Platform.OS === 'web' && image.file) {
      body.append('images', image.file, name);
    } else {
      // React Native's FormData accepts a { uri, name, type } descriptor for files.
      body.append('images', { uri: image.uri, name, type } as unknown as Blob);
    }
  });
  body.append('brand', brand);
  body.append('model', model);

  const res = await fetch(UPLOAD_URL, { method: 'POST', body });
  if (!res.ok) {
    throw new Error(`Upload failed (${res.status} ${res.statusText})`);
  }
}
