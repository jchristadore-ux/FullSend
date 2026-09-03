'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { SetupGuide, SetupStep } from '@/lib/social/setup-guides';
import type { PlatformStatus } from '@/lib/social/registry';
import type { PublicSocialAccount } from '@/lib/social/account-view';
import { platformLabel } from '@/lib/platform-labels';

interface PlatformRow extends PlatformStatus {
  account: PublicSocialAccount | null;
  guide: SetupGuide | null;
}

/** One eligible account, offered when a login can reach more than one. */
export interface AccountCandidate {
  externalId: string;
  username: string;
  displayName: string | null;
  followers: number;
}

/**
 * The Accounts page.
 *
 * The shape of this screen is the architecture stated out loud: one
 * application, set up once, and then a Connect button per brand. The developer
 * runbook is still here — somebody has to do it the first time — but it is
 * folded away and labelled as what it is, so the second brand does not read it
 * as a list of things to do again.
 */
export function AccountsView({
  projectId,
  projectName,
  platforms,
  values,
  storageReady,
  notice,
}: {
  projectId: string;
  projectName: string;
  platforms: PlatformRow[];
  values: Record<string, string>;
  storageReady: boolean;
  notice: {
    connected: string | null;
    error: string | null;
    reconnect: string | null;
    choosePlatform: string | null;
    candidates: AccountCandidate[];
  };
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

  const connectHref = (platform: string, externalId?: string) =>
    `/api/accounts/${platform}/connect?project=${projectId}` +
    (externalId ? `&account=${encodeURIComponent(externalId)}` : '');

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

      {/*
        More than one eligible account, so FullSend asked instead of guessing.
        Picking wrong here publishes one brand's calendar to another brand's
        followers, which is not a mistake that can be taken back.
      */}
      {notice.choosePlatform && notice.candidates.length > 0 && (
        <div className="mt-5 border border-orange/50 bg-orange/5 px-4 py-4">
          <p className="font-display text-sm font-bold tracking-tight text-mist">
            Which account should {projectName} publish to?
          </p>
          <p className="mt-1 text-sm text-dim">
            This login can reach more than one Instagram account. FullSend will not choose for you
            — the wrong one posts this brand&apos;s content to someone else&apos;s followers.
          </p>
          <div className="mt-4 space-y-2">
            {notice.candidates.map((c) => (
              <a
                key={c.externalId}
                href={connectHref(notice.choosePlatform!, c.externalId)}
                className="flex items-center justify-between gap-3 border border-edge px-3 py-2.5 transition-colors hover:border-orange"
              >
                <span className="min-w-0">
                  <span className="block truncate font-display text-sm font-bold text-mist">
                    @{c.username || c.externalId}
                  </span>
                  {c.displayName && (
                    <span className="block truncate text-xs text-dim">{c.displayName}</span>
                  )}
                </span>
                <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-orange">
                  Connect
                </span>
              </a>
            ))}
          </div>
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
                      {p.configured
                        ? `Not connected to ${projectName}. The FullSend app is already set up — this is one click.`
                        : 'One-time application setup required first'}
                    </p>
                  )}
                </div>

                <div className="flex flex-wrap gap-2">
                  {p.configured ? (
                    <>
                      <a
                        href={connectHref(p.platform, connected ? account!.external_id : undefined)}
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
                  {/*
                    What a *new brand* has to do, always visible and always
                    short. The developer runbook underneath is the one-time
                    application setup, and saying so is the point: the second
                    account is not a second setup.
                  */}
                  <p className="label">Connecting {projectName}</p>
                  <ol className="mt-2 space-y-2">
                    {p.guide.perAccount.map((step, i) => (
                      <li key={step.title} className="flex gap-3">
                        <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-sm bg-charcoal-raised font-mono text-[10px] font-bold text-orange">
                          {i + 1}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block font-display text-sm font-bold tracking-tight text-mist">
                            {step.title}
                          </span>
                          <span className="block text-[13px] leading-relaxed text-dim">
                            {step.detail}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ol>

                  <button
                    onClick={() => setOpen(open === p.platform ? null : p.platform)}
                    className="btn-quiet mt-4 text-xs"
                  >
                    {open === p.platform ? '▾' : '▸'} One-time application setup (
                    {p.guide.appSetup.length} steps
                    {p.configured ? ', already done for this deployment' : ''})
                  </button>

                  {open === p.platform && (
                    <div className="mt-4">
                      <p className="text-sm leading-relaxed text-dim">{p.guide.summary}</p>
                      <p className="mt-3 border-l-2 border-live/50 pl-3 text-sm text-mist">
                        {p.guide.outcome}
                      </p>

                      <ol className="mt-5 space-y-0">
                        {p.guide.appSetup.map((step, i) => (
                          <Step key={step.title} step={step} index={i} values={values} />
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
        and never automates a browser to get around platform limits. Every account keeps its own
        credentials, encrypted at rest, attached to one brand and never sent to your browser.
      </p>
    </div>
  );
}

function Step({
  step,
  index,
  values,
}: {
  step: SetupStep;
  index: number;
  values: Record<string, string>;
}) {
  return (
    <li className="border-t border-edge py-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-sm bg-charcoal-raised font-mono text-[11px] font-bold text-orange">
          {index + 1}
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
          <p className="mt-1 text-sm leading-relaxed text-dim">{step.detail}</p>

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
            <CopyRow key={cv.valueKey} label={cv.label} value={values[cv.valueKey] ?? ''} />
          ))}
        </div>
      </div>
    </li>
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
