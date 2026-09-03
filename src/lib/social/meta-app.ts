/**
 * One Meta application, many Instagram accounts.
 *
 * This module exists to hold a distinction the product kept losing: the
 * difference between *application* configuration and *account* authorization.
 *
 *   FullSend's Meta app          ← configured once, by whoever runs FullSend
 *     └── App Review, App Mode, redirect URI, permissions
 *   Each Instagram account       ← authorized by its own owner, one click each
 *     └── its own token, its own account id, its own brand
 *
 * The two were conflated in practice. The first Instagram account was
 * connected while the app was in Development Mode, which works — Meta lets
 * anyone with a *role on the app* authorize a development-mode app. The second
 * account had no role, so Meta refused it with "Insufficient developer role",
 * and the obvious-looking conclusion was that every new account needs to be
 * walked through the developer runbook and added as a tester.
 *
 * That conclusion is wrong, and acting on it does not scale past a handful of
 * brands. The real state of affairs is that the *application* is not finished:
 * a Meta app in Development Mode can only ever be used by people with a role
 * on it, no matter how many accounts you add. Taking the app Live, with the
 * `instagram_business_*` permissions approved, is a one-time change after
 * which any Instagram Business account can authorize by clicking Connect.
 *
 * So: nothing here adds a per-account developer step. What it does is
 * recognise the app-level failure when Meta reports it, and say exactly what
 * to change — once, at the application level — rather than letting it read as
 * a problem with the account somebody just tried to connect.
 */
import 'server-only';
import { env } from '../env';
import { FullSendError } from '../errors';
import {
  INSTAGRAM_SCOPES_FACEBOOK_LOGIN,
  INSTAGRAM_SCOPES_INSTAGRAM_LOGIN,
} from './instagram-scopes';

/** What the deployment's single Meta application looks like right now. */
export interface MetaAppConfig {
  configured: boolean;
  appId: string | null;
  loginMode: 'instagram_login' | 'facebook_login';
  graphVersion: string;
  scopes: string[];
  redirectUri: string;
}

export function metaAppConfig(): MetaAppConfig {
  const loginMode = env.meta.loginMode;
  return {
    configured: Boolean(env.meta.appId && env.meta.appSecret),
    appId: env.meta.appId ?? null,
    loginMode,
    graphVersion: env.meta.graphVersion,
    scopes:
      loginMode === 'instagram_login'
        ? INSTAGRAM_SCOPES_INSTAGRAM_LOGIN
        : INSTAGRAM_SCOPES_FACEBOOK_LOGIN,
    redirectUri: `${env.appUrl}/api/accounts/instagram/callback`,
  };
}

/**
 * Phrases Meta uses when the *application*, not the account, is the problem.
 *
 * Every one of these means the same thing in practice: this app is not open to
 * the public yet, so only people with a role on it can authorize. Meta words
 * it differently depending on which login dialog produced it, and none of the
 * wordings say "your app is in Development Mode" outright.
 */
const APP_LEVEL_PATTERNS = [
  'insufficient developer role',
  'insufficient_developer_role',
  'app not active',
  'app is not active',
  'not accessible',
  'development mode',
  'app is in development',
  'submitted for review',
  'does not have permission to access',
  'invalid scopes',
  'invalid_scope',
  'requires app review',
  'unauthorized client',
  'feature unavailable',
];

export function isAppLevelAuthorizationFailure(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.toLowerCase();
  return APP_LEVEL_PATTERNS.some((p) => t.includes(p));
}

/**
 * The remedy for an app that is not open to the public.
 *
 * Written as the clicks it takes, and written once: it is the same fix whether
 * the first account or the fifteenth hit it, and the point of saying so here
 * is that nobody goes off and adds another tester instead.
 */
export const META_GO_LIVE_REMEDY =
  'This is a one-time change to the FullSend Meta app — not something to repeat for each ' +
  'Instagram account. At developers.facebook.com open the FullSend app, then: (1) App Review → ' +
  'Permissions and Features → request Advanced Access for instagram_business_basic, ' +
  'instagram_business_content_publish and instagram_business_manage_insights; (2) App settings → ' +
  'Basic → complete the Privacy Policy URL and the app icon if they are empty; (3) toggle App ' +
  'Mode from Development to Live at the top of the dashboard. Until the app is Live, Meta only ' +
  'lets people who hold a role on the app authorize it, which is why one account connects and ' +
  'the next is refused. Adding each account as a tester is a workaround for the app not being ' +
  'Live, not the way to run several brands.';

export function metaAppAuthorizationError(detail: string): FullSendError {
  return new FullSendError(
    'meta_app_not_live',
    `Meta refused this connection at the application level: ${detail}`,
    {
      status: 409,
      retryable: false,
      remedy: META_GO_LIVE_REMEDY,
      meta: { appLevel: true, appId: env.meta.appId ?? null },
    },
  );
}

/**
 * Turns any Meta authorization failure into the right one.
 *
 * App-level failures get the app-level remedy; anything else is handed back
 * untouched so an account-level problem is not mislabelled as a configuration
 * one. Guessing in either direction sends somebody to the wrong screen.
 */
export function classifyMetaAuthFailure(detail: string): FullSendError | null {
  return isAppLevelAuthorizationFailure(detail) ? metaAppAuthorizationError(detail) : null;
}
