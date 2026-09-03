/**
 * The permissions FullSend's one Meta application asks for.
 *
 * Kept apart from the adapter so the application-level module can read them
 * without importing the publisher, and so a review submission and the OAuth
 * dialog can never drift into asking for different things.
 */

/*
 * ⚠ These are the pre-2025 names. Meta retired `instagram_basic` and
 * `instagram_content_publish` on 27 January 2025, replacing them with the
 * `instagram_business_*` permissions below. This list is kept only for the
 * Facebook-Login-for-Business path, which is no longer the default; check it
 * against Meta's current documentation before submitting an App Review that
 * relies on it, or a review can be spent to be told the permission no longer
 * exists.
 */
export const INSTAGRAM_SCOPES_FACEBOOK_LOGIN = [
  'instagram_basic',
  'instagram_content_publish',
  'instagram_manage_insights',
  'pages_show_list',
  'pages_read_engagement',
  'business_management',
];

/** The current permissions, and what the default login mode asks for. */
export const INSTAGRAM_SCOPES_INSTAGRAM_LOGIN = [
  'instagram_business_basic',
  'instagram_business_content_publish',
  'instagram_business_manage_insights',
];

/** The permission that actually lets FullSend post, under either login mode. */
export function publishScopeFor(loginMode: 'instagram_login' | 'facebook_login'): string {
  return loginMode === 'instagram_login'
    ? 'instagram_business_content_publish'
    : 'instagram_content_publish';
}
