import type { ImagePickerAsset } from "expo-image-picker";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";

import { loadDraft, saveDraft } from "@/lib/storage/draftStore";
import {
  PERSISTS_IMAGES,
  cleanupOrphans,
  deleteImage,
  importAsset,
} from "@/lib/storage/imageStore";
import {
  EMPTY_DRAFT,
  type Draft,
  type StoredImage,
  type UploadResume,
} from "@/lib/storage/types";

/** Typing is saved after this pause; everything else is saved immediately. */
const TEXT_SAVE_DELAY_MS = 400;

export type AddResult = {
  added: number;
  duplicates: number;
  failed: number;
  overLimit: number;
};

/**
 * The form's state, persisted locally (offline-first): brand, model, photo
 * files and upload-resume info all survive app restarts and being offline.
 */
export function useEquipmentDraft({ maxImages }: { maxImages: number }) {
  const [loaded] = useState(loadDraft);
  const [draft, setDraft] = useState<Draft>(loaded.draft);
  const [importing, setImporting] = useState(0);

  // Latest draft for callbacks and the AppState flush (synced after render).
  const latest = useRef(draft);
  useEffect(() => {
    latest.current = draft;
  }, [draft]);
  const saveDelay = useRef(0);

  const update = useCallback((fn: (d: Draft) => Draft, delay = 0) => {
    saveDelay.current = delay;
    setDraft(fn);
  }, []);

  // Persist on every change.
  useEffect(() => {
    const t = setTimeout(() => saveDraft(draft), saveDelay.current);
    return () => clearTimeout(t);
  }, [draft]);

  // Flush pending (debounced) writes when the app is backgrounded/killed.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      if (s !== "active") saveDraft(latest.current);
    });
    return () => sub.remove();
  }, []);

  // Remove files left behind by e.g. a crash between copying and saving.
  useEffect(() => {
    cleanupOrphans(new Set(loaded.draft.images.map((i) => i.name)));
  }, [loaded]);

  const setBrand = useCallback(
    (brand: string) => update((d) => ({ ...d, brand }), TEXT_SAVE_DELAY_MS),
    [update],
  );
  const setModel = useCallback(
    (model: string) => update((d) => ({ ...d, model }), TEXT_SAVE_DELAY_MS),
    [update],
  );
  const setResume = useCallback(
    (resume: UploadResume | null) => update((d) => ({ ...d, resume })),
    [update],
  );

  /** Copies new photos into app storage, skipping duplicates and over-limit ones. */
  const addAssets = useCallback(
    async (assets: ImagePickerAsset[]): Promise<AddResult> => {
      const seen = new Set(latest.current.images.map((i) => i.sourceKey));
      const fresh = assets.filter((a) => {
        const key = a.assetId ?? a.uri;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const room = Math.max(
        0,
        maxImages - latest.current.images.length - importing,
      );
      const accepted = fresh.slice(0, room);
      const result: AddResult = {
        added: 0,
        duplicates: assets.length - fresh.length,
        failed: 0,
        overLimit: fresh.length - accepted.length,
      };

      setImporting((n) => n + accepted.length);
      for (const asset of accepted) {
        try {
          const image = await importAsset(asset);
          update((d) => ({ ...d, images: [...d.images, image] }));
          result.added++;
        } catch (e) {
          // e.g. disk full, or the source file vanished
          console.warn("Failed to save photo", e);
          result.failed++;
        } finally {
          setImporting((n) => n - 1);
        }
      }
      return result;
    },
    [importing, maxImages, update],
  );

  const removeImage = useCallback(
    (id: string) => {
      const image = latest.current.images.find((i) => i.id === id);
      if (!image) return;
      update((d) => ({ ...d, images: d.images.filter((i) => i.id !== id) }));
      deleteImage(image);
    },
    [update],
  );

  const removeImages = useCallback(
    (images: StoredImage[]) => {
      const ids = new Set(images.map((i) => i.id));
      update((d) => ({ ...d, images: d.images.filter((i) => !ids.has(i.id)) }));
      images.forEach(deleteImage);
    },
    [update],
  );

  const clearImages = useCallback(
    () => removeImages(latest.current.images),
    [removeImages],
  );

  /** After a successful upload: delete the local files and start fresh. */
  const clearAll = useCallback(() => {
    const images = latest.current.images;
    update(() => EMPTY_DRAFT);
    images.forEach(deleteImage);
  }, [update]);

  return {
    ...draft,
    importing: importing > 0,
    missingOnLoad: loaded.missingImages,
    persistsImages: PERSISTS_IMAGES,
    setBrand,
    setModel,
    setResume,
    addAssets,
    removeImage,
    clearImages,
    clearAll,
  };
}
