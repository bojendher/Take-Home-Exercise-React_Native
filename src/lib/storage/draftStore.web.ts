import { DRAFT_KEY, parseDraft, serializeDraft } from "./draftCodec";
import type { Draft, LoadedDraft } from "./types";

/**
 * Web: localStorage (avoids expo-sqlite's wasm + COOP/COEP setup). Only brand
 * and model are persisted; photos can't be restored after a reload on web.
 */
export function loadDraft(): LoadedDraft {
  let raw: string | null = null;
  try {
    raw = globalThis.localStorage?.getItem(DRAFT_KEY) ?? null;
  } catch {
    // private mode / storage blocked
  }
  return parseDraft(raw, () => null);
}

export function saveDraft(draft: Draft): Promise<void> {
  try {
    globalThis.localStorage?.setItem(DRAFT_KEY, serializeDraft(draft, false));
  } catch {
    // quota exceeded or storage blocked: the draft still works in memory
  }
  return Promise.resolve();
}
