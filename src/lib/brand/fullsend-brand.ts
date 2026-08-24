/**
 * The FullSend brand system.
 *
 * One source of truth for colour, type, voice and phrasing. The logo generator,
 * the Tailwind theme, the creative renderer and the AI prompts all read from
 * here so the product and everything it publishes stay on-brand.
 */

export const FULLSEND_COLORS = {
  /** Signature electric orange. */
  orange: '#FF5A1F',
  orangeBright: '#FF7A3D',
  orangeDeep: '#E2410B',
  orangeGlow: '#FF8A4C',

  /** Deep black / charcoal ground. */
  void: '#08090A',
  black: '#0C0D0F',
  charcoal: '#141618',
  charcoalRaised: '#1C1F22',
  edge: '#26292E',

  white: '#FFFFFF',
  mist: '#E7E9EC',
  gray: '#9BA1A8',
  grayDim: '#6B7178',

  live: '#22C55E',
  warn: '#F5A524',
  fail: '#EF4444',
} as const;

export const FULLSEND_TYPE = {
  display: `'Archivo', 'Helvetica Neue', Arial, sans-serif`,
  body: `'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`,
  mono: `'JetBrains Mono', 'SF Mono', ui-monospace, monospace`,
} as const;

export const FULLSEND_TAGLINES = {
  primary: 'FullSend. Everything goes live.',
  alternates: [
    'One command. Full send.',
    'From zero to fully live.',
    'Accounts. Plan. Posts. Sent.',
  ],
} as const;

/** Brand phrases, used selectively across product surfaces. */
export const FULLSEND_PHRASES = [
  'FullSend. Everything goes live.',
  'One command. Full send.',
  'From zero to fully live.',
  'Accounts. Plan. Posts. Sent.',
  'You build the app. We build the audience.',
  'Stop building apps nobody knows exist.',
  'Turn it on. Let it run.',
  'Your marketing is running.',
  'Ready to send?',
  'FULL SEND →',
] as const;

/**
 * FullSend's own voice — used when FullSend markets itself, and as the default
 * seed for a customer brand profile before their own analysis refines it.
 */
export const FULLSEND_VOICE = {
  personality: [
    'bold',
    'decisive',
    'energetic',
    'confident',
    'modern',
    'slightly irreverent',
    'entrepreneurial',
    'fast-moving',
    'action-oriented',
  ],
  avoid: [
    'corporate',
    'boring',
    'overly polished',
    'generic AI',
    'enterprise marketing platform',
    'traditional social-media scheduler',
  ],
  wordsToUse: [
    'send',
    'live',
    'ship',
    'machine',
    'engine',
    'momentum',
    'audience',
    'autopilot',
  ],
  wordsToAvoid: [
    'synergy',
    'leverage',
    'best-in-class',
    'revolutionize',
    'game-changer',
    'unlock the power of',
    'in today’s fast-paced world',
    'delve',
  ],
} as const;

export type FullSendColor = keyof typeof FULLSEND_COLORS;
