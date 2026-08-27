/**
 * Why generation would produce nothing — knowable before anyone presses the
 * button.
 *
 * Every one of these is a state the app can read at any time, not something
 * discovered by running a job. Checking them only inside the generator meant
 * the calendar showed "Generate a calendar and FullSend fills it with real
 * posts" next to a button that could not keep that promise, and the reason
 * appeared as a line of small text after the click — if the founder happened
 * to still be looking at it.
 *
 * Shared so the page and the job agree: one list, one wording, one fix.
 */

/**
 * Browser-safe. The type and the copy live apart from the database read so a
 * client component can render a blocker without pulling `server-only` in.
 */
export interface GenerationBlocker {
  code:
    | 'no_analysis'
    | 'no_strategy'
    | 'strategy_unapproved'
    | 'no_brand'
    | 'no_platform';
  /** What is wrong, in the founder's words. */
  message: string;
  /** The single action that clears it. */
  fix: { label: string; href: string };
}

const BLOCKERS: Record<GenerationBlocker['code'], GenerationBlocker> = {
  no_analysis: {
    code: 'no_analysis',
    message: 'FullSend has not analysed your repository yet, so it has nothing to write about.',
    fix: { label: 'Analyse the repo', href: '/onboarding' },
  },
  no_strategy: {
    code: 'no_strategy',
    message: 'There is no marketing strategy yet — the calendar is built from it.',
    fix: { label: 'Build the strategy', href: '/app/strategy' },
  },
  strategy_unapproved: {
    code: 'strategy_unapproved',
    message:
      'Your strategy is written but not approved. FullSend will not put anything on the calendar until you have read it and said yes.',
    fix: { label: 'Review and approve it', href: '/app/strategy' },
  },
  no_brand: {
    code: 'no_brand',
    message: 'There is no brand profile yet, so there is no voice to write in.',
    fix: { label: 'Build the strategy', href: '/app/strategy' },
  },
  no_platform: {
    code: 'no_platform',
    message:
      'Your strategy does not target any platform FullSend can publish to yet — it needs Instagram or TikTok.',
    fix: { label: 'Edit the platform mix', href: '/app/strategy' },
  },
};

export function blocker(code: GenerationBlocker['code']): GenerationBlocker {
  return BLOCKERS[code];
}

/**
 * True when a longer window is genuinely the remedy.
 *
 * Only the two "there was room for nothing new" outcomes qualify. Telling
 * someone whose strategy is unapproved to try 90 days instead of 30 sends them
 * to press the same button again, which is exactly the loop this exists to
 * break.
 */
export function longerWindowHelps(reason: string | undefined): boolean {
  if (!reason) return true;
  return (
    reason.startsWith('The calendar is already full') ||
    reason.startsWith('Nothing new passed the duplicate check')
  );
}
