import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProject, fakeGitHubClient, setupContext, teardown, type TestContext } from './helpers';
import { analyzeRepository, screenshotAvailability } from '@/lib/analysis/analyze';
import { detectRoutes, extractUiElements, ingestRepository } from '@/lib/github/ingest';
import { parseRepoInput } from '@/lib/github/client';
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

    expect(second.personas.length).toBe(first.personas.length);
    const all = await ctx.store.find(ctx.scope, 'personas', { where: { project_id: project.id } });
    expect(all.length).toBe(second.personas.length);
  });
});
