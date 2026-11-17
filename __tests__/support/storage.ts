/** In-memory fake for `expo-sqlite/kv-store`. */
export const kv = new Map<string, string>();

export const kvStoreMock = {
  __esModule: true,
  default: {
    getItemSync: (key: string) => kv.get(key) ?? null,
    setItemSync: (key: string, value: string) => void kv.set(key, value),
    getItemAsync: async (key: string) => kv.get(key) ?? null,
    setItemAsync: async (key: string, value: string) => void kv.set(key, value),
    removeItemAsync: async (key: string) => kv.delete(key),
  },
};

export function savedDraft(): {
  brand: string;
  model: string;
  images: { id: string; name: string }[];
  resume: { uploadId?: string; queued: boolean; sentIds: string[] } | null;
} | null {
  const raw = kv.get("equipment-draft:v1");
  return raw ? JSON.parse(raw) : null;
}
