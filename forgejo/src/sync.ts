/**
 * Two-way sync between a folder in the JupyterLite file browser and a branch of a
 * Forgejo repository.
 *
 * The files live in the browser storage like every other file, so notebooks and the
 * kernel see them as usual. For each file the clone remembers two hashes from the
 * last sync: the blob SHA on Forgejo and the git blob SHA of the local bytes. A
 * file is changed locally when its local hash moved, and changed on Forgejo when
 * the blob SHA in the branch moved. Comparing against the local hash rather than the
 * Forgejo one keeps a notebook that JupyterLite merely re-serialised from counting
 * as changed.
 */

import { PathExt } from '@jupyterlab/coreutils';
import { Contents } from '@jupyterlab/services';

import { ApiError, ForgejoApi, IFileChange, ITreeEntry } from './api';

const STORAGE_KEY = 'jupyterlite-forgejo:clones';

/** Directories that are never synced. */
const IGNORED_DIRS = new Set(['.git', '.ipynb_checkpoints']);

/** Files above this size are not downloaded; the browser storage is not made for them. */
const MAX_FILE_SIZE = 50 * 1024 * 1024;

const CONCURRENCY = 6;

export interface IFileState {
  /** Blob SHA on Forgejo at the last sync. */
  remote: string;
  /** Git blob SHA of the local bytes at the last sync. */
  local: string;
}

export interface IClone {
  /** Forgejo base URL */
  url: string;
  /** owner/name */
  repo: string;
  branch: string;
  /** Folder in the file browser, without leading or trailing slash. */
  folder: string;
  /** Path relative to the folder -> state at the last sync. */
  files: Record<string, IFileState>;
  /** Copies of the Forgejo version written next to a conflicting local file. */
  conflictCopies: string[];
}

export interface ILocalChange {
  path: string;
  operation: IFileChange['operation'];
}

export interface IPullResult {
  updated: string[];
  removed: string[];
  /** Local files kept, with the Forgejo version written next to them. */
  conflicts: { path: string; copy: string }[];
  /** Files deleted on Forgejo but changed here; they stay and come back on the next upload. */
  keptDeleted: string[];
  skipped: string[];
}

export type Progress = (message: string) => void;

export class ConflictError extends Error {
  constructor() {
    super(
      'Auf Forgejo wurde inzwischen eine der Dateien geändert, die du hochladen willst. ' +
        'Bitte zuerst „Aktualisieren“ und dann erneut hochladen.'
    );
    this.name = 'ConflictError';
  }
}

export class Sync {
  constructor(
    private _api: ForgejoApi,
    private _contents: Contents.IManager,
    private _url: () => string
  ) {}

  /** Clones of the configured Forgejo instance, by folder. */
  clones(): IClone[] {
    return Object.values(this._loadAll()).filter(clone => clone.url === this._url());
  }

  clone(folder: string): IClone | undefined {
    const clone = this._loadAll()[folder];
    return clone && clone.url === this._url() ? clone : undefined;
  }

  forget(folder: string): void {
    const all = this._loadAll();
    delete all[folder];
    this._saveAll(all);
  }

  /** Link `folder` to a repository and fetch it. */
  async create(
    repo: string,
    branch: string,
    folder: string,
    progress: Progress
  ): Promise<IPullResult> {
    folder = normalizeFolder(folder);
    if (this._loadAll()[folder]) {
      throw new Error(`Der Ordner „${folder}“ ist schon mit einem Repository verbunden.`);
    }
    const clone: IClone = {
      url: this._url(),
      repo,
      branch,
      folder,
      files: {},
      conflictCopies: []
    };
    await this._ensureDir(folder);
    this._store(clone);
    return this.pull(clone, progress);
  }

  /** Bring changes from Forgejo into the folder. Local changes are never overwritten. */
  async pull(clone: IClone, progress: Progress): Promise<IPullResult> {
    const result: IPullResult = {
      updated: [],
      removed: [],
      conflicts: [],
      keptDeleted: [],
      skipped: []
    };

    // folders may have been deleted since the last run
    this._dirs.clear();
    progress('Lese Stand auf Forgejo …');
    const head = await this._api.branchHead(clone.repo, clone.branch);
    const remote = head ? await this._api.files(clone.repo, head) : [];
    const remoteByPath = new Map(remote.map(entry => [entry.path, entry]));

    progress('Vergleiche mit den lokalen Dateien …');
    const local = await this._localHashes(clone);

    const toFetch: { entry: ITreeEntry; conflict: boolean }[] = [];
    for (const entry of remote) {
      const state = clone.files[entry.path];
      if (state && state.remote === entry.sha) {
        continue;
      }
      if (entry.size > MAX_FILE_SIZE) {
        result.skipped.push(entry.path);
        continue;
      }
      const localHash = local.get(entry.path);
      if (localHash === undefined) {
        // new on Forgejo, or deleted here: the version on Forgejo wins over a deletion
        toFetch.push({ entry, conflict: false });
      } else if (localHash === entry.sha) {
        clone.files[entry.path] = { remote: entry.sha, local: localHash };
      } else if (state && localHash === state.local) {
        toFetch.push({ entry, conflict: false });
      } else {
        toFetch.push({ entry, conflict: true });
      }
    }

    const ref = head ?? '';
    let done = 0;
    await pool(toFetch, async ({ entry, conflict }) => {
      const bytes = await this._api.fileBytes(clone.repo, entry.path, ref);
      if (conflict) {
        const copy = conflictCopyName(entry.path);
        await this._write(join(clone.folder, copy), bytes);
        // The local file stays as it is. Recording the new Forgejo SHA (with the
        // old local hash, or none) makes the next upload replace the Forgejo
        // version with the local one - after the user has merged by hand.
        clone.files[entry.path] = {
          remote: entry.sha,
          local: clone.files[entry.path]?.local ?? ''
        };
        if (!clone.conflictCopies.includes(copy)) {
          clone.conflictCopies.push(copy);
        }
        result.conflicts.push({ path: entry.path, copy });
      } else {
        const localHash = await this._write(join(clone.folder, entry.path), bytes);
        clone.files[entry.path] = { remote: entry.sha, local: localHash };
        result.updated.push(entry.path);
      }
      progress(`Lade Dateien … ${++done}/${toFetch.length}`);
    });

    for (const [path, state] of Object.entries(clone.files)) {
      if (remoteByPath.has(path)) {
        continue;
      }
      const localHash = local.get(path);
      if (localHash !== undefined && localHash !== state.local) {
        result.keptDeleted.push(path);
      } else if (localHash !== undefined) {
        await this._contents.delete(join(clone.folder, path));
        result.removed.push(path);
      }
      delete clone.files[path];
    }

    this._store(clone);
    return result;
  }

  /** What an upload would send right now. */
  async changes(clone: IClone): Promise<ILocalChange[]> {
    const local = await this._localHashes(clone);
    this._dropMissingConflictCopies(clone, local);
    return this._diff(clone, local).map(({ path, operation }) => ({ path, operation }));
  }

  /** Commit all local changes to the branch. Returns the number of files committed. */
  async push(clone: IClone, message: string, progress: Progress): Promise<number> {
    progress('Suche Änderungen …');
    const local = await this._localHashes(clone);
    this._dropMissingConflictCopies(clone, local);
    const diff = this._diff(clone, local);
    if (diff.length === 0) {
      return 0;
    }

    progress(`Lese ${diff.length} geänderte Datei(en) …`);
    const files: IFileChange[] = [];
    for (const change of diff) {
      const state = clone.files[change.path];
      if (change.operation === 'delete') {
        files.push({ operation: 'delete', path: change.path, sha: state.remote });
        continue;
      }
      const bytes = await this._read(join(clone.folder, change.path));
      files.push({
        operation: change.operation,
        path: change.path,
        content: toBase64(bytes),
        ...(state ? { sha: state.remote } : {})
      });
    }

    progress('Lade auf Forgejo hoch …');
    let commit: string;
    try {
      commit = await this._api.commit(clone.repo, clone.branch, message, files);
    } catch (error) {
      // a stale `sha`, or a file created here that meanwhile appeared on Forgejo
      if (error instanceof ApiError && [409, 422].includes(error.status)) {
        throw new ConflictError();
      }
      throw error;
    }

    // Only the committed files take the new state. Other changes on the branch,
    // made elsewhere, are left for the next pull.
    const tree = new Map(
      (await this._api.files(clone.repo, commit)).map(entry => [entry.path, entry.sha])
    );
    for (const change of diff) {
      const sha = tree.get(change.path);
      if (change.operation === 'delete' || sha === undefined) {
        delete clone.files[change.path];
      } else {
        clone.files[change.path] = { remote: sha, local: change.hash! };
      }
    }
    this._store(clone);
    return diff.length;
  }

  private _diff(clone: IClone, local: Map<string, string>): (ILocalChange & { hash?: string })[] {
    const changes: (ILocalChange & { hash?: string })[] = [];
    for (const [path, hash] of local) {
      if (clone.conflictCopies.includes(path)) {
        continue;
      }
      const state = clone.files[path];
      if (!state) {
        changes.push({ path, operation: 'create', hash });
      } else if (state.local !== hash) {
        changes.push({ path, operation: 'update', hash });
      }
    }
    for (const path of Object.keys(clone.files)) {
      if (!local.has(path)) {
        changes.push({ path, operation: 'delete' });
      }
    }
    return changes.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Forget conflict copies the user has deleted. */
  private _dropMissingConflictCopies(clone: IClone, local: Map<string, string>): void {
    const kept = clone.conflictCopies.filter(copy => local.has(copy));
    if (kept.length !== clone.conflictCopies.length) {
      clone.conflictCopies = kept;
      this._store(clone);
    }
  }

  /** Path relative to the clone folder -> git blob SHA of the local bytes. */
  private async _localHashes(clone: IClone): Promise<Map<string, string>> {
    const paths: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      let model: Contents.IModel;
      try {
        model = await this._contents.get(dir, { content: true });
      } catch {
        return;
      }
      for (const item of model.content as Contents.IModel[]) {
        if (item.type === 'directory') {
          if (!IGNORED_DIRS.has(item.name)) {
            await walk(item.path);
          }
        } else {
          paths.push(item.path);
        }
      }
    };
    await walk(clone.folder);

    const hashes = new Map<string, string>();
    const prefix = `${clone.folder}/`;
    await pool(paths, async path => {
      hashes.set(path.slice(prefix.length), await gitBlobSha(await this._read(path)));
    });
    return hashes;
  }

  /** The bytes a file would be uploaded as. */
  private async _read(path: string): Promise<Uint8Array> {
    const model = await this._contents.get(path, { content: true });
    switch (model.format) {
      case 'json':
        return new TextEncoder().encode(serializeNotebook(model.content));
      case 'text':
        return new TextEncoder().encode(model.content);
      case 'base64':
        return fromBase64(model.content);
      default:
        return new Uint8Array();
    }
  }

  /** Store bytes in the file browser and return the hash `_read` will see for them. */
  private async _write(path: string, bytes: Uint8Array): Promise<string> {
    // the drive refuses to save into a folder that does not exist yet
    await this._ensureDir(PathExt.dirname(path));
    if (PathExt.extname(path).toLowerCase() === '.ipynb') {
      try {
        const notebook = JSON.parse(new TextDecoder().decode(bytes));
        await this._contents.save(path, {
          type: 'notebook',
          format: 'json',
          content: notebook
        });
        return gitBlobSha(new TextEncoder().encode(serializeNotebook(notebook)));
      } catch (error) {
        if (!(error instanceof SyntaxError)) {
          throw error;
        }
        // not valid JSON: stored as it is below, JupyterLab will report it on opening
      }
    }
    const text = decodeText(bytes);
    if (text !== null) {
      await this._contents.save(path, { type: 'file', format: 'text', content: text });
    } else {
      await this._contents.save(path, {
        type: 'file',
        format: 'base64',
        content: toBase64(bytes)
      });
    }
    return gitBlobSha(bytes);
  }

  /** Create `dir` and its parents; concurrent calls for one folder share the work. */
  private _ensureDir(dir: string): Promise<void> {
    if (!dir) {
      return Promise.resolve();
    }
    let pending = this._dirs.get(dir);
    if (!pending) {
      pending = (async () => {
        await this._ensureDir(PathExt.dirname(dir));
        try {
          await this._contents.get(dir, { content: false });
        } catch {
          await this._contents.save(dir, { type: 'directory' });
        }
      })();
      // only remember successes; a failed attempt is retried next time
      pending.catch(() => this._dirs.delete(dir));
      this._dirs.set(dir, pending);
    }
    return pending;
  }

  private _store(clone: IClone): void {
    const all = this._loadAll();
    all[clone.folder] = clone;
    this._saveAll(all);
  }

  private _loadAll(): Record<string, IClone> {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    } catch {
      return {};
    }
  }

  private _saveAll(all: Record<string, IClone>): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  }
  private _dirs = new Map<string, Promise<void>>();
}

/**
 * A notebook the way nbformat writes it (sorted keys, one-space indent, trailing
 * newline), so that commits from here and from Jupyter elsewhere diff cleanly.
 */
export function serializeNotebook(notebook: unknown): string {
  return `${JSON.stringify(sortKeys(notebook), null, 1)}\n`;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/** The SHA git (and so Forgejo) gives a file with these bytes. */
export async function gitBlobSha(bytes: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const data = new Uint8Array(header.length + bytes.length);
  data.set(header);
  data.set(bytes, header.length);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', data));
  return Array.from(digest, b => b.toString(16).padStart(2, '0')).join('');
}

/** UTF-8 text, or null for binary content. */
function decodeText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) {
    return null;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function conflictCopyName(path: string): string {
  const ext = PathExt.extname(path);
  return `${path.slice(0, path.length - ext.length)} (Forgejo)${ext}`;
}

function normalizeFolder(folder: string): string {
  const normalized = folder.trim().replace(/^\/+|\/+$/g, '');
  if (!normalized) {
    throw new Error('Bitte gib einen Ordnernamen an.');
  }
  return normalized;
}

function join(folder: string, path: string): string {
  return `${folder}/${path}`;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(content: string): Uint8Array {
  return Uint8Array.from(atob(content.replace(/\s/g, '')), c => c.charCodeAt(0));
}

/** Run `task` over `items`, at most CONCURRENCY at a time. */
async function pool<T>(items: T[], task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      await task(items[next++]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
}
