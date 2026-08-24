/**
 * Platform setup guides.
 *
 * Meta and TikTok both require developer registration, app review and account
 * configuration that no API can do on the founder's behalf. Rather than hiding
 * that behind a "Coming soon", FullSend ships the exact steps, in order, with
 * the values they need — the best possible handoff for the parts that genuinely
 * cannot be automated.
 *
 * Client-safe: no secrets, no server imports.
 */

import type { Platform } from '../types';

export interface SetupStep {
  title: string;
  detail: string;
  /** Where the user has to go to do it. */
  href?: string;
  /** Values FullSend can supply for them to paste. */
  copyValues?: { label: string; valueKey: string }[];
  /** True when FullSend can verify this step completed. */
  verifiable: boolean;
  /** Roughly how long this step blocks on someone else. */
  waitTime?: string;
}

export interface SetupGuide {
  platform: Platform;
  title: string;
  summary: string;
  /** What the user genuinely gets at the end. */
  outcome: string;
  /** What is still restricted even after setup, stated plainly. */
  caveats: string[];
  steps: SetupStep[];
}

export const INSTAGRAM_SETUP: SetupGuide = {
  platform: 'instagram',
  title: 'Connect Instagram',
  summary:
    'Meta requires a one-time developer setup before any tool can publish to Instagram. ' +
    'This is the whole list. Once it is done, FullSend publishes on its own.',
  outcome:
    'FullSend publishes Reels, carousels, feed posts and Stories to your Instagram Business ' +
    'account automatically, and reads back reach, likes, comments, shares and saves.',
  caveats: [
    'Instagram Business account only — Creator accounts cannot use content publishing.',
    'Instagram caps API publishing at 100 posts per rolling 24 hours.',
    'Meta App Review typically takes 2–4 weeks for the publishing permission.',
  ],
  steps: [
    {
      title: 'Switch Instagram to a Business account',
      detail:
        'In the Instagram app: Settings → Account type and tools → Switch to professional ' +
        'account → Business. A Creator account will not work — Meta restricts content publishing ' +
        'to Business accounts.',
      verifiable: true,
    },
    {
      title: 'Link it to a Facebook Page',
      detail:
        'Instagram app: Settings → Sharing and remixes → Facebook, and connect a Page you admin. ' +
        'Meta routes publishing through the Page, so this link is mandatory.',
      href: 'https://www.facebook.com/pages/create',
      verifiable: true,
    },
    {
      title: 'Create a Meta app',
      detail:
        'At developers.facebook.com, create an app of type Business, then add the Instagram ' +
        'product to it. Copy the App ID and App Secret into your FullSend environment as ' +
        'META_APP_ID and META_APP_SECRET.',
      href: 'https://developers.facebook.com/apps/create/',
      copyValues: [{ label: 'OAuth redirect URI', valueKey: 'instagram_redirect_uri' }],
      verifiable: true,
    },
    {
      title: 'Add the OAuth redirect URI',
      detail:
        'In your Meta app: Facebook Login → Settings → Valid OAuth Redirect URIs. Paste the URI ' +
        'below exactly — Meta rejects the login if it does not match character for character.',
      copyValues: [{ label: 'Valid OAuth Redirect URI', valueKey: 'instagram_redirect_uri' }],
      verifiable: false,
    },
    {
      title: 'Request the publishing permissions',
      detail:
        'App Review → Permissions and Features. Request instagram_business_basic, ' +
        'instagram_business_content_publish and instagram_business_manage_insights. You will ' +
        'need a screencast of the publishing flow and a privacy policy URL. Until this is ' +
        'approved, only accounts listed as app testers can be connected.',
      href: 'https://developers.facebook.com/docs/app-review',
      waitTime: '2–4 weeks',
      verifiable: false,
    },
    {
      title: 'Connect your account in FullSend',
      detail:
        'Come back to FullSend → Accounts and hit Connect Instagram. FullSend verifies the ' +
        'account type, finds the linked Page, stores the token encrypted, and starts publishing ' +
        'on schedule.',
      verifiable: true,
    },
  ],
};

export const TIKTOK_SETUP: SetupGuide = {
  platform: 'tiktok',
  title: 'Connect TikTok',
  summary:
    'TikTok requires a developer app and a content-posting audit before posts can be public. ' +
    'You can connect and publish before the audit — those posts are just private to you.',
  outcome:
    'FullSend posts videos directly to TikTok and reads back views, likes, comments and shares.',
  caveats: [
    'Before TikTok audits your app, every API post is forced to SELF_ONLY — visible only to you. ' +
      'FullSend tells you this on each affected post rather than pretending it went live.',
    'The audit takes 2–4 weeks and usually involves a round of follow-up questions.',
    'TikTok fetches video from a URL, so your media domain must be verified in the portal.',
    'A rendered video file is required. Without a video render provider FullSend produces the ' +
      'full production package instead, and you upload the finished video.',
  ],
  steps: [
    {
      title: 'Register a TikTok developer app',
      detail:
        'At developers.tiktok.com, create an app. Copy the Client Key and Client Secret into ' +
        'your FullSend environment as TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET.',
      href: 'https://developers.tiktok.com/apps',
      verifiable: true,
    },
    {
      title: 'Add the Content Posting API and Login Kit',
      detail:
        'In your app, add both products. Under scopes, enable user.info.basic, user.info.profile, ' +
        'user.info.stats, video.list and video.publish. The video.publish scope is what allows ' +
        'direct posting — video.upload only drops drafts into the user’s inbox.',
      verifiable: true,
    },
    {
      title: 'Add the redirect URI',
      detail:
        'Login Kit → Redirect URI. Paste the value below exactly. TikTok requires HTTPS in ' +
        'production and uses PKCE, which FullSend handles for you.',
      copyValues: [{ label: 'Redirect URI', valueKey: 'tiktok_redirect_uri' }],
      verifiable: false,
    },
    {
      title: 'Verify your media domain',
      detail:
        'Content Posting API → URL Prefix Verification. Add the domain FullSend serves creative ' +
        'from. TikTok downloads the video from that URL and will refuse an unverified domain.',
      copyValues: [{ label: 'Media URL prefix', valueKey: 'media_url_prefix' }],
      verifiable: false,
    },
    {
      title: 'Submit for content-posting audit',
      detail:
        'Submit the app for audit with a screen recording of the full posting flow and your ' +
        'privacy policy URL. Until it passes, posts are SELF_ONLY. Once it passes, set ' +
        'TIKTOK_CLIENT_AUDITED=true and FullSend starts posting publicly.',
      href: 'https://developers.tiktok.com/doc/content-sharing-guidelines',
      waitTime: '2–4 weeks',
      verifiable: false,
    },
    {
      title: 'Connect your account in FullSend',
      detail:
        'FullSend → Accounts → Connect TikTok. FullSend reads which privacy levels your account ' +
        'actually offers and picks the right one for every post.',
      verifiable: true,
    },
  ],
};

export const SETUP_GUIDES: Record<string, SetupGuide> = {
  instagram: INSTAGRAM_SETUP,
  tiktok: TIKTOK_SETUP,
};

export function setupGuide(platform: Platform): SetupGuide | null {
  return SETUP_GUIDES[platform] ?? null;
}

/** Fills the copy-paste values a guide references. */
export function setupValues(appUrl: string, mediaPrefix: string | null): Record<string, string> {
  return {
    instagram_redirect_uri: `${appUrl}/api/accounts/instagram/callback`,
    tiktok_redirect_uri: `${appUrl}/api/accounts/tiktok/callback`,
    media_url_prefix: mediaPrefix ?? `${appUrl}/`,
  };
}
