/**
 * Web app manifest.
 *
 * What Android reads when someone installs FullSend to their home screen: the
 * name under the icon, the icon itself, and that it should open without
 * browser chrome. iOS takes its icon from the apple-touch-icon link instead —
 * both are wired up, because neither covers the other.
 */
import type { MetadataRoute } from 'next';
import { FULLSEND_COLORS } from '@/lib/brand/fullsend-brand';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'FullSend — Everything goes live.',
    // What actually fits under an icon on a home screen.
    short_name: 'FullSend',
    description: 'You build the app. FullSend builds the audience.',
    // Installed, it opens the Send Center rather than the marketing page.
    start_url: '/app',
    scope: '/',
    display: 'standalone',
    background_color: FULLSEND_COLORS.void,
    theme_color: FULLSEND_COLORS.void,
    orientation: 'portrait',
    categories: ['business', 'productivity'],
    icons: [
      {
        src: '/brand/fullsend-app-icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/brand/fullsend-app-icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      // Separate entry: a launcher that crops needs art that survives cropping.
      {
        src: '/brand/fullsend-app-icon-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}
