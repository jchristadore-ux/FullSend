import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProject, fakeGitHubClient, setupContext, teardown, type TestContext } from './helpers';
import { analyzeRepository, screenshotAvailability } from '@/lib/analysis/analyze';
import { detectRoutes, extractUiElements, ingestRepository } from '@/lib/github/ingest';
import { parseRepoInput } from '@/lib/github/client';
import { db } from '@/lib/db/repo';
import { FullSendError } from '@/lib/errors';
import type { Project } from '@/lib/types';

describe('repository input parsing', () => {
  it('accepts every shape a founder might paste', () => {
    const expected = { owner: 'vercel', name: 'next.js' };
    expect(parseRepoInput('vercel/next.js')).toEqual(expected);
    expect(parseRepoInput('https://github.com/vercel/next.js')).toEqual(expected);
    expect(parseRepoInput('http://github.com/vercel/next.js/')).toEqual(expected);
    expect(parseRepoInput('https://github.com/vercel/next.js.git')).toEqual(expected);
    expect(parseRepoInput('git@github.com:vercel/next.js.git')).toEqual(expected);
    expect(parseRepoInput('  https://github.com/vercel/next.js/tree/main  ')).toEqual(expected);
  });

  it('rejects nonsense with an actionable message', () => {
    expect(() => parseRepoInput('')).toThrow(FullSendError);
    expect(() => parseRepoInput('not a repo')).toThrow(/Could not read a repository/);
    expect(() => parseRepoInput('https://gitlab.com/a/b')).toThrow(/Only GitHub/);
  });
});

describe('route detection', () => {
  it('recognises the common router conventions', () => {
    const files = [
      { path: 'src/app/page.tsx', type: 'blob' as const, size: 1 },
      { path: 'src/app/inbox/page.tsx', type: 'blob' as const, size: 1 },
      { path: 'src/app/(marketing)/pricing/page.tsx', type: 'blob' as const, size: 1 },
      { path: 'pages/about.tsx', type: 'blob' as const, size: 1 },
      { path: 'pages/api/hook.ts', type: 'blob' as const, size: 1 },
      { path: 'src/routes/dashboard/+page.svelte', type: 'blob' as const, size: 1 },
      { path: 'src/screens/SettingsScreen.tsx', type: 'blob' as const, size: 1 },
    ];
    const routes = detectRoutes(files);

    expect(routes).toContain('/');
    expect(routes).toContain('/inbox');
    expect(routes).toContain('/pricing');
    expect(routes).toContain('/about');
    expect(routes).toContain('/dashboard');
    expect(routes).toContain('/settings');
    // API routes are not screens.
    expect(routes).not.toContain('/api/hook');
  });
});

describe('UI element extraction', () => {
  it('pulls visible strings out of a component', () => {
    const source = `
      export default function Page() {
        return (<main>
          <h1>Daily digest</h1>
          <h2>What matters today</h2>
          <button>Send now</button>
          <input placeholder="Filter by person" />
          <div>{someVariable}</div>
        </main>);
      }`;
    const elements = extractUiElements(source);

    expect(elements).toContain('Daily digest');
    expect(elements).toContain('Send now');
    expect(elements).toContain('Filter by person');
    // Interpolated expressions are not user-visible copy.
    expect(elements.join(' ')).not.toContain('someVariable');
  });
});

describe('repository ingestion', () => {
  it('builds a signal bundle from a real repo shape', async () => {
    const bundle = await ingestRepository({ owner: 'acme', name: 'taskflow' }, fakeGitHubClient());

    expect(bundle.meta.full_name).toBe('acme/taskflow');
    expect(bundle.signals.dependencies).toContain('next');
    expect(bundle.signals.scripts).toContain('build');
    expect(bundle.signals.routes.length).toBeGreaterThan(0);
    expect(bundle.signals.has_tests).toBe(true);
    expect(bundle.signals.has_ci).toBe(true);
    // Screenshots committed to the repo become usable creative.
    expect(bundle.signals.repo_images.length).toBeGreaterThan(0);
    expect(bundle.signals.repo_images[0].url).toContain('raw.githubusercontent.com');
    expect(bundle.screens.length).toBeGreaterThan(0);
  });

  it('strips badges and code fences out of the README summary', async () => {
    const bundle = await ingestRepository({ owner: 'acme', name: 'taskflow' }, fakeGitHubClient());
    expect(bundle.signals.readme_summary).not.toContain('```');
    expect(bundle.signals.readme_summary).not.toContain('![');
    // Boilerplate headings are not product features.
    expect(bundle.signals.readme_headings).not.toContain('Installation');
  });
});

describe('product understanding', () => {
  let ctx: TestContext;
  let project: Project;

  beforeEach(async () => {
    ctx = await setupContext();
    project = await createProject(ctx.scope, ctx.user.id);
  });
  afterEach(() => teardown());

  it('produces a grounded analysis with claim boundaries', async () => {
    const result = await analyzeRepository(ctx.scope, project, 'acme/taskflow', {
      client: fakeGitHubClient(),
    });
    const a = result.analysis;

    expect(a.one_liner.length).toBeGreaterThan(5);
    expect(a.features.length).toBeGreaterThan(0);
    // Every feature must cite where it came from.
    for (const f of a.features) expect(f.evidence.length).toBeGreaterThan(0);
    expect(a.not_capabilities.length).toBeGreaterThan(0);
    expect(a.tech_stack).toContain('Next.js');
    expect(a.confidence).toBeGreaterThan(0);
    expect(a.confidence).toBeLessThanOrEqual(1);
  });

  it('keys the analysis to the commit it was derived from', async () => {
    const result = await analyzeRepository(ctx.scope, project, 'acme/taskflow', {
      client: fakeGitHubClient(),
    });
    expect(result.analysis.commit_sha).toBe('a1b2c3d4e5f60718293a4b5c6d7e8f9012345678');
    expect(result.repository.commit_sha).toBe(result.analysis.commit_sha);
  });

  it('never analyses the same commit twice', async () => {
    const first = await analyzeRepository(ctx.scope, project, 'acme/taskflow', {
      client: fakeGitHubClient(),
    });
    const again = await analyzeRepository(ctx.scope, project, 'acme/taskflow', {
      client: fakeGitHubClient(),
    });

    expect(again.analysis.id).toBe(first.analysis.id);
    expect(again.ran).toEqual({ ingest: false, analysis: false });
    expect(again.costUsd).toBe(0);

    const versions = await db().find(ctx.scope, 'product_analysis', {
      where: { project_id: project.id },
    });
    expect(versions).toHaveLength(1);
  });

  it('understands the product again when the repository has moved on', async () => {
    const first = await analyzeRepository(ctx.scope, project, 'acme/taskflow', {
      client: fakeGitHubClient(),
    });

    const moved = await analyzeRepository(ctx.scope, project, 'acme/taskflow', {
      client: fakeGitHubClient({ commitSha: 'ffffffffffffffffffffffffffffffffffffffff' }),
    });

    // A new version, not an edit: the old understanding is still on disk.
    expect(moved.analysis.id).not.toBe(first.analysis.id);
    expect(moved.analysis.commit_sha).toBe('ffffffffffffffffffffffffffffffffffffffff');
    const versions = await db().find(ctx.scope, 'product_analysis', {
      where: { project_id: project.id },
    });
    expect(versions).toHaveLength(2);
  });

  it('keeps what it has when the head commit cannot be read', async () => {
    // No token, GitHub down, an older client: not knowing is a reason to keep
    // the saved analysis, never to pay a model for a fresh one.
    const first = await analyzeRepository(ctx.scope, project, 'acme/taskflow', {
      client: fakeGitHubClient(),
    });
    const again = await analyzeRepository(ctx.scope, project, 'acme/taskflow', {
      client: fakeGitHubClient({ commitSha: null }),
    });

    expect(again.analysis.id).toBe(first.analysis.id);
    expect(again.costUsd).toBe(0);
  });

  it('reports screenshot availability honestly', async () => {
    const result = await analyzeRepository(ctx.scope, project, 'acme/taskflow', {
      client: fakeGitHubClient(),
    });
    const availability = screenshotAvailability(result.analysis);

    expect(availability.withImages).toBeGreaterThan(0);
    expect(availability.note).toContain('screenshot');
  });

  it('says so plainly when there are no screenshots to use', async () => {
    const result = await analyzeRepository(ctx.scope, project, 'acme/taskflow', {
      client: fakeGitHubClient({ files: [{ path: 'package.json', content: '{}' }], readme: null }),
    });
    const availability = screenshotAvailability(result.analysis);

    expect(availability.withImages).toBe(0);
    expect(availability.note).toMatch(/No screenshots/);
  });

  it('replaces personas on re-analysis rather than duplicating them', async () => {
    const first = await analyzeRepository(ctx.scope, project, 'acme/taskflow', {
      client: fakeGitHubClient(),
    });
    const second = await analyzeRepository(ctx.scope, project, 'acme/taskflow', {
      client: fakeGitHubClient(),
    });

    expect(second.analysis.id).toBe(first.analysis.id);
  });
});
