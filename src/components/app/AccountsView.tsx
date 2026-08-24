'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { SetupGuide } from '@/lib/social/setup-guides';
import type { PlatformStatus } from '@/lib/social/registry';
import type { SocialAccount } from '@/lib/types';
import { platformLabel } from '@/lib/platform-labels';

interface PlatformRow extends PlatformStatus {
  account: SocialAccount | null;
  guide: SetupGuide | null;
}

/**
 * The Accounts page.
 *
 * Where a platform needs developer setup that no API can do for the user, the
 * full step list is right here with the values to paste — the best possible
 * handoff, rather than a dead "coming soon".
 */
export function AccountsView({
  projectId,
  platforms,
  values,
  storageReady,
  notice,
}: {
  projectId: string;
  platforms: PlatformRow[];
  values: Record<string, string>;
  storageReady: boolean;
  notice: { connected: string | null; error: string | null; reconnect: string | null };
}) {
  const router = useRouter();
  const [open, setOpen] = useState<string | null>(notice.reconnect ?? null);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<Record<string, string>>({});

  async function act(platform: string, action: 'disconnect' | 'verify') {
    setBusy(platform);
    try {
      const res = await fetch('/api/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, platform, action }),
      });
      const json = await res.json();
      setResult({ ...result, [platform]: json.detail ?? (json.disconnected ? 'Disconnected' : '') });
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-8 sm:py-10">
      <span className="label">Accounts</span>
      <h1 className="mt-2 font-display text-3xl font-extrabold tracking-crush text-mist sm:text-4xl">
        Connect once. Then full send.
      </h1>

      {notice.connected && (
        <p className="mt-5 border border-live/40 bg-live/10 px-4 py-3 text-sm text-live">
          {notice.connected} connected. FullSend will publish on schedule.
        </p>
      )}
      {notice.error && (
        <div className="mt-5 border border-fail/50 bg-fail/10 px-4 py-3">
          <p className="text-sm text-fail">{notice.error}</p>
        </div>
      )}

      {!storageReady && (
        <div className="mt-5 border border-warn/50 bg-warn/10 px-4 py-3">
          <p className="font-display text-sm font-bold tracking-tight text-warn">
            Media hosting is not configured
          </p>
          <p className="mt-1 text-sm text-dim">
            Instagram and TikTok fetch media from a public URL, so FullSend needs somewhere to host
            generated creative. Set <Code>NEXT_PUBLIC_SUPABASE_URL</Code> and{' '}
            <Code>SUPABASE_SERVICE_ROLE_KEY</Code>, and create a public storage bucket. Content
            generation works without it; publishing does not.
          </p>
        </div>
      )}

      <div className="mt-8 space-y-5">
        {platforms.map((p) => {
          const account = p.account;
          const connected = account && account.status === 'connected';
          const needsAttention =
            account && ['expired', 'revoked', 'error'].includes(account.status);

          return (
            <section key={p.platform} className="panel overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-4 border-b border-edge p-5">
                <div className="min-w-0">
                  <h2 className="font-display text-xl font-extrabold tracking-tight text-mist">
                    {platformLabel(p.platform)}
                  </h2>
                  {connected ? (
                    <p className="mt-1 flex items-center gap-2 text-sm text-live">
                      <span className="dot-live" />@{account!.username}
                      <span className="font-mono text-[10px] text-dimmer">
                        {account!.followers.toLocaleString()} followers
                      </span>
                    </p>
                  ) : needsAttention ? (
                    <p className="mt-1 text-sm text-fail">
                      {account!.status_detail ?? 'Needs attention'}
                    </p>
                  ) : (
                    <p className="mt-1 text-sm text-dim">
                      {p.configured ? 'Not connected' : 'Developer setup required first'}
                    </p>
                  )}
                </div>

                <div className="flex flex-wrap gap-2">
                  {p.configured ? (
                    <>
                      <a
                        href={`/api/accounts/${p.platform}/connect?project=${projectId}`}
                        className="btn-send !px-4 !py-2 text-xs"
                      >
                        {connected || needsAttention
                          ? `RECONNECT ${platformLabel(p.platform).toUpperCase()}`
                          : `CONNECT ${platformLabel(p.platform).toUpperCase()}`}
                      </a>
                      {connected && (
                        <>
                          <button
                            onClick={() => act(p.platform, 'verify')}
                            disabled={busy === p.platform}
                            className="btn-ghost !px-4 !py-2 text-xs"
                          >
                            VERIFY
                          </button>
                          <button
                            onClick={() => act(p.platform, 'disconnect')}
                            disabled={busy === p.platform}
                            className="btn-ghost !px-4 !py-2 text-xs"
                          >
                            DISCONNECT
                          </button>
                        </>
                      )}
                    </>
                  ) : (
                    <button
                      onClick={() => setOpen(open === p.platform ? null : p.platform)}
                      className="btn-send !px-4 !py-2 text-xs"
                    >
                      {open === p.platform ? 'HIDE SETUP' : 'SET IT UP'}
                    </button>
                  )}
                </div>
              </div>

              {result[p.platform] && (
                <p className="border-b border-edge bg-charcoal-raised px-5 py-2 font-mono text-[11px] text-dim">
                  {result[p.platform]}
                </p>
              )}

              {p.restrictions.length > 0 && (
                <ul className="space-y-1.5 border-b border-edge px-5 py-4">
                  {p.restrictions.map((r) => (
                    <li key={r} className="flex gap-2 text-[13px] leading-relaxed text-dim">
                      <span className="mt-px font-mono text-[10px] text-warn">!</span>
                      {r}
                    </li>
                  ))}
                </ul>
              )}

              {p.guide && (
                <div className="px-5 py-4">
                  <button
                    onClick={() => setOpen(open === p.platform ? null : p.platform)}
                    className="btn-quiet text-xs"
                  >
                    {open === p.platform ? '▾' : '▸'} Developer setup ({p.guide.steps.length} steps)
                  </button>

                  {open === p.platform && (
                    <div className="mt-4">
                      <p className="text-sm leading-relaxed text-dim">{p.guide.summary}</p>
                      <p className="mt-3 border-l-2 border-live/50 pl-3 text-sm text-mist">
                        {p.guide.outcome}
                      </p>

                      <ol className="mt-5 space-y-0">
                        {p.guide.steps.map((step, i) => (
                          <li key={step.title} className="border-t border-edge py-4">
                            <div className="flex items-start gap-3">
                              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-sm bg-charcoal-raised font-mono text-[11px] font-bold text-orange">
                                {i + 1}
                              </span>
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-baseline gap-2">
                                  <h3 className="font-display text-sm font-bold tracking-tight text-mist">
                                    {step.title}
                                  </h3>
                                  {step.waitTime && (
                                    <span className="font-mono text-[10px] uppercase tracking-wider text-warn">
                                      takes {step.waitTime}
                                    </span>
                                  )}
                                </div>
                                <p className="mt-1 text-sm leading-relaxed text-dim">
                                  {step.detail}
                                </p>

                                {step.href && (
                                  <a
                                    href={step.href}
                                    target="_blank"
                                    rel="noreferrer noopener"
                                    className="mt-2 inline-block font-mono text-[11px] text-orange hover:underline"
                                  >
                                    Open →
                                  </a>
                                )}

                                {step.copyValues?.map((cv) => (
                                  <CopyRow
                                    key={cv.valueKey}
                                    label={cv.label}
                                    value={values[cv.valueKey] ?? ''}
                                  />
                                ))}
                              </div>
                            </div>
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}
                </div>
              )}
            </section>
          );
        })}
      </div>

      <p className="mt-8 font-mono text-[11px] leading-relaxed text-dimmer">
        FullSend uses official platform APIs only. It never asks for your password, never scrapes,
        and never automates a browser to get around platform limits. Tokens are encrypted at rest
        and never sent to your browser.
      </p>
    </div>
  );
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-3">
      <p className="label">{label}</p>
      <div className="mt-1 flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate border border-edge bg-void px-2.5 py-1.5 font-mono text-[11px] text-mist">
          {value}
        </code>
        <button
          onClick={() => {
            navigator.clipboard?.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          }}
          className="shrink-0 border border-edge px-2.5 py-1.5 font-mono text-[10px] text-dim transition-colors hover:border-orange hover:text-orange"
        >
          {copied ? 'COPIED' : 'COPY'}
        </button>
      </div>
    </div>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return <code className="font-mono text-[11px] text-mist">{children}</code>;
}
