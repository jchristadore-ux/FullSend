/**
 * GitHub REST client.
 *
 * Deliberately small: FullSend only needs to read a repository's shape and a
 * handful of files. Every call is authenticated when a token is available, and
 * rate-limit responses surface as an actionable error rather than a 403.
 */
import 'server-only';
import { env } from '../env';
import { FullSendError } from '../errors';
import { logger } from '../logger';

const log = logger('github');

export interface RepoRef {
  owner: string;
  name: string;
}

export interface RepoMeta {
  owner: string;
  name: string;
  full_name: string;
  html_url: string;
  description: string | null;
  default_branch: string;
  language: string | null;
  topics: string[];
  stargazers_count: number;
  private: boolean;
  size: number;
  pushed_at: string | null;
  homepage: string | null;
  license: string | null;
}

export interface TreeEntry {
  path: string;
  type: 'blob' | 'tree';
  size: number;
}

/** Parses the many shapes a founder might paste into the onboarding box. */
export function parseRepoInput(input: string): RepoRef {
  const raw = input.trim();
  if (!raw) {
    throw new FullSendError('bad_repo', 'Paste a GitHub repository to get started', {
      status: 400,
      remedy: 'Example: https://github.com/vercel/next.js or vercel/next.js',
    });
  }

  const cleaned = raw
    .replace(/^git\+/, '')
    .replace(/\.git$/, '')
    .replace(/^git@github\.com:/, 'https://github.com/');

  let path = cleaned;
  if (/^https?:\/\//i.test(cleaned)) {
    try {
      const url = new URL(cleaned);
      if (!/(^|\.)github\.com$/i.test(url.hostname)) {
        throw new FullSendError('bad_repo', 'Only GitHub repositories are supported today', {
          status: 400,
          remedy: 'Paste a github.com URL, or use the owner/repo shorthand.',
        });
      }
      path = url.pathname;
    } catch (e) {
      if (e instanceof FullSendError) throw e;
      throw new FullSendError('bad_repo', 'That does not look like a valid URL', { status: 400 });
    }
  }

  const parts = path.split('/').filter(Boolean);
  const [owner, name] = parts;
  if (!owner || !name || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(name)) {
    throw new FullSendError('bad_repo', `Could not read a repository from "${raw}"`, {
      status: 400,
      remedy: 'Use the form owner/repo, for example vercel/next.js',
    });
  }
  return { owner, name };
}

export class GitHubClient {
  /** A user's OAuth token when present, otherwise the server PAT. */
  constructor(private token?: string) {}

  private headers(): Record<string, string> {
    const token = this.token ?? env.github.token;
    return {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'FullSend',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = path.startsWith('http') ? path : `${env.github.apiBase}${path}`;
    const res = await fetch(url, {
      ...init,
      headers: { ...this.headers(), ...(init.headers as Record<string, string>) },
      // Repo metadata is stable for minutes at a time.
      next: { revalidate: 300 },
    } as RequestInit & { next: { revalidate: number } });

    if (res.status === 404) {
      throw new FullSendError('repo_not_found', 'That repository could not be found', {
        status: 404,
        remedy:
          'Check the spelling. If the repo is private, connect your GitHub account so FullSend ' +
          'can read it.',
      });
    }
    if (res.status === 401 || res.status === 403) {
      const remaining = res.headers.get('x-ratelimit-remaining');
      if (remaining === '0') {
        const reset = Number(res.headers.get('x-ratelimit-reset') ?? 0) * 1000;
        const mins = Math.max(1, Math.ceil((reset - Date.now()) / 60000));
        throw new FullSendError('github_rate_limited', 'GitHub rate limit reached', {
          status: 429,
          retryable: true,
          remedy: `Connect your GitHub account to raise the limit, or retry in ${mins} minutes.`,
        });
      }
      throw new FullSendError('github_forbidden', 'GitHub denied access to that repository', {
        status: 403,
        remedy: 'Connect your GitHub account to let FullSend read private repositories.',
      });
    }
    if (!res.ok) {
      throw new FullSendError('github_error', `GitHub request failed (${res.status})`, {
        retryable: res.status >= 500,
        meta: { path, status: res.status },
      });
    }
    return (await res.json()) as T;
  }

  async getRepo(ref: RepoRef): Promise<RepoMeta> {
    const r = await this.request<any>(`/repos/${ref.owner}/${ref.name}`);
    return {
      owner: r.owner?.login ?? ref.owner,
      name: r.name,
      full_name: r.full_name,
      html_url: r.html_url,
      description: r.description ?? null,
      default_branch: r.default_branch ?? 'main',
      language: r.language ?? null,
      topics: r.topics ?? [],
      stargazers_count: r.stargazers_count ?? 0,
      private: Boolean(r.private),
      size: r.size ?? 0,
      pushed_at: r.pushed_at ?? null,
      homepage: r.homepage || null,
      license: r.license?.spdx_id ?? null,
    };
  }

  /**
   * The commit the default branch is on.
   *
   * This is the identity of an analysis: the same commit always describes the
   * same product, so it never needs analysing twice, and a different commit is
   * a genuinely different thing to understand. Returns null rather than
   * throwing — a repository whose head cannot be read is still analysable, it
   * just cannot be recognised as one already analysed.
   */
  async getHeadSha(ref: RepoRef, branch: string): Promise<string | null> {
    try {
      const r = await this.request<{ sha?: string }>(
        `/repos/${ref.owner}/${ref.name}/commits/${encodeURIComponent(branch)}`,
      );
      return r.sha ?? null;
    } catch {
      return null;
    }
  }

  async getLanguages(ref: RepoRef): Promise<Record<string, number>> {
    try {
      return await this.request<Record<string, number>>(
        `/repos/${ref.owner}/${ref.name}/languages`,
      );
    } catch {
      return {};
    }
  }

  /** Full file tree in one call. Truncates on very large repos, which is fine. */
  async getTree(ref: RepoRef, branch: string): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
    const r = await this.request<any>(
      `/repos/${ref.owner}/${ref.name}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    );
    const entries: TreeEntry[] = (r.tree ?? [])
      .filter((t: any) => t.type === 'blob' || t.type === 'tree')
      .map((t: any) => ({ path: t.path, type: t.type, size: t.size ?? 0 }));
    return { entries, truncated: Boolean(r.truncated) };
  }

  /** Returns null rather than throwing when a file simply isn't there. */
  async getFile(ref: RepoRef, path: string, branch?: string): Promise<string | null> {
    try {
      const q = branch ? `?ref=${encodeURIComponent(branch)}` : '';
      const r = await this.request<any>(
        `/repos/${ref.owner}/${ref.name}/contents/${encodeURI(path)}${q}`,
      );
      if (Array.isArray(r) || !r.content) return null;
      if (r.size > 400_000) return null;
      return Buffer.from(r.content, r.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8');
    } catch (e) {
      if (e instanceof FullSendError && e.code === 'repo_not_found') return null;
      log.debug('file read failed', { path, error: String(e) });
      return null;
    }
  }

  async getReadme(ref: RepoRef): Promise<string | null> {
    try {
      const r = await this.request<any>(`/repos/${ref.owner}/${ref.name}/readme`);
      if (!r.content) return null;
      return Buffer.from(r.content, 'base64').toString('utf8');
    } catch {
      return null;
    }
  }

  /** Raw URL for an in-repo asset, used when a README screenshot is reusable. */
  rawUrl(ref: RepoRef, branch: string, path: string): string {
    return `https://raw.githubusercontent.com/${ref.owner}/${ref.name}/${branch}/${path
      .split('/')
      .map(encodeURIComponent)
      .join('/')}`;
  }

  /** Verifies a token and returns the login it belongs to. */
  async getViewer(): Promise<{ login: string; avatar_url: string } | null> {
    try {
      const r = await this.request<any>('/user');
      return { login: r.login, avatar_url: r.avatar_url };
    } catch {
      return null;
    }
  }
}
