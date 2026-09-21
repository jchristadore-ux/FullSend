/**
 * Meta App Review readiness signals.
 *
 * Presence and expectations only — never the App ID, App Secret, webhook
 * verify token, or any other secret. Safe to expose on a public health route
 * so an operator (or Meta reviewer following our docs) can confirm the
 * deployment is wired without learning anything that is not already in an
 * OAuth redirect URI.
 */
import 'server-only';
import { env } from '../env';
import {
  INSTAGRAM_SCOPES_FACEBOOK_LOGIN,
  INSTAGRAM_SCOPES_INSTAGRAM_LOGIN,
} from './instagram-scopes';

const set = (v: string | undefined) => Boolean(v && v.trim());

export interface MetaReadiness {
  /** True when both META_APP_ID and META_APP_SECRET are set (values never returned). */
  configured: boolean;
  appIdPresent: boolean;
  appSecretPresent: boolean;
  contactEmailPresent: boolean;
  encryptionKeyPresent: boolean;
  loginMode: 'instagram_login' | 'facebook_login';
  graphVersion: string;
  /** Scopes this deployment will request for the active login mode. */
  scopes: string[];
  /** Expected OAuth redirect — must match Meta app settings character-for-character. */
  redirectUri: string;
  /** URLs to paste into Meta App settings → Basic / Facebook Login. */
  callbacks: {
    deauthorize: string;
    dataDeletion: string;
    dataDeletionStatusPage: string;
  };
  legalPages: {
    privacy: string;
    terms: string;
    dataDeletion: string;
  };
  /**
   * Instagram fetches generated creative over HTTPS with no session of ours.
   * The public media origin is the Supabase storage host when configured, else
   * the app origin. Domain allow-lists in Meta must cover this origin.
   */
  media: {
    requiresPublicHttpsUrl: boolean;
    storageBucketConfigured: boolean;
    storageBucketName: string;
    note: string;
  };
  /** Anything that would block or fail an App Review submission. */
  reviewNotes: string[];
}

export function metaReadiness(): MetaReadiness {
  const base = env.appUrl.replace(/\/+$/, '');
  const loginMode = env.meta.loginMode;
  const scopes =
    loginMode === 'instagram_login'
      ? [...INSTAGRAM_SCOPES_INSTAGRAM_LOGIN]
      : [...INSTAGRAM_SCOPES_FACEBOOK_LOGIN];

  const appIdPresent = set(env.meta.appId);
  const appSecretPresent = set(env.meta.appSecret);
  const contactEmailPresent = set(env.contactEmail);
  const encryptionKeyPresent = set(env.encryptionKey);
  const configured = appIdPresent && appSecretPresent;

  const reviewNotes: string[] = [];
  if (!configured) {
    reviewNotes.push(
      'META_APP_ID and/or META_APP_SECRET are missing — Instagram Connect cannot start.',
    );
  }
  if (!contactEmailPresent) {
    reviewNotes.push(
      'FULLSEND_CONTACT_EMAIL is not set — /privacy, /terms and /data-deletion must name a reachable contact for App Review.',
    );
  }
  if (!encryptionKeyPresent) {
    reviewNotes.push(
      'FULLSEND_ENCRYPTION_KEY is not set — OAuth tokens cannot be stored, so Connect will refuse.',
    );
  }
  if (env.appUrlIsLocal) {
    reviewNotes.push(
      'NEXT_PUBLIC_APP_URL resolves to localhost — OAuth redirects and Meta callbacks must be a public HTTPS origin.',
    );
  }
  if (loginMode === 'facebook_login') {
    reviewNotes.push(
      'META_LOGIN_MODE=facebook_login requests retired pre-2025 scope names (instagram_basic, instagram_content_publish). Prefer instagram_login for App Review unless you have confirmed those permissions still exist for your app.',
    );
  }

  return {
    configured,
    appIdPresent,
    appSecretPresent,
    contactEmailPresent,
    encryptionKeyPresent,
    loginMode,
    graphVersion: env.meta.graphVersion,
    scopes,
    redirectUri: `${base}/api/accounts/instagram/callback`,
    callbacks: {
      deauthorize: `${base}/api/accounts/instagram/deauthorize`,
      dataDeletion: `${base}/api/accounts/instagram/data-deletion`,
      dataDeletionStatusPage: `${base}/data-deletion`,
    },
    legalPages: {
      privacy: `${base}/privacy`,
      terms: `${base}/terms`,
      dataDeletion: `${base}/data-deletion`,
    },
    media: {
      requiresPublicHttpsUrl: true,
      storageBucketConfigured: Boolean(env.supabase.url && env.supabase.serviceRoleKey),
      storageBucketName: env.supabase.storageBucket,
      note:
        'Instagram Content Publishing requires each media asset at a public HTTPS URL Meta can fetch with no auth. FullSend serves generated creative from the public Supabase storage bucket (default name fullsend-creative). Register that storage origin (and the app origin if used) wherever Meta asks for a media domain / URL prefix. A private or missing bucket fails at publish time with an Instagram media error.',
    },
    reviewNotes,
  };
}
