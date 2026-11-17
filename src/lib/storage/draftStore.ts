import Storage from "expo-sqlite/kv-store";

import { DRAFT_KEY, parseDraft, serializeDraft } from "./draftCodec";
import { imageExists, uriFor } from "./imageStore";
import type { Draft, LoadedDraft } from "./types";

/**
 * Native: the draft lives in SQLite (expo-sqlite/kv-store).
 * Loading is synchronous so the form renders with saved data on first frame.
 */
export function loadDraft(): LoadedDraft {
  let raw: string | null = null;
  try {
    raw = Storage.getItemSync(DRAFT_KEY);
  } catch (e) {
    console.warn("Failed to read draft", e);
  }
  return parseDraft(raw, (image) =>
    imageExists(image) ? { ...image, uri: uriFor(image.name) } : null,
  );
}

// Serialize writes so an older snapshot can never land after a newer one.
let queue: Promise<void> = Promise.resolve();

export function saveDraft(draft: Draft): Promise<void> {
  const value = serializeDraft(draft, true);
  queue = queue
    .then(() => Storage.setItemAsync(DRAFT_KEY, value))
    .catch((e) => console.warn("Failed to save draft", e));
  return queue;
}
