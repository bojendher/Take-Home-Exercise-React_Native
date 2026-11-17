/** A photo owned by the app (copied out of the picker's temporary cache). */
export type StoredImage = {
  /** Stable id; also used in the upload fingerprint. */
  id: string;
  /**
   * File name inside the app's image directory (native). Only the name is
   * persisted: the absolute path of the iOS app container changes across
   * app updates, so `uri` is rebuilt on load.
   */
  name: string;
  /** Runtime URI for display and upload. Not persisted. */
  uri: string;
  /** assetId (library) or original URI (camera), for de-duplicating picks. */
  sourceKey: string;
  fileName: string | null;
  mimeType: string | null;
  width: number;
  height: number;
  /** Web only, in memory: the browser File for upload. */
  file?: Blob;
};

/** Server-side upload progress, persisted so it survives app restarts. */
export type UploadResume = {
  /** Which draft (photos + fields) this applies to. */
  fingerprint: string;
  idempotencyKey: string;
  uploadId?: string;
  /** Ids of images the server has confirmed (for display before resuming). */
  sentIds: string[];
  /** Waiting for connectivity: start automatically when back online. */
  queued: boolean;
};

export type Draft = {
  brand: string;
  model: string;
  images: StoredImage[];
  resume: UploadResume | null;
};

export const EMPTY_DRAFT: Draft = { brand: "", model: "", images: [], resume: null };

export type LoadedDraft = {
  draft: Draft;
  /** Images whose files disappeared (e.g. storage cleared) and were dropped. */
  missingImages: number;
};
