import type { ImagePickerAsset } from "expo-image-picker";
import { useCallback, useEffect, useRef, useState } from "react";

import { UploadError } from "@/lib/api/errors";
import type { RetryInfo } from "@/lib/api/http";
import { uploadEquipment, type UploadSession } from "@/lib/uploadEquipment";

export type ImageUploadStatus = "pending" | "uploading" | "done" | "failed";
export type UploadPhase = "idle" | "uploading" | "error" | "success";

type State = {
  phase: UploadPhase;
  /** Status per image index for the current attempt. */
  statuses: ImageUploadStatus[];
  /** The index currently uploading, if any. */
  current: number | null;
  retry: (RetryInfo & { index?: number }) | null;
  error: unknown;
};

const IDLE: State = { phase: "idle", statuses: [], current: null, retry: null, error: null };

type Resume = { fingerprint: string; uploadId?: string; idempotencyKey: string };

const newKey = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** Identifies "the same submission", so changing photos or fields starts fresh. */
function fingerprintOf(images: ImagePickerAsset[], brand: string, model: string) {
  return JSON.stringify([brand, model, images.map((i) => i.assetId ?? i.uri)]);
}

export function useEquipmentUpload() {
  const [state, setState] = useState<State>(IDLE);
  const abortRef = useRef<AbortController | null>(null);
  const resumeRef = useRef<Resume | null>(null);

  // Cancel any in-flight upload on unmount.
  useEffect(() => () => abortRef.current?.abort(), []);

  const start = useCallback(
    async (images: ImagePickerAsset[], brand: string, model: string): Promise<UploadSession | null> => {
      if (abortRef.current) return null; // already uploading: ignore double taps

      const fingerprint = fingerprintOf(images, brand, model);
      if (resumeRef.current?.fingerprint !== fingerprint) {
        resumeRef.current = { fingerprint, idempotencyKey: newKey() };
      }
      const resume = resumeRef.current;

      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setState({
        phase: "uploading",
        statuses: images.map(() => "pending"),
        current: null,
        retry: null,
        error: null,
      });

      try {
        const session = await uploadEquipment({
          images,
          brand,
          model,
          resumeUploadId: resume.uploadId,
          idempotencyKey: resume.idempotencyKey,
          signal: ctrl.signal,
          onEvent: (event) => {
            if (event.type === "session") {
              resume.uploadId = event.uploadId;
              return;
            }
            setState((s) => {
              if (event.type === "retry") return { ...s, retry: event };
              const statuses = [...s.statuses];
              statuses[event.index] = event.status;
              return {
                ...s,
                statuses,
                current: event.status === "uploading" ? event.index : s.current,
                retry: null,
              };
            });
          },
        });
        resumeRef.current = null;
        setState((s) => ({ ...s, phase: "success", current: null, retry: null }));
        return session;
      } catch (error) {
        if (error instanceof UploadError && error.kind === "rejected") {
          // The server refused this submission; don't resume a session it rejected.
          resumeRef.current = null;
        }
        setState((s) => ({ ...s, phase: "error", current: null, retry: null, error }));
        return null;
      } finally {
        abortRef.current = null;
      }
    },
    [],
  );

  const cancel = useCallback(() => abortRef.current?.abort(), []);

  /** Clears the on-screen status but keeps resume info (used when the form is edited). */
  const dismiss = useCallback(() => {
    if (!abortRef.current) setState(IDLE);
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    resumeRef.current = null;
    setState(IDLE);
  }, []);

  return { ...state, start, cancel, dismiss, reset };
}
