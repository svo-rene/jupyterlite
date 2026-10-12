/**
 * The handful of Forgejo API v1 calls the sync needs.
 */

import { Auth, fetchOrExplain, LoginRequiredError } from './auth';

export interface IUser {
  id: number;
  login: string;
  full_name: string;
}

export interface IRepo {
  id: number;
  full_name: string;
  name: string;
  owner: { login: string };
  default_branch: string;
  empty: boolean;
  permissions?: { push: boolean };
}

export interface ITreeEntry {
  path: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  size: number;
}

export interface IFileChange {
  operation: 'create' | 'update' | 'delete';
  path: string;
  /** base64, for create and update */
  content?: string;
  /** blob SHA the change is based on, for update and delete */
  sha?: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class ForgejoApi {
  constructor(private _auth: Auth) {}

  async user(): Promise<IUser> {
    return this._json('user');
  }

  /** Repositories the user owns or is a member/collaborator of, filtered by `query`. */
  async searchRepos(userId: number, query: string): Promise<IRepo[]> {
    const params = new URLSearchParams({
      q: query,
      uid: String(userId),
      limit: '50',
      sort: 'updated',
      order: 'desc'
    });
    const result = await this._json<{ data: IRepo[] }>(`repos/search?${params}`);
    return result.data ?? [];
  }

  async repo(fullName: string): Promise<IRepo> {
    return this._json(`repos/${repoPath(fullName)}`);
  }

  /** Commit SHA at the tip of `branch`, or null when the branch does not exist yet. */
  async branchHead(fullName: string, branch: string): Promise<string | null> {
    try {
      const result = await this._json<{ commit: { id: string } }>(
        `repos/${repoPath(fullName)}/branches/${encodeURIComponent(branch)}`
      );
      return result.commit.id;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /** Every file (blob) in the tree of `commit`, across all result pages. */
  async files(fullName: string, commit: string): Promise<ITreeEntry[]> {
    const entries: ITreeEntry[] = [];
    for (let page = 1; ; page++) {
      const result = await this._json<{
        tree: ITreeEntry[] | null;
        truncated: boolean;
        total_count: number;
      }>(
        `repos/${repoPath(fullName)}/git/trees/${commit}?recursive=true&per_page=1000&page=${page}`
      );
      const tree = result.tree ?? [];
      entries.push(...tree);
      if (!result.truncated || tree.length === 0) {
        break;
      }
    }
    return entries.filter(entry => entry.type === 'blob');
  }

  /** Raw bytes of a file; `media` resolves Git LFS pointers to the real content. */
  async fileBytes(fullName: string, path: string, ref: string): Promise<Uint8Array> {
    const response = await this._fetch(
      `repos/${repoPath(fullName)}/media/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`
    );
    return new Uint8Array(await response.arrayBuffer());
  }

  /** Apply several file changes as one commit; returns the new commit SHA. */
  async commit(
    fullName: string,
    branch: string,
    message: string,
    files: IFileChange[]
  ): Promise<string> {
    const result = await this._json<{ commit: { sha: string } }>(
      `repos/${repoPath(fullName)}/contents`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch, message, files })
      }
    );
    return result.commit.sha;
  }

  private async _json<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this._fetch(path, init);
    return response.json();
  }

  private async _fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const token = await this._auth.getToken();
    const base = this._auth.config.url.replace(/\/+$/, '');
    const response = await fetchOrExplain(base, `${base}/api/v1/${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` }
    });
    if (response.status === 401) {
      // revoked or otherwise rejected: drop it so the panel offers a new login
      this._auth.logout();
      throw new LoginRequiredError();
    }
    if (!response.ok) {
      let detail = '';
      try {
        detail = (await response.json()).message ?? '';
      } catch {
        // not JSON, the status code has to do
      }
      throw new ApiError(
        `Forgejo antwortet ${response.status}${detail ? `: ${detail}` : ''}`,
        response.status
      );
    }
    return response;
  }
}

function repoPath(fullName: string): string {
  return fullName.split('/').map(encodeURIComponent).join('/');
}
