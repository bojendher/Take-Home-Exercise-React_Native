/** Fake `expo-image-picker`: returns photos written into the fake cache dir. */
import { disk, Paths } from "./fileSystem";

let counter = 0;
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2, 3]);

export function makeAsset(name = `photo-${++counter}`) {
  const uri = `${Paths.cache.uri}/ImagePicker/${name}.jpg`;
  disk.set(uri, JPEG);
  return {
    uri,
    assetId: `asset-${name}`,
    fileName: `${name}.jpg`,
    mimeType: "image/jpeg",
    width: 100,
    height: 100,
    type: "image" as const,
  };
}

export const expoImagePickerMock = {
  requestMediaLibraryPermissionsAsync: jest.fn(async () => ({ granted: true })),
  requestCameraPermissionsAsync: jest.fn(async () => ({ granted: true })),
  launchImageLibraryAsync: jest.fn(async () => ({ canceled: true, assets: null })),
  launchCameraAsync: jest.fn(async () => ({ canceled: true, assets: null })),
};

export const picker = {
  /** The next library pick returns these photos. */
  libraryReturns(count: number) {
    const assets = Array.from({ length: count }, () => makeAsset());
    expoImagePickerMock.launchImageLibraryAsync.mockResolvedValueOnce({ canceled: false, assets } as never);
    return assets;
  },
  cameraReturns() {
    const asset = makeAsset();
    expoImagePickerMock.launchCameraAsync.mockResolvedValueOnce({ canceled: false, assets: [asset] } as never);
    return asset;
  },
};
