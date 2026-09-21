import Link from 'next/link';

export type FirstRunStepId = 'analyze' | 'connect' | 'plan' | 'first_post';

export interface FirstRunStep {
  id: FirstRunStepId;
  label: string;
  detail: string;
  href: string;
  done: boolean;
}

/**
 * Guided first-run checklist: analyse → connect Instagram → approve plan →
 * first post. Shown when a new account has no project progress or an empty queue.
 */
export function FirstRunGuide({ steps }: { steps: FirstRunStep[] }) {
  const next = steps.find((s) => !s.done) ?? null;
  const allDone = steps.every((s) => s.done);
  if (allDone) return null;

  return (
    <section className="mt-6 border border-orange/40 bg-orange/5 p-5 sm:p-6">
      <span className="label text-orange">FIRST RUN</span>
      <h2 className="mt-2 font-display text-2xl font-extrabold tracking-tight text-mist">
        Get to your first post
      </h2>
      <p className="mt-2 max-w-2xl text-sm text-dim">
        Four steps. Instagram is the production destination today — TikTok stays
        on the roadmap until it is audited for public posting.
      </p>

      <ol className="mt-6 space-y-0">
        {steps.map((step, i) => {
          const active = next?.id === step.id;
          return (
            <li
              key={step.id}
              className={[
                'flex items-start gap-3 border-b border-edge py-3.5 last:border-b-0',
                step.done || active ? 'opacity-100' : 'opacity-45',
              ].join(' ')}
            >
              <span
                className={[
                  'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-sm font-mono text-[11px] font-bold',
                  step.done
                    ? 'bg-live/20 text-live'
                    : active
                      ? 'bg-orange text-void'
                      : 'bg-charcoal text-dimmer',
                ].join(' ')}
              >
                {step.done ? '✓' : String(i + 1)}
              </span>
              <div className="min-w-0 flex-1">
                <p
                  className={[
                    'font-display font-bold tracking-tight',
                    step.done ? 'text-mist' : active ? 'text-orange' : 'text-dimmer',
                  ].join(' ')}
                >
                  {step.label}
                </p>
                <p className="text-sm text-dim">{step.detail}</p>
              </div>
              {active && (
                <Link href={step.href} className="btn-send shrink-0 !px-3 !py-2 text-xs">
                  DO IT →
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export function buildFirstRunSteps(input: {
  hasAnalysis: boolean;
  hasConnectedAccount: boolean;
  strategyApproved: boolean;
  hasContent: boolean;
  hasPublished: boolean;
}): FirstRunStep[] {
  return [
    {
      id: 'analyze',
      label: 'Analyse your product',
      detail: 'Paste a GitHub repo or website so FullSend can read what it actually does.',
      href: '/onboarding',
      done: input.hasAnalysis,
    },
    {
      id: 'connect',
      label: 'Connect Instagram',
      detail: 'Production publishing is Instagram-first. Connect a Business or Creator account.',
      href: '/app/accounts',
      done: input.hasConnectedAccount,
    },
    {
      id: 'plan',
      label: 'Approve the plan',
      detail: 'Review positioning, pillars, and cadence — then approve so content can ship.',
      href: '/app/strategy',
      done: input.strategyApproved,
    },
    {
      id: 'first_post',
      label: 'Ship the first post',
      detail: input.hasContent
        ? 'Review a draft and publish (or schedule) your first Instagram post.'
        : 'Once the plan is approved, FullSend queues drafts — open Content to send the first one.',
      href: '/app/content',
      done: input.hasPublished,
    },
  ];
}
