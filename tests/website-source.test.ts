import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createProject,
  setupContext,
  teardown,
  type TestContext,
} from './helpers';
import { parseWebsiteUrl, canonicalWebsiteUrl, nameFromWebsiteUrl } from '@/lib/website/url';
import { isBlockedHostname, isBlockedIp, assertSafePublicUrl } from '@/lib/website/ssrf';
import { FullSendError } from '@/lib/errors';
import { analyzeWebsiteProduct } from '@/lib/analysis/analyze';
import { createProjectInput } from '@/lib/schemas';
import { db } from '@/lib/db/repo';
import { findProjectForWebsite } from '@/lib/pipeline/resume';
import type { WebsiteBundle } from '@/lib/website/ingest';

describe('website URL validation', () => {
  it('accepts https URLs and bare domains', () => {
    expect(parseWebsiteUrl('https://Acme.app/pricing').hostname.toLowerCase()).toBe('acme.app');
    expect(canonicalWebsiteUrl('HTTPS://WWW.Example.com/')).toBe('https://www.example.com');
    expect(canonicalWebsiteUrl('example.com')).toBe('https://example.com');
    expect(nameFromWebsiteUrl('https://www.taskflow.io')).toBe('Taskflow');
  });

  it('rejects non-http schemes and credentialed URLs', () => {
    expect(() => parseWebsiteUrl('file:///etc/passwd')).toThrow(FullSendError);
    expect(() => parseWebsiteUrl('ftp://example.com')).toThrow(FullSendError);
    expect(() => parseWebsiteUrl('https://user:pass@example.com')).toThrow(FullSendError);
  });
});

describe('SSRF guards', () => {
  it('blocks localhost-style hostnames', () => {
    expect(isBlockedHostname('localhost')).toBe(true);
    expect(isBlockedHostname('app.localhost')).toBe(true);
    expect(isBlockedHostname('metadata.google.internal')).toBe(true);
    expect(isBlockedHostname('example.com')).toBe(false);
  });

  it('blocks private and link-local IPs', () => {
    expect(isBlockedIp('127.0.0.1')).toBe(true);
    expect(isBlockedIp('10.0.0.8')).toBe(true);
    expect(isBlockedIp('192.168.1.1')).toBe(true);
    expect(isBlockedIp('172.16.5.5')).toBe(true);
    expect(isBlockedIp('169.254.169.254')).toBe(true);
    expect(isBlockedIp('::1')).toBe(true);
    expect(isBlockedIp('8.8.8.8')).toBe(false);
  });

  it('refuses literal private IPs in URLs without DNS', async () => {
    await expect(assertSafePublicUrl('http://127.0.0.1/')).rejects.toThrow(/Refusing/);
    await expect(assertSafePublicUrl('http://169.254.169.254/latest/')).rejects.toThrow(/Refusing/);
    await expect(assertSafePublicUrl('http://localhost/')).rejects.toThrow(/Refusing/);
  });
});

describe('createProjectInput source exclusivity', () => {
  it('requires exactly one of repository or website_url', () => {
    expect(createProjectInput.safeParse({}).success).toBe(false);
    expect(
      createProjectInput.safeParse({
        repository: 'acme/app',
        website_url: 'https://acme.app',
      }).success,
    ).toBe(false);
    expect(createProjectInput.safeParse({ repository: 'acme/app' }).success).toBe(true);
    expect(createProjectInput.safeParse({ website_url: 'https://acme.app' }).success).toBe(true);
  });
});

describe('website product analysis entry path', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupContext();
  });
  afterEach(teardown);

  it('persists source_type website and analyses from a mocked fetch', async () => {
    const project = await createProject(ctx.scope, ctx.user.id, {
      name: 'Acme',
      slug: 'acme-site',
      source_type: 'website',
      website_url: 'https://acme.example',
    });

    const bundle: WebsiteBundle = {
      url: 'https://acme.example',
      finalUrl: 'https://acme.example/',
      title: 'Acme — ship faster',
      contentHash: 'abc123',
      signals: {
        origin: 'https://acme.example',
        pages: [
          {
            url: 'https://acme.example/',
            title: 'Acme — ship faster',
            meta_description: 'Project management for founders.',
            headings: ['Ship faster', 'Pricing'],
            text_excerpt: 'Acme helps founders plan and ship product work.',
            links: ['https://acme.example/pricing'],
          },
        ],
        titles: ['Acme — ship faster'],
        meta_descriptions: ['Project management for founders.'],
        headings: ['Ship faster', 'Pricing'],
        text_excerpt: 'Acme helps founders plan and ship product work.',
        discovered_paths: ['/'],
        truncated: false,
      },
      screens: [],
    };

    const result = await analyzeWebsiteProduct(ctx.scope, project, 'https://acme.example', {
      ingest: async () => bundle,
    });

    expect(result.ran.ingest).toBe(true);
    expect(result.analysis.repository_id).toBeNull();
    expect(result.analysis.one_liner.length).toBeGreaterThan(5);
    expect(result.analysis.features.length).toBeGreaterThan(0);
    expect((result.analysis.raw_signals as { source?: string }).source).toBe('website');

    const saved = await db().findOne(ctx.scope, 'website_sources', {
      where: { project_id: project.id },
    });
    expect(saved?.url).toBe('https://acme.example');
    expect(saved?.content_hash).toBe('abc123');

    const again = await analyzeWebsiteProduct(ctx.scope, project, 'https://acme.example', {
      ingest: async () => {
        throw new Error('should not re-fetch');
      },
    });
    expect(again.ran.analysis).toBe(false);
    expect(again.costUsd).toBe(0);
  });

  it('finds an existing website project for resume', async () => {
    await createProject(ctx.scope, ctx.user.id, {
      name: 'Acme',
      slug: 'acme-site',
      source_type: 'website',
      website_url: 'https://acme.example',
    });
    const found = await findProjectForWebsite(ctx.scope, ctx.user.id, 'https://acme.example/');
    expect(found?.slug).toBe('acme-site');
  });
});
