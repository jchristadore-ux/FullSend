/**
 * Shared fixtures.
 *
 * `bootstrapProject` walks the same path the product does — analyse, strategy,
 * connect, generate, schedule — so tests exercise the real pipeline rather than
 * hand-built rows.
 */
import { MemoryStore, setStore, systemScope, userScope, type TenantScope } from '@/lib/db';
import { db } from '@/lib/db/repo';
import { newId, nowIso } from '@/lib/ids';
import { clearCache } from '@/lib/ai/cache';
import { setProvider } from '@/lib/ai/client';
import { clearMockAdapters, installMockAdapters } from '@/lib/social/registry';
import { completeConnection } from '@/lib/social/connections';
import type { MockAdapter } from '@/lib/social/mock';
import { resetLimits } from '@/lib/rate-limit';
import type { GitHubClient } from '@/lib/github/client';
import type { Platform, Project, User } from '@/lib/types';

export interface TestContext {
  store: MemoryStore;
  user: User;
  scope: TenantScope;
  adapters: Map<Platform, MockAdapter>;
}

export function freshStore(): MemoryStore {
  const store = new MemoryStore();
  setStore(store);
  clearCache();
  setProvider(null);
  resetLimits();
  return store;
}

export async function createUser(email = 'founder@example.com'): Promise<User> {
  return db().insert(systemScope('test'), 'users', {
    id: newId(),
    email,
    name: 'Test Founder',
    avatar_url: null,
    is_admin: false,
    created_at: nowIso(),
  });
}

export async function setupContext(email?: string): Promise<TestContext> {
  const store = freshStore();
  const adapters = installMockAdapters();
  const user = await createUser(email);
  return { store, user, scope: userScope(user.id), adapters };
}

export function teardown(): void {
  clearMockAdapters();
  setStore(null);
  setProvider(null);
}

export async function createProject(
  scope: TenantScope,
  userId: string,
  overrides: Partial<Project> = {},
): Promise<Project> {
  return db().insert(scope, 'projects', {
    id: newId(),
    user_id: userId,
    name: 'Taskflow',
    slug: 'taskflow',
    status: 'created',
    autopilot_mode: 'full_send',
    timezone: 'UTC',
    is_internal: false,
    last_autopilot_run_at: null,
    created_at: nowIso(),
    updated_at: nowIso(),
    ...overrides,
  });
}

/**
 * A GitHub client stand-in backed by a fixed repository, so analysis tests are
 * deterministic and never touch the network.
 */
export function fakeGitHubClient(overrides: Partial<FakeRepo> = {}): GitHubClient {
  const repo: FakeRepo = { ...DEFAULT_REPO, ...overrides };

  return {
    async getRepo() {
      return {
        owner: repo.owner,
        name: repo.name,
        full_name: `${repo.owner}/${repo.name}`,
        html_url: `https://github.com/${repo.owner}/${repo.name}`,
        description: repo.description,
        default_branch: 'main',
        language: 'TypeScript',
        topics: repo.topics,
        stargazers_count: 128,
        private: false,
        size: 2400,
        pushed_at: nowIso(),
        homepage: repo.homepage,
        license: 'MIT',
      };
    },
    async getLanguages() {
      return { TypeScript: 90_000, CSS: 8_000 };
    },
    async getTree() {
      return {
        entries: repo.files.map((f) => ({
          path: f.path,
          type: 'blob' as const,
          size: f.size ?? 2000,
        })),
        truncated: false,
      };
    },
    async getFile(_ref: unknown, path: string) {
      return repo.files.find((f) => f.path === path)?.content ?? null;
    },
    async getReadme() {
      return repo.readme;
    },
    rawUrl(_ref: unknown, branch: string, path: string) {
      return `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${branch}/${path}`;
    },
    async getViewer() {
      return { login: repo.owner, avatar_url: '' };
    },
    async getHeadSha() {
      return repo.commitSha;
    },
  } as unknown as GitHubClient;
}

interface FakeRepo {
  owner: string;
  name: string;
  description: string | null;
  homepage: string | null;
  topics: string[];
  readme: string | null;
  files: { path: string; content?: string; size?: number }[];
  /** The head commit this stand-in reports. Null models a repo we cannot key. */
  commitSha: string | null;
}

const DEFAULT_REPO: FakeRepo = {
  owner: 'acme',
  name: 'taskflow',
  commitSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
  description: 'Turn messy team chatter into a clean task list, automatically.',
  homepage: 'https://taskflow.example.com',
  topics: ['productivity', 'tasks', 'ai'],
  readme: `# Taskflow

Turn messy team chatter into a clean task list, automatically.

## Automatic task extraction
Taskflow reads your team's messages and pulls out the actual commitments.

## Smart prioritisation
Tasks are ranked by deadline pressure and who is blocked on them.

## Daily digest
One message every morning with what actually matters today.

## Installation
npm install
`,
  files: [
    {
      path: 'package.json',
      content: JSON.stringify({
        name: 'taskflow',
        dependencies: { next: '15.0.0', react: '19.0.0', '@anthropic-ai/sdk': '0.30.0' },
        devDependencies: { typescript: '5.0.0', vitest: '2.0.0' },
        scripts: { dev: 'next dev', build: 'next build', test: 'vitest' },
      }),
    },
    {
      path: 'src/app/page.tsx',
      content: '<h1>Taskflow</h1><button>Connect workspace</button>',
    },
    {
      path: 'src/app/inbox/page.tsx',
      content: '<h1>Inbox</h1><button>Extract tasks</button><h2>Today</h2>',
    },
    {
      path: 'src/app/digest/page.tsx',
      content: '<h1>Daily digest</h1><button>Send now</button>',
    },
    { path: 'src/app/settings/page.tsx', content: '<h1>Settings</h1>' },
    { path: 'tests/extract.test.ts', content: 'test' },
    { path: '.github/workflows/ci.yml', content: 'name: ci' },
    { path: 'docs/screenshot-inbox.png', size: 240_000 },
    { path: 'docs/screenshot-digest.png', size: 180_000 },
    ...Array.from({ length: 70 }, (_, i) => ({ path: `src/lib/mod${i}.ts`, content: 'x' })),
  ],
};

/** Connects a mock platform so publishing paths are exercisable. */
export async function connectPlatform(
  scope: TenantScope,
  project: Project,
  platform: Platform,
): Promise<void> {
  const tokens = {
    accessToken: `token-${platform}`,
    refreshToken: `refresh-${platform}`,
    expiresAt: new Date(Date.now() + 86_400_000),
    refreshExpiresAt: new Date(Date.now() + 30 * 86_400_000),
    scopes: ['publish', 'insights'],
  };
  await completeConnection(scope, project, platform, tokens, {
    externalId: `${platform}-account`,
    username: `acme_${platform}`,
    displayName: 'Acme',
    avatarUrl: null,
    followers: 1000,
    metadata: {},
  });
}

/** Gives creative assets a URL so publishing does not need object storage. */
export async function stubCreativeUrls(scope: TenantScope, projectId: string): Promise<void> {
  const assets = await db().find(scope, 'creative_assets', { where: { project_id: projectId } });
  for (const a of assets) {
    if (!a.url) {
      await db().update(scope, 'creative_assets', a.id, {
        url: `https://cdn.fullsend.test/${a.id}.jpg`,
        mime_type: 'image/jpeg',
      });
    }
  }
}

export function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}
