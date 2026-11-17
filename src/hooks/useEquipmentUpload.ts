import { useCallback, useEffect, useRef, useState } from "react";

import { UploadError } from "@/lib/api/errors";
import type { RetryInfo } from "@/lib/api/http";
import { newId } from "@/lib/id";
import type { StoredImage, UploadResume } from "@/lib/storage/types";
import { createWaker, type Waker } from "@/lib/api/retry";
import { uploadWithAutoRetry, type UploadEvent, type UploadSession } from "@/lib/uploadEquipment";

export type ImageUploadStatus = "pending" | "uploading" | "done" | "failed";
export type UploadPhase = "idle" | "uploading" | "error" | "success";

type State = {
  phase: UploadPhase;
  /** Status per image index for the current attempt. */
  statuses: ImageUploadStatus[];
  /** The index currently uploading, if any. */
  current: number | null;
  retry: (RetryInfo & { index?: number }) | null;
  /** Waiting before an automatic retry of the whole upload. */
  autoRetry: Extract<UploadEvent, { type: "auto-retry" }> | null;
  error: unknown;
};

const IDLE: State = {
  phase: "idle",
  statuses: [],
  current: null,
  retry: null,
  autoRetry: null,
  error: null,
};

/** Identifies "the same submission", so changing photos or fields starts fresh. */
export function fingerprintOf(images: StoredImage[], brand: string, model: string) {
  return JSON.stringify([brand.trim(), model.trim(), images.map((i) => i.id)]);
}

/** Resume info for this submission: the persisted one if it matches, else new. */
function resumeFor(current: UploadResume | null, fingerprint: string): UploadResume {
  return current?.fingerprint === fingerprint
    ? current
    : { fingerprint, idempotencyKey: newId(), sentIds: [], queued: false };
}

type Options = {
  /** Persisted resume info (from the draft). */
  resume: UploadResume | null;
  onResumeChange: (resume: UploadResume | null) => void;
  /** Called after a successful upload, whether started manually, automatically or by a retry. */
  onSuccess: (session: UploadSession) => void;
};

export function useEquipmentUpload({ resume, onResumeChange, onSuccess }: Options) {
  const [state, setState] = useState<State>(IDLE);
  const abortRef = useRef<AbortController | null>(null);
  const resumeRef = useRef(resume);
  const onResumeChangeRef = useRef(onResumeChange);
  const onSuccessRef = useRef(onSuccess);
  const wakerRef = useRef<Waker | null>(null);
  useEffect(() => {
    resumeRef.current = resume;
    onResumeChangeRef.current = onResumeChange;
    onSuccessRef.current = onSuccess;
  }, [resume, onResumeChange, onSuccess]);

  // Cancel any in-flight upload on unmount.
  useEffect(() => () => abortRef.current?.abort(), []);

  /** Offline: remember the submission; it starts automatically when back online. */
  const queue = useCallback((images: StoredImage[], brand: string, model: string) => {
    const r = resumeFor(resumeRef.current, fingerprintOf(images, brand, model));
    onResumeChangeRef.current({ ...r, queued: true });
    setState(IDLE);
  }, []);

  const start = useCallback(
    async (images: StoredImage[], brand: string, model: string): Promise<UploadSession | null> => {
      if (abortRef.current) return null; // already uploading: ignore double taps

      let resume: UploadResume = { ...resumeFor(resumeRef.current, fingerprintOf(images, brand, model)), queued: false };
      const save = (next: UploadResume | null) => {
        if (next) resume = next;
        onResumeChangeRef.current(next);
      };
      save(resume);

      const ctrl = new AbortController();
      abortRef.current = ctrl;
      const waker = createWaker();
      wakerRef.current = waker;
      setState({ ...IDLE, phase: "uploading", statuses: images.map(() => "pending") });

      try {
        const session = await uploadWithAutoRetry({
          images,
          brand: brand.trim(),
          model: model.trim(),
          resumeUploadId: resume.uploadId,
          idempotencyKey: resume.idempotencyKey,
          signal: ctrl.signal,
          waker,
          onEvent: (event) => {
            if (event.type === "session") {
              // A new session means previously "sent" ids no longer apply.
              if (event.uploadId !== resume.uploadId) {
                save({ ...resume, uploadId: event.uploadId, sentIds: [] });
              }
              return;
            }
            if (event.type === "image" && event.status === "done") {
              const id = images[event.index].id;
              if (!resume.sentIds.includes(id)) save({ ...resume, sentIds: [...resume.sentIds, id] });
            }
            setState((s) => {
              if (event.type === "retry") return { ...s, retry: event };
              if (event.type === "auto-retry") {
                // Images that failed go back to "pending" while we wait.
                const statuses = s.statuses.map((st) => (st === "failed" ? "pending" : st));
                return { ...s, statuses, current: null, retry: null, autoRetry: event };
              }
              const statuses = [...s.statuses];
              statuses[event.index] = event.status;
              return {
                ...s,
                statuses,
                current: event.status === "uploading" ? event.index : s.current,
                retry: null,
                autoRetry: null,
              };
            });
          },
        });
        save(null);
        setState((s) => ({ ...s, phase: "success", current: null, retry: null, autoRetry: null }));
        onSuccessRef.current(session);
        return session;
      } catch (error) {
        if (error instanceof UploadError && error.kind === "rejected") {
          // The server refused this submission; don't resume a session it rejected.
          save(null);
        } else if (error instanceof UploadError && error.kind === "offline") {
          // Lost connectivity for too long: continue automatically when back online.
          save({ ...resume, queued: true });
        }
        setState((s) => ({ ...s, phase: "error", current: null, retry: null, autoRetry: null, error }));
        return null;
      } finally {
        abortRef.current = null;
        wakerRef.current = null;
      }
    },
    [],
  );

  const cancel = useCallback(() => abortRef.current?.abort(), []);

  /** Skip the remaining wait before an automatic retry. */
  const retryNow = useCallback(() => wakerRef.current?.wake(), []);

  /** Clears the on-screen status but keeps resume info (used when the form is edited). */
  const dismiss = useCallback(() => {
    if (!abortRef.current) setState(IDLE);
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setState(IDLE);
  }, []);

  return { ...state, start, queue, cancel, retryNow, dismiss, reset };
}
