/**
 * Video engine.
 *
 * FullSend always produces a complete production package: hook, scenes with
 * real timings, narration, on-screen text, music direction and CTA. When a
 * render provider is configured the package is handed to it and a real file
 * comes back. When one is not, the package is marked `package_only` and says so
 * — the product never claims a video was generated when it wasn't.
 */
import 'server-only';
import { env } from '../env';
import { FullSendError } from '../errors';
import { logger } from '../logger';
import type { Platform, ProductAnalysis, VideoPlan, VideoScene } from '../types';

const log = logger('video');

/** Platform-appropriate target lengths, well inside each API's ceiling. */
const TARGET_SECONDS: Record<string, number> = {
  instagram: 22,
  tiktok: 28,
  youtube_shorts: 30,
};

export function buildVideoPackage(input: {
  hook: string;
  caption: string;
  cta: string;
  analysis: Pick<ProductAnalysis, 'features' | 'screens' | 'one_liner' | 'problem_solved'>;
  platform: Platform;
}): VideoPlan {
  const { hook, caption, cta, analysis, platform } = input;
  const target = TARGET_SECONDS[platform] ?? 25;

  const screen = analysis.screens.find((s) => s.key_elements.length) ?? analysis.screens[0] ?? null;
  const feature = analysis.features.find((f) => f.user_facing) ?? analysis.features[0] ?? null;
  const body = caption
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(1);

  const scenes: VideoScene[] = [
    {
      index: 0,
      duration_seconds: 2.5,
      visual: 'Cold open on the end result, before any explanation',
      on_screen_text: truncate(hook, 60),
      narration: hook,
      screen_reference: screen?.name ?? null,
    },
    {
      index: 1,
      duration_seconds: Math.round(target * 0.22),
      visual: 'The problem, shown not described — the slow manual version',
      on_screen_text: 'THE OLD WAY',
      narration: analysis.problem_solved || body[0] || 'Here is what this normally takes.',
      screen_reference: null,
    },
    {
      index: 2,
      duration_seconds: Math.round(target * 0.4),
      visual: screen
        ? `Screen recording of ${screen.name}${screen.key_elements.length ? ` — ${screen.key_elements.slice(0, 2).join(', ')}` : ''}, real time, no cuts`
        : 'Screen recording of the core workflow, real time, no cuts',
      on_screen_text: (feature?.name ?? 'THE FIX').toUpperCase(),
      narration: feature
        ? `${feature.name}: ${feature.description}`
        : analysis.one_liner,
      screen_reference: screen?.name ?? null,
    },
    {
      index: 3,
      duration_seconds: Math.round(target * 0.2),
      visual: 'The result on screen. Hold long enough to read it.',
      on_screen_text: 'DONE',
      narration: body[1] ?? 'That is the whole workflow.',
      screen_reference: screen?.name ?? null,
    },
    {
      index: 4,
      duration_seconds: 2.5,
      visual: 'Hard cut to a full-bleed brand card',
      on_screen_text: truncate(cta || 'Link in bio', 40),
      narration: cta || 'Link in bio.',
      screen_reference: null,
    },
  ];

  const total = scenes.reduce((s, sc) => s + sc.duration_seconds, 0);

  return {
    total_duration_seconds: Math.round(total * 10) / 10,
    hook_text: hook,
    scenes,
    narration_script: scenes
      .map((s) => `[${s.duration_seconds}s] ${s.narration}`)
      .join('\n'),
    music_direction:
      'Percussive, no vocals, 120–130bpm. Cut on the beat at each scene change. ' +
      'Use the platform’s licensed audio library — never a commercial track.',
    cta_text: cta || 'Link in bio',
    rendered_url: null,
    render_status: env.video.provider === 'none' ? 'package_only' : 'not_attempted',
    render_note:
      env.video.provider === 'none'
        ? 'No video render provider configured. This is a complete production package — ' +
          'shoot it as specified, or set FULLSEND_VIDEO_PROVIDER to render automatically.'
        : null,
  };
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`;
}

/* ── Render provider abstraction ────────────────────────────────────────── */

export interface VideoRenderProvider {
  readonly name: string;
  readonly available: boolean;
  render(plan: VideoPlan, opts: { width: number; height: number }): Promise<{
    url: string;
    durationSeconds: number;
  }>;
}

class NoRenderProvider implements VideoRenderProvider {
  readonly name = 'none';
  readonly available = false;
  async render(): Promise<never> {
    throw new FullSendError('video_render_unavailable', 'No video render provider is configured', {
      remedy:
        'Set FULLSEND_VIDEO_PROVIDER and FULLSEND_VIDEO_API_KEY to render automatically. ' +
        'Until then FullSend produces the full production package instead.',
    });
  }
}

/**
 * Template-based render services (Shotstack, Creatomate and similar) all take
 * the same shape: a timeline of clips with text overlays, submitted as JSON.
 */
class TimelineRenderProvider implements VideoRenderProvider {
  readonly available = true;
  constructor(
    readonly name: string,
    private endpoint: string,
    private apiKey: string,
  ) {}

  async render(
    plan: VideoPlan,
    opts: { width: number; height: number },
  ): Promise<{ url: string; durationSeconds: number }> {
    const body = {
      timeline: {
        background: '#08090A',
        tracks: [
          {
            clips: plan.scenes.map((s, i) => ({
              asset: { type: 'text', text: s.on_screen_text, alignment: { horizontal: 'left' } },
              start: plan.scenes.slice(0, i).reduce((sum, p) => sum + p.duration_seconds, 0),
              length: s.duration_seconds,
              transition: { in: 'fade', out: 'fade' },
            })),
          },
        ],
      },
      output: { format: 'mp4', size: { width: opts.width, height: opts.height } },
    };

    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': this.apiKey },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new FullSendError('video_render_failed', `Render provider returned ${res.status}`, {
        retryable: res.status >= 500,
        remedy: 'FullSend will retry. The production package is available either way.',
      });
    }
    const json = (await res.json()) as { response?: { url?: string; id?: string }; url?: string };
    const url = json.response?.url ?? json.url;
    if (!url) {
      throw new FullSendError('video_render_pending', 'Render was accepted but is not ready yet', {
        retryable: true,
        remedy: 'FullSend will poll for the finished file.',
      });
    }
    return { url, durationSeconds: plan.total_duration_seconds };
  }
}

export function getVideoProvider(): VideoRenderProvider {
  if (env.video.provider === 'none' || !env.video.apiKey) return new NoRenderProvider();
  const endpoints: Record<string, string> = {
    shotstack: 'https://api.shotstack.io/edit/v1/render',
    creatomate: 'https://api.creatomate.com/v1/renders',
  };
  const endpoint = endpoints[env.video.provider];
  if (!endpoint) return new NoRenderProvider();
  return new TimelineRenderProvider(env.video.provider, endpoint, env.video.apiKey);
}

/** Attempts a render, degrading to the package rather than failing the post. */
export async function tryRender(
  plan: VideoPlan,
  size: { width: number; height: number },
): Promise<VideoPlan> {
  const provider = getVideoProvider();
  if (!provider.available) {
    return {
      ...plan,
      render_status: 'package_only',
      render_note:
        'No render provider configured — this is a complete production package, not a rendered file.',
    };
  }
  try {
    const { url, durationSeconds } = await provider.render(plan, size);
    log.info('video rendered', { provider: provider.name, durationSeconds });
    return { ...plan, rendered_url: url, render_status: 'rendered', render_note: null };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log.warn('video render failed', { provider: provider.name, error: message });
    return {
      ...plan,
      render_status: 'failed',
      render_note: `Render failed: ${message}. The production package is still complete.`,
    };
  }
}
