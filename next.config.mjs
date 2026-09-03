/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  serverExternalPackages: ['@anthropic-ai/sdk', 'openai', 'pg'],
  /*
   * The fonts creative is typeset in have to travel with the server bundle.
   *
   * Rasterising an SVG draws text through fontconfig, which can only use fonts
   * present on the machine doing the drawing — and a serverless runtime has
   * none. Without this every generated card publishes as a blank image with a
   * coloured bar on it, which is exactly what happened. Traced explicitly
   * because nothing imports a .ttf, so nothing would otherwise pull them in.
   */
  outputFileTracingIncludes: {
    '/**/*': ['./assets/fonts/**/*.ttf'],
  },
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '**.supabase.co' },
      { protocol: 'https', hostname: 'raw.githubusercontent.com' },
      { protocol: 'https', hostname: 'avatars.githubusercontent.com' },
    ],
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
