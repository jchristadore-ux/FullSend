import type { Config } from 'tailwindcss';

/**
 * FullSend theme. Dark-first command centre: deep charcoal ground, electric
 * orange signature, white type, sharp edges. Keep radii small — the brand is
 * decisive, not soft.
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        orange: {
          DEFAULT: '#FF5A1F',
          bright: '#FF7A3D',
          deep: '#E2410B',
          glow: '#FF8A4C',
        },
        void: '#08090A',
        ink: '#0C0D0F',
        charcoal: {
          DEFAULT: '#141618',
          raised: '#1C1F22',
        },
        edge: '#26292E',
        mist: '#E7E9EC',
        dim: '#9BA1A8',
        dimmer: '#6B7178',
        live: '#22C55E',
        warn: '#F5A524',
        fail: '#EF4444',
      },
      fontFamily: {
        display: ['var(--font-display)', 'Archivo', 'Helvetica Neue', 'Arial', 'sans-serif'],
        sans: ['var(--font-body)', 'Inter', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
        mono: ['var(--font-mono)', 'JetBrains Mono', 'SF Mono', 'ui-monospace', 'monospace'],
      },
      borderRadius: {
        none: '0',
        sm: '2px',
        DEFAULT: '4px',
        md: '6px',
        lg: '8px',
        xl: '12px',
      },
      letterSpacing: {
        tightest: '-0.045em',
        crush: '-0.06em',
      },
      boxShadow: {
        send: '0 0 0 1px rgba(255,90,31,0.35), 0 8px 40px -8px rgba(255,90,31,0.45)',
        panel: '0 1px 0 0 rgba(255,255,255,0.04) inset, 0 20px 50px -30px rgba(0,0,0,0.9)',
      },
      keyframes: {
        'send-pulse': {
          '0%, 100%': { opacity: '1', transform: 'scale(1)' },
          '50%': { opacity: '0.45', transform: 'scale(0.82)' },
        },
        'flow-down': {
          '0%': { transform: 'translateY(-100%)', opacity: '0' },
          '20%': { opacity: '1' },
          '80%': { opacity: '1' },
          '100%': { transform: 'translateY(100%)', opacity: '0' },
        },
        'throttle-in': {
          '0%': { opacity: '0', transform: 'translateY(14px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        marquee: {
          '0%': { transform: 'translateX(0)' },
          '100%': { transform: 'translateX(-50%)' },
        },
        scan: {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(400%)' },
        },
        'ticker-up': {
          '0%': { opacity: '0', transform: 'translateY(6px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'send-pulse': 'send-pulse 1.9s ease-in-out infinite',
        'flow-down': 'flow-down 2.4s linear infinite',
        'throttle-in': 'throttle-in 0.5s cubic-bezier(0.2,0.8,0.2,1) both',
        marquee: 'marquee 32s linear infinite',
        scan: 'scan 2.6s cubic-bezier(0.4,0,0.2,1) infinite',
        'ticker-up': 'ticker-up 0.35s ease-out both',
      },
    },
  },
  plugins: [],
};

export default config;
