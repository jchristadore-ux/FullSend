/**
 * Platform setup guides.
 *
 * Split down the middle, on purpose, because conflating the two halves is what
 * made connecting a second Instagram account look like a fortnight of work:
 *
 *   **App setup** happens once, for the whole of FullSend, done by whoever
 *   runs the deployment. Creating the Meta app, registering the redirect URI,
 *   getting the publishing permissions approved, taking the app Live.
 *
 *   **Per account** is what each new brand does: make sure the Instagram
 *   account is a Business account, press Connect. That is the entire list.
 *
 * The first Instagram account was connected while the Meta app was still in
 * Development Mode, which works for anyone holding a role on the app — so the
 * developer runbook and the account connection appeared to be one procedure.
 * They are not. A second account without a role is refused, and the fix is to
 * finish the *application* once, not to run a developer onboarding for every
 * brand.
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
  /**
   * Done once for this FullSend deployment. Not repeated per brand, per
   * account, or per project.
   */
  appSetup: SetupStep[];
  /** What connecting one more account actually takes. */
  perAccount: SetupStep[];
}

export const INSTAGRAM_SETUP: SetupGuide = {
  platform: 'instagram',
  title: 'Connect Instagram',
  summary:
    'Meta requires one developer setup for the FullSend application — once, ever. After that, ' +
    'connecting an account you own is two clicks, however many brands you run. Only letting ' +
    'other people connect their own accounts needs Meta’s App Review.',
  outcome:
    'FullSend publishes Reels, carousels, feed posts and Stories to your Instagram Business ' +
    'account automatically, and reads back reach, likes, comments, shares and saves.',
  caveats: [
    'Instagram Business account only — Creator accounts cannot use content publishing.',
    'No Facebook Page required on the default setup. FullSend uses Instagram Login, which ' +
      'connects to the account directly.',
    'Instagram caps API publishing at 100 posts per rolling 24 hours.',
    'A Meta app in Development Mode only lets accounts with a role on it authorize. That is why ' +
      'the first account connects and the second is refused with "insufficient developer role" — ' +
      'it is the app’s state, never a problem with the account.',
    'Accounts you own: name each one an Instagram tester on the app and connect it. Two minutes ' +
      'per account, no review, and it is Meta’s supported path for an app that serves its own ' +
      'operator. This is what running several of your own brands looks like.',
    'Accounts other people own: that needs Advanced Access through Meta App Review, and Meta ' +
      'gates it behind Business Verification — a registered business, its tax id and documents. ' +
      'Do not start that track to connect an account you already control.',
  ],
  appSetup: [
    {
      title: 'Create the FullSend Meta app',
      detail:
        'At developers.facebook.com, create an app of type Business, then add the Instagram ' +
        'product to it. Copy the App ID and App Secret into your FullSend environment as ' +
        'META_APP_ID and META_APP_SECRET. One app serves every brand and every Instagram ' +
        'account — do not create a second one per brand.',
      href: 'https://developers.facebook.com/apps/create/',
      copyValues: [{ label: 'OAuth redirect URI', valueKey: 'instagram_redirect_uri' }],
      verifiable: true,
    },
    {
      /*
       * The default login mode is Instagram Login, and its redirect URI lives
       * under the Instagram product — not under Facebook Login, which is where
       * this step used to send people. Pasting it in the Facebook Login box
       * leaves the Instagram one empty, and the connection then fails with a
       * redirect-mismatch error that names neither screen.
       */
      title: 'Add the OAuth redirect URI',
      detail:
        'In your Meta app: Instagram → API setup with Instagram login → Business login settings ' +
        '→ OAuth redirect URIs. Paste the URI below exactly — Meta rejects the login if it does ' +
        'not match character for character, including the https and any trailing path. ' +
        '(Only if you set META_LOGIN_MODE=facebook_login does it go under Facebook Login → ' +
        'Settings instead.)',
      copyValues: [{ label: 'OAuth redirect URI', valueKey: 'instagram_redirect_uri' }],
      verifiable: false,
    },
    {
      title: 'Request the publishing permissions',
      detail:
        'App Review → Permissions and Features. Request Advanced Access for ' +
        'instagram_business_basic, instagram_business_content_publish and ' +
        'instagram_business_manage_insights. You will need a screencast of the publishing flow ' +
        'and a privacy policy URL. Request exactly these three: the older instagram_basic and ' +
        'instagram_content_publish were retired on 27 January 2025 and asking for them spends a ' +
        'review to be told they no longer exist.',
      href: 'https://developers.facebook.com/docs/app-review',
      waitTime: '2–4 weeks',
      verifiable: false,
    },
    {
      title: 'Only if other people will connect their own accounts: App Review, then Live',
      detail:
        'Skip this while every Instagram account is one you own — name those as testers instead ' +
        '(see below) and FullSend works today. This step is for opening FullSend to accounts you ' +
        'do not control. App Review → Permissions and Features → request Advanced Access for the ' +
        'three permissions above, then switch the App Mode toggle at the top of the dashboard ' +
        'from Development to Live. Meta gates Advanced Access behind Business Verification, so ' +
        'expect it to ask for a registered business, its tax id and supporting documents, and ' +
        'expect the review itself to take a few weeks.',
      href: 'https://developers.facebook.com/docs/development/release',
      waitTime: '2–4 weeks',
      verifiable: false,
    },
  ],
  perAccount: [
    {
      title: 'Make sure the Instagram account is a Business account',
      detail:
        'In the Instagram app, signed in as that account: Settings → Account type and tools → ' +
        'Switch to professional account → Business. A Creator account will not work — Meta ' +
        'restricts content publishing to Business accounts.',
      verifiable: true,
    },
    {
      title: 'While the app is in Development Mode, name the account a tester',
      detail:
        'Send the invite: Meta app dashboard → App roles → Roles → Add people → Instagram tester ' +
        '→ the account’s exact username. Then accept it while signed in as that account: ' +
        'instagram.com → Settings → Website permissions → Apps and websites → the Tester invites ' +
        'tab → Accept. It is under Website permissions, near the bottom of the settings sidebar — ' +
        'not a top-level item, which is where most people go looking for it. If that tab is empty, ' +
        'the invite was never sent: check Roles shows the username as Pending. Two minutes, and ' +
        'only until the app is Live.',
      href: 'https://developers.facebook.com/apps',
      verifiable: false,
    },
    {
      title: 'Press Connect Instagram',
      detail:
        'Open the brand in FullSend → Accounts and press Connect Instagram. Sign in as that ' +
        'account, approve the permissions, and you are done: FullSend stores that account’s own ' +
        'credentials, attaches them to this brand only, and starts publishing on schedule. ' +
        'There is no developer setup to repeat and no merge step.',
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
  appSetup: [
    {
      title: 'Register a TikTok developer app',
      detail:
        'At developers.tiktok.com, create an app. Copy the Client Key and Client Secret into ' +
        'your FullSend environment as TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET. One app ' +
        'serves every brand.',
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
  ],
  perAccount: [
    {
      title: 'Press Connect TikTok',
      detail:
        'FullSend → Accounts → Connect TikTok, signed in as the account this brand posts from. ' +
        'FullSend reads which privacy levels that account actually offers and picks the right ' +
        'one for every post.',
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
