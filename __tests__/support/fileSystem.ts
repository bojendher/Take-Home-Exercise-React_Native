/** In-memory fake for the `expo-file-system` File/Directory/Paths API. */

export const disk = new Map<string, Uint8Array>();
const dirs = new Set<string>();

type Segment = string | FakeFile | FakeDirectory;

function join(parts: Segment[]): string {
  const raw = parts
    .map((p) => (typeof p === "string" ? p : p.uri))
    .join("/")
    .replace(/(?<!:)\/{2,}/g, "/");
  return raw.replace(/\/$/, "");
}

export class FakeDirectory {
  readonly uri: string;
  constructor(...parts: Segment[]) {
    this.uri = join(parts);
  }
  get exists() {
    return dirs.has(this.uri);
  }
  create() {
    dirs.add(this.uri);
  }
  list(): FakeFile[] {
    if (!this.exists) throw new Error(`Directory does not exist: ${this.uri}`);
    return [...disk.keys()]
      .filter((k) => k.slice(0, k.lastIndexOf("/")) === this.uri)
      .map((k) => new FakeFile(k));
  }
}

export class FakeFile {
  readonly uri: string;
  constructor(...parts: Segment[]) {
    this.uri = join(parts);
  }
  get exists() {
    return disk.has(this.uri);
  }
  get name() {
    return this.uri.slice(this.uri.lastIndexOf("/") + 1);
  }
  get size() {
    return disk.get(this.uri)?.length ?? 0;
  }
  get type() {
    return /\.png$/i.test(this.uri) ? "image/png" : "image/jpeg";
  }
  async copy(dest: FakeFile) {
    const data = disk.get(this.uri);
    if (!data) throw new Error(`No such file: ${this.uri}`);
    disk.set(dest.uri, data);
  }
  delete() {
    if (!disk.delete(this.uri)) throw new Error(`No such file: ${this.uri}`);
  }
  async bytes() {
    const data = disk.get(this.uri);
    if (!data) throw new Error(`No such file: ${this.uri}`);
    return data;
  }
}

export const Paths = {
  document: new FakeDirectory("file:///data/app/files"),
  cache: new FakeDirectory("file:///data/app/cache"),
};

export function resetDisk() {
  disk.clear();
  dirs.clear();
  dirs.add(Paths.document.uri);
  dirs.add(Paths.cache.uri);
}

/** Files the app keeps in its own storage (excludes picker cache). */
export function storedPhotos(): string[] {
  return [...disk.keys()].filter((k) => k.includes("/equipment-images/"));
}

export const expoFileSystemMock = { File: FakeFile, Directory: FakeDirectory, Paths };
