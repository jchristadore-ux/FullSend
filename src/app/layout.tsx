import type { Metadata, Viewport } from 'next';
import './globals.css';
import { FULLSEND_TAGLINES } from '@/lib/brand/fullsend-brand';

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'),
  title: {
    default: 'FullSend — Everything goes live.',
    template: '%s · FullSend',
  },
  description:
    'Give FullSend your app. We build the marketing machine. Connect your GitHub repo and ' +
    'FullSend figures out what your product does, who needs it, what to post, and when to send it.',
  applicationName: 'FullSend',
  keywords: [
    'marketing automation',
    'AI marketing',
    'social media automation',
    'indie hackers',
    'app marketing',
  ],
  icons: {
    icon: [{ url: '/brand/favicon.svg', type: 'image/svg+xml' }],
    apple: [{ url: '/brand/fullsend-app-icon.svg' }],
  },
  openGraph: {
    title: 'FullSend — Everything goes live.',
    description: FULLSEND_TAGLINES.primary,
    siteName: 'FullSend',
    type: 'website',
    images: [{ url: '/brand/fullsend-social-avatar.svg', width: 1024, height: 1024 }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'FullSend — Everything goes live.',
    description: 'You build the app. FullSend builds the audience.',
  },
};

export const viewport: Viewport = {
  themeColor: '#08090A',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Archivo:wght@600;700;800;900&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
