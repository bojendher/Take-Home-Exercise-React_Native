import { Platform } from "react-native";

import { UploadError } from "./api/errors";
import { request, type RetryInfo } from "./api/http";

export type UploadSession = {
  uploadId: string;
  brand: string;
  model: string;
  totalImages: number;
  received: number[];
  status: "pending" | "complete";
};

export type UploadEvent =
  | { type: "session"; uploadId: string }
  | { type: "image"; index: number; status: "uploading" | "done" | "failed" }
  | ({ type: "retry"; index?: number } & RetryInfo);

/** What the uploader needs from an image (StoredImage satisfies this). */
export type UploadImage = {
  uri: string;
  fileName?: string | null;
  mimeType?: string | null;
  /** Web: the browser File to send. */
  file?: Blob;
};

export type EquipmentUpload = {
  images: UploadImage[];
  brand: string;
  model: string;
  /** Resume this server-side upload, skipping images it already has. */
  resumeUploadId?: string;
  /** Stable per submission, so a retried "create" isn't duplicated. */
  idempotencyKey: string;
  signal?: AbortSignal;
  onEvent?: (event: UploadEvent) => void;
};

const CREATE_TIMEOUT_MS = 10_000;
const IMAGE_TIMEOUT_MS = 30_000;

function imageForm(image: UploadImage, index: number): FormData {
  const name = image.fileName ?? `equipment-${index}.jpg`;
  const type = image.mimeType ?? "image/jpeg";
  const form = new FormData();
  if (Platform.OS === "web" && image.file) {
    form.append("image", image.file, name);
  } else {
    // React Native's FormData accepts a { uri, name, type } descriptor for files.
    form.append("image", { uri: image.uri, name, type } as unknown as Blob);
  }
  return form;
}

const isSessionLost = (e: unknown) =>
  e instanceof UploadError && e.status === 404 && e.code === "upload_not_found";

/**
 * Uploads images one at a time:
 *   POST /api/uploads → PUT /api/uploads/:id/images/:i (sequential) → POST …/complete
 *
 * Every step retries transient failures. Image PUTs are idempotent per index,
 * so a retry after a lost response is safe. If the server forgets the upload
 * (restart), it starts a fresh session once.
 */
export async function uploadEquipment(opts: EquipmentUpload): Promise<UploadSession> {
  const { images, brand, model, signal, onEvent } = opts;
  let resumeId = opts.resumeUploadId;

  for (let restart = 0; ; restart++) {
    try {
      return await runSession(resumeId);
    } catch (e) {
      if (!isSessionLost(e) || restart >= 1) throw e;
      resumeId = undefined; // server lost our session: start over
    }
  }

  async function runSession(existingId?: string): Promise<UploadSession> {
    let session: UploadSession | null = null;

    if (existingId) {
      try {
        session = await request<UploadSession>({
          method: "GET",
          path: `/api/uploads/${existingId}`,
          timeoutMs: CREATE_TIMEOUT_MS,
          signal,
          onRetry: (r) => onEvent?.({ type: "retry", ...r }),
        });
      } catch (e) {
        if (!isSessionLost(e)) throw e;
      }
      if (session && session.totalImages !== images.length) session = null;
    }

    if (!session) {
      session = await request<UploadSession>({
        method: "POST",
        path: "/api/uploads",
        json: { brand, model, totalImages: images.length },
        // A new key per fresh session, so a lost session isn't resurrected.
        headers: { "idempotency-key": `${opts.idempotencyKey}:${existingId ?? "new"}` },
        timeoutMs: CREATE_TIMEOUT_MS,
        signal,
        onRetry: (r) => onEvent?.({ type: "retry", ...r }),
      });
    }

    const uploadId = session.uploadId;
    onEvent?.({ type: "session", uploadId });
    if (session.status === "complete") {
      images.forEach((_, index) => onEvent?.({ type: "image", index, status: "done" }));
      return session;
    }

    const received = new Set(session.received);
    const uploadIndexes = async (indexes: number[]) => {
      for (const index of indexes) {
        if (received.has(index)) {
          onEvent?.({ type: "image", index, status: "done" });
          continue;
        }
        onEvent?.({ type: "image", index, status: "uploading" });
        try {
          await request({
            method: "PUT",
            path: `/api/uploads/${uploadId}/images/${index}`,
            form: () => imageForm(images[index], index),
            timeoutMs: IMAGE_TIMEOUT_MS,
            signal,
            onRetry: (r) => onEvent?.({ type: "retry", index, ...r }),
          });
        } catch (e) {
          onEvent?.({ type: "image", index, status: "failed" });
          throw e;
        }
        received.add(index);
        onEvent?.({ type: "image", index, status: "done" });
      }
    };

    await uploadIndexes(images.map((_, i) => i));

    const complete = () =>
      request<UploadSession>({
        method: "POST",
        path: `/api/uploads/${uploadId}/complete`,
        timeoutMs: CREATE_TIMEOUT_MS,
        signal,
        onRetry: (r) => onEvent?.({ type: "retry", ...r }),
      });

    try {
      return await complete();
    } catch (e) {
      // Server is missing images it should have (e.g. lost on its side): re-send once.
      if (e instanceof UploadError && e.code === "missing_images") {
        const missing = (e.details?.missing as number[] | undefined) ?? [];
        missing.forEach((i) => received.delete(i));
        await uploadIndexes(missing);
        return await complete();
      }
      throw e;
    }
  }
}
