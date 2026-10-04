/**
 * resolveAppUrl — the origin every magic link and OAuth redirect is built on.
 *
 * Regression: Vercel Preview inherited NEXT_PUBLIC_APP_URL=<production>, so
 * preview magic links signed people in to production instead of the preview.
 */
import { describe, expect, it } from 'vitest';
import { resolveAppUrl } from '@/lib/env';

const PROD = 'https://full-send-lyart.vercel.app';
const BRANCH = 'full-send-git-fix-preview-app-url-jchristadore-uxs-projects.vercel.app';
const DEPLOY = 'full-send-abc123-jchristadore-uxs-projects.vercel.app';

describe('resolveAppUrl', () => {
  describe('on a Vercel preview', () => {
    it('prefers VERCEL_BRANCH_URL over a production NEXT_PUBLIC_APP_URL', () => {
      expect(
        resolveAppUrl({
          VERCEL_ENV: 'preview',
          NEXT_PUBLIC_APP_URL: PROD,
          VERCEL_PROJECT_PRODUCTION_URL: 'full-send-lyart.vercel.app',
          VERCEL_BRANCH_URL: BRANCH,
          VERCEL_URL: DEPLOY,
        }),
      ).toBe(`https://${BRANCH}`);
    });

    it('falls back to VERCEL_URL when there is no branch URL', () => {
      expect(
        resolveAppUrl({
          VERCEL_ENV: 'preview',
          NEXT_PUBLIC_APP_URL: PROD,
          VERCEL_PROJECT_PRODUCTION_URL: 'full-send-lyart.vercel.app',
          VERCEL_URL: DEPLOY,
        }),
      ).toBe(`https://${DEPLOY}`);
    });

    it('falls back to NEXT_PUBLIC_APP_URL when Vercel exposes no preview host', () => {
      expect(resolveAppUrl({ VERCEL_ENV: 'preview', NEXT_PUBLIC_APP_URL: `${PROD}/` })).toBe(PROD);
    });

    it('does not double the scheme or keep a trailing slash', () => {
      expect(resolveAppUrl({ VERCEL_ENV: 'preview', VERCEL_BRANCH_URL: `https://${BRANCH}/` })).toBe(
        `https://${BRANCH}`,
      );
    });
  });

  describe('in production (unchanged)', () => {
    it('uses the explicit NEXT_PUBLIC_APP_URL even when Vercel hosts are present', () => {
      expect(
        resolveAppUrl({
          VERCEL_ENV: 'production',
          NEXT_PUBLIC_APP_URL: `${PROD}/`,
          VERCEL_PROJECT_PRODUCTION_URL: 'other.example.com',
          VERCEL_BRANCH_URL: BRANCH,
          VERCEL_URL: DEPLOY,
        }),
      ).toBe(PROD);
    });

    it('falls back to VERCEL_PROJECT_PRODUCTION_URL, never the per-deploy URL', () => {
      expect(
        resolveAppUrl({
          VERCEL_ENV: 'production',
          VERCEL_PROJECT_PRODUCTION_URL: 'full-send-lyart.vercel.app',
          VERCEL_BRANCH_URL: BRANCH,
          VERCEL_URL: DEPLOY,
        }),
      ).toBe(PROD);
    });
  });

  describe('locally (unchanged)', () => {
    it('uses NEXT_PUBLIC_APP_URL when set', () => {
      expect(resolveAppUrl({ NEXT_PUBLIC_APP_URL: 'http://localhost:4000' })).toBe('http://localhost:4000');
    });

    it('defaults to localhost with nothing set', () => {
      expect(resolveAppUrl({})).toBe('http://localhost:3000');
    });

    it('ignores VERCEL_BRANCH_URL outside a preview', () => {
      expect(resolveAppUrl({ VERCEL_ENV: 'development', NEXT_PUBLIC_APP_URL: PROD, VERCEL_BRANCH_URL: BRANCH })).toBe(
        PROD,
      );
    });
  });
});
