import { EMPTY_DRAFT, type Draft, type StoredImage, type UploadResume } from "./types";

/** Bump when the persisted shape changes incompatibly. */
export const DRAFT_KEY = "equipment-draft:v1";

type PersistedImage = Omit<StoredImage, "uri" | "file">;
type PersistedDraft = {
  brand: string;
  model: string;
  images: PersistedImage[];
  resume: UploadResume | null;
};

export function serializeDraft(draft: Draft, includeImages: boolean): string {
  const data: PersistedDraft = {
    brand: draft.brand,
    model: draft.model,
    // Web can't restore photos, so an upload resume would point at nothing.
    images: includeImages ? draft.images.map(({ uri: _uri, file: _file, ...rest }) => rest) : [],
    resume: includeImages ? draft.resume : null,
  };
  return JSON.stringify(data);
}

const isString = (v: unknown): v is string => typeof v === "string";

function parseImage(v: unknown): PersistedImage | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (!isString(o.id) || !isString(o.name) || !isString(o.sourceKey)) return null;
  return {
    id: o.id,
    name: o.name,
    sourceKey: o.sourceKey,
    fileName: isString(o.fileName) ? o.fileName : null,
    mimeType: isString(o.mimeType) ? o.mimeType : null,
    width: typeof o.width === "number" ? o.width : 0,
    height: typeof o.height === "number" ? o.height : 0,
  };
}

function parseResume(v: unknown): UploadResume | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (!isString(o.fingerprint) || !isString(o.idempotencyKey)) return null;
  return {
    fingerprint: o.fingerprint,
    idempotencyKey: o.idempotencyKey,
    uploadId: isString(o.uploadId) ? o.uploadId : undefined,
    sentIds: Array.isArray(o.sentIds) ? o.sentIds.filter(isString) : [],
    queued: o.queued === true,
  };
}

/**
 * Tolerant parse: corrupt or partial data degrades to an empty/partial draft
 * instead of crashing the app on launch.
 */
export function parseDraft(
  raw: string | null,
  resolve: (image: PersistedImage) => StoredImage | null,
): { draft: Draft; missingImages: number } {
  if (!raw) return { draft: EMPTY_DRAFT, missingImages: 0 };
  let data: Partial<PersistedDraft>;
  try {
    data = JSON.parse(raw);
  } catch {
    return { draft: EMPTY_DRAFT, missingImages: 0 };
  }
  if (!data || typeof data !== "object") return { draft: EMPTY_DRAFT, missingImages: 0 };

  const persisted = (Array.isArray(data.images) ? data.images : [])
    .map(parseImage)
    .filter((i): i is PersistedImage => i !== null);
  const images = persisted.map(resolve).filter((i): i is StoredImage => i !== null);

  return {
    draft: {
      brand: isString(data.brand) ? data.brand : "",
      model: isString(data.model) ? data.model : "",
      images,
      resume: parseResume(data.resume),
    },
    missingImages: persisted.length - images.length,
  };
}
