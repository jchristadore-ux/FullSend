import Link from 'next/link';
import { FullSendLockup } from '@/components/brand/Logo';
import { HeroFlow } from '@/components/marketing/HeroFlow';
import { AutopilotPanel } from '@/components/marketing/AutopilotPanel';
import { SignInLink, StartLink } from '@/components/marketing/SessionLinks';

export default function LandingPage() {
  return (
    <main className="min-h-screen bg-void">
      <Nav />
      <Hero />
      <Problem />
      <Solution />
      <HowItWorks />
      <BigMessage />
      <Autopilot />
      <Pricing />
      <FinalCta />
      <Footer />
    </main>
  );
}

/* ── Navigation ─────────────────────────────────────────────────────────── */

function Nav() {
  return (
    <header className="sticky top-0 z-50 border-b border-edge/60 bg-void/85 backdrop-blur-md">
      <nav className="mx-auto flex max-w-7xl items-center justify-between px-5 py-4 sm:px-8">
        <Link href="/" className="flex items-center">
          <FullSendLockup width={148} />
        </Link>
        <div className="flex items-center gap-6">
          <a href="#how" className="hidden text-sm text-dim transition-colors hover:text-mist sm:block">
            How it works
          </a>
          <a href="#pricing" className="hidden text-sm text-dim transition-colors hover:text-mist sm:block">
            Pricing
          </a>
          <SignInLink className="text-sm text-dim transition-colors hover:text-mist" />
          <StartLink className="btn-send !px-4 !py-2 text-sm" />
        </div>
      </nav>
    </header>
  );
}

/* ── Hero ───────────────────────────────────────────────────────────────── */

function Hero() {
  return (
    <section className="relative overflow-hidden border-b border-edge">
      <div className="absolute inset-0 grid-backdrop" />
      <div className="absolute inset-0 orange-bloom" />

      <div className="relative mx-auto max-w-7xl px-5 py-16 sm:px-8 sm:py-24 lg:py-28">
        <div className="grid items-center gap-12 lg:grid-cols-[1.05fr_1fr] lg:gap-16">
          <div className="animate-throttle-in">
            <div className="mb-6 inline-flex items-center gap-2 border border-orange/30 bg-orange/10 px-3 py-1.5">
              <span className="dot-live" />
              <span className="label text-orange">YOUR AI MARKETING EMPLOYEE</span>
            </div>

            <h1 className="font-display text-[13vw] font-extrabold leading-[0.86] tracking-crush text-mist sm:text-7xl lg:text-8xl">
              FullSend.
              <br />
              <span className="text-orange">Everything</span>
              <br />
              goes live.
            </h1>

            <p className="mt-7 max-w-xl font-display text-xl font-bold tracking-tight text-mist sm:text-2xl">
              Give FullSend your app. We&rsquo;ll build the marketing machine.
            </p>

            <p className="mt-4 max-w-xl text-base leading-relaxed text-dim">
              Connect your GitHub repo and FullSend figures out what your product does, who needs
              it, what to say, what to post, where to post it, and when to publish it.
            </p>

            <div className="mt-9 flex flex-col gap-3 sm:flex-row sm:items-center">
              <Link href="/onboarding" className="btn-send text-base">
                SEND IT →
              </Link>
              <a href="#how" className="btn-ghost text-base">
                See how it works
              </a>
            </div>

            <p className="mt-5 font-mono text-xs text-dimmer">
              One command. Everything goes live.
            </p>
          </div>

          <div className="lg:pl-4">
            <HeroFlow />
          </div>
        </div>
      </div>
    </section>
  );
}

/* ── The problem ────────────────────────────────────────────────────────── */

const HATS = [
  'a marketer',
  'a copywriter',
  'a designer',
  'a social-media manager',
  'a video editor',
  'a growth hacker',
  'an analytics nerd',
];

function Problem() {
  return (
    <section className="border-b border-edge">
      <div className="mx-auto max-w-7xl px-5 py-20 sm:px-8 sm:py-28">
        <div className="grid gap-12 lg:grid-cols-2 lg:gap-20">
          <div>
            <span className="label">01 — THE PROBLEM</span>
            <h2 className="mt-5 font-display text-4xl font-extrabold leading-[0.95] tracking-crush text-mist sm:text-5xl">
              Launching an app is easy.
              <br />
              <span className="text-dimmer">Getting anyone to care</span>
              <br />
              is the hard part.
            </h2>

            <div className="mt-10 border-l-2 border-fail/50 pl-5">
              <p className="text-lg leading-relaxed text-dim">
                The repo is done. The bug list is short. And the thing that decides whether any of
                it mattered is a job you never signed up for and have no time to learn.
              </p>
            </div>
          </div>

          <div>
            <p className="text-lg text-dim">You shouldn&rsquo;t need to become:</p>
            <ul className="mt-6 space-y-0">
              {HATS.map((hat) => (
                <li
                  key={hat}
                  className="flex items-center gap-3 border-b border-edge py-3.5 last:border-b-0"
                >
                  <span className="font-mono text-xs text-fail">✗</span>
                  <span className="font-display text-lg font-bold tracking-tight text-mist">
                    {hat}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-6 text-lg text-dim">
              just to get your product in front of people.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ── The solution ───────────────────────────────────────────────────────── */

function Solution() {
  return (
    <section className="relative overflow-hidden border-b border-edge bg-ink">
      <div className="absolute inset-0 grid-backdrop opacity-60" />
      <div className="relative mx-auto max-w-7xl px-5 py-20 sm:px-8 sm:py-28">
        <span className="label">02 — THE FULLSEND SOLUTION</span>

        <h2 className="mt-5 max-w-4xl font-display text-4xl font-extrabold leading-[0.95] tracking-crush text-mist sm:text-6xl">
          You build the product.
          <br />
          <span className="text-orange">FullSend builds the audience.</span>
        </h2>

        <p className="mt-7 max-w-2xl text-lg leading-relaxed text-dim">
          FullSend doesn&rsquo;t write you a marketing plan and wish you luck. It takes the product
          itself — the actual code, the actual features, the actual screens — and turns it into an
          ongoing marketing engine that runs whether or not you&rsquo;re paying attention.
        </p>

        <div className="mt-14 grid gap-px overflow-hidden border border-edge bg-edge sm:grid-cols-3">
          {[
            {
              title: 'It reads your repo',
              body: 'Not a form you fill in. FullSend reads the code, the README, the routes and the screenshots, and works out what your product genuinely does.',
            },
            {
              title: 'It has an opinion',
              body: 'It decides what to post and when, based on what your audience actually responded to last week. It tells you what it decided — it doesn’t ask you to decide.',
            },
            {
              title: 'It keeps running',
              body: 'Generate, schedule, publish, measure, adjust. Every day. Your browser doesn’t need to be open, and neither do your eyes.',
            },
          ].map((card) => (
            <div key={card.title} className="bg-charcoal p-7">
              <h3 className="font-display text-xl font-extrabold tracking-tight text-mist">
                {card.title}
              </h3>
              <p className="mt-3 text-sm leading-relaxed text-dim">{card.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ── How it works ───────────────────────────────────────────────────────── */

const STEPS = [
  {
    n: '01',
    title: 'Drop in your repo.',
    body: 'Paste your GitHub repository. FullSend analyzes your product.',
    items: [],
  },
  {
    n: '02',
    title: 'We figure out what to say.',
    body: 'FullSend identifies:',
    items: [
      'target audience',
      'personas',
      'pain points',
      'positioning',
      'differentiators',
      'content opportunities',
    ],
  },
  {
    n: '03',
    title: 'We build the machine.',
    body: 'FullSend creates:',
    items: [
      'marketing strategy',
      'content pillars',
      'campaigns',
      'posts',
      'videos',
      'captions',
      'graphics',
      'hashtags',
    ],
  },
  {
    n: '04',
    title: 'Connect your accounts.',
    body: 'Connect:',
    items: ['Instagram', 'TikTok', 'additional platforms as supported'],
  },
  {
    n: '05',
    title: 'FullSend.',
    body: 'And then it just runs:',
    items: ['Schedule.', 'Publish.', 'Analyze.', 'Optimize.', 'Repeat.'],
  },
];

function HowItWorks() {
  return (
    <section id="how" className="border-b border-edge">
      <div className="mx-auto max-w-7xl px-5 py-20 sm:px-8 sm:py-28">
        <span className="label">03 — HOW IT WORKS</span>
        <h2 className="mt-5 font-display text-4xl font-extrabold tracking-crush text-mist sm:text-6xl">
          Five steps. Then never again.
        </h2>

        <div className="mt-14 space-y-px bg-edge">
          {STEPS.map((step) => (
            <div
              key={step.n}
              className="grid gap-6 bg-void p-7 sm:grid-cols-[auto_1fr] sm:gap-10 sm:p-9"
            >
              <div className="font-display text-5xl font-extrabold tracking-crush text-orange sm:text-6xl">
                {step.n}
              </div>
              <div>
                <h3 className="font-display text-2xl font-extrabold tracking-tight text-mist sm:text-3xl">
                  {step.title}
                </h3>
                <p className="mt-2 text-dim">{step.body}</p>
                {step.items.length > 0 && (
                  <ul className="mt-4 flex flex-wrap gap-2">
                    {step.items.map((item) => (
                      <li
                        key={item}
                        className="border border-edge bg-charcoal px-3 py-1.5 font-mono text-xs text-mist"
                      >
                        {item}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ── The big message ────────────────────────────────────────────────────── */

function BigMessage() {
  return (
    <section className="relative overflow-hidden border-b border-edge bg-orange">
      <div className="relative mx-auto max-w-6xl px-5 py-24 text-center sm:px-8 sm:py-32">
        <h2 className="font-display text-[11vw] font-extrabold leading-[0.85] tracking-crush text-void sm:text-7xl lg:text-8xl">
          Stop building apps
          <br />
          nobody knows exist.
        </h2>
        <p className="mx-auto mt-8 max-w-2xl font-display text-xl font-bold tracking-tight text-void/80 sm:text-2xl">
          Your app doesn&rsquo;t need another feature right now. It needs attention.
        </p>
        <Link
          href="/onboarding"
          className="mt-10 inline-flex items-center justify-center gap-2 rounded-sm bg-void px-8 py-4 font-display text-lg font-extrabold uppercase tracking-tight text-orange transition-transform duration-150 hover:scale-[1.02] active:translate-y-px"
        >
          FULL SEND →
        </Link>
      </div>
    </section>
  );
}

/* ── Autopilot ──────────────────────────────────────────────────────────── */

function Autopilot() {
  return (
    <section className="border-b border-edge">
      <div className="mx-auto max-w-7xl px-5 py-20 sm:px-8 sm:py-28">
        <div className="grid items-center gap-14 lg:grid-cols-2 lg:gap-20">
          <div>
            <span className="label">04 — AUTOPILOT</span>
            <h2 className="mt-5 font-display text-5xl font-extrabold leading-[0.9] tracking-crush text-mist sm:text-6xl">
              TURN IT ONCE.
              <br />
              <span className="text-orange">LET IT RUN.</span>
            </h2>
            <p className="mt-7 text-lg leading-relaxed text-dim">
              FullSend doesn&rsquo;t just create your first batch of content. It watches what works
              and adjusts what comes next — shifting the mix toward the formats your audience
              actually responds to, and telling you what it changed.
            </p>
            <div className="mt-8 border-l-2 border-orange bg-charcoal p-5">
              <p className="font-display text-lg font-bold tracking-tight text-mist">
                &ldquo;Product-demo Reels are outperforming educational posts by 41%. I&rsquo;m
                increasing demo content next week.&rdquo;
              </p>
              <p className="mt-2 font-mono text-xs text-dimmer">— FULLSEND, LAST TUESDAY</p>
            </div>
          </div>

          <AutopilotPanel />
        </div>
      </div>
    </section>
  );
}

/* ── Pricing ────────────────────────────────────────────────────────────── */

const TIERS = [
  {
    name: 'FREE',
    price: '$0',
    tagline: 'See it work',
    features: ['1 project', 'Repo analysis + strategy', '10 posts / month', 'Manual approval'],
    cta: 'Start free',
    highlight: false,
  },
  {
    name: 'SEND',
    price: '$29',
    tagline: 'Content on tap',
    features: ['1 project', 'Automated content', '60 posts / month', 'Instagram + TikTok', 'Hybrid autopilot'],
    cta: 'Start sending',
    highlight: false,
  },
  {
    name: 'FULL SEND',
    price: '$79',
    tagline: 'Turn it on, walk away',
    features: [
      '1 project',
      'Unlimited posts',
      'All platforms',
      'Full Send autopilot',
      'Weekly optimization',
      'Send Score + reporting',
    ],
    cta: 'FULL SEND →',
    highlight: true,
  },
  {
    name: 'AGENCY',
    price: '$249',
    tagline: 'Every client, running',
    features: ['10 projects', 'Everything in Full Send', 'Per-client reporting', 'Priority support'],
    cta: 'Talk to us',
    highlight: false,
  },
];

function Pricing() {
  return (
    <section id="pricing" className="border-b border-edge bg-ink">
      <div className="mx-auto max-w-7xl px-5 py-20 sm:px-8 sm:py-28">
        <span className="label">05 — PRICING</span>
        <h2 className="mt-5 font-display text-4xl font-extrabold tracking-crush text-mist sm:text-5xl">
          Cheaper than a freelancer&rsquo;s first invoice.
        </h2>

        <div className="mt-12 grid gap-px bg-edge lg:grid-cols-4">
          {TIERS.map((tier) => (
            <div
              key={tier.name}
              className={[
                'relative flex flex-col p-7',
                tier.highlight ? 'bg-charcoal-raised ring-1 ring-inset ring-orange' : 'bg-charcoal',
              ].join(' ')}
            >
              {tier.highlight && (
                <span className="absolute -top-px right-5 bg-orange px-2 py-1 font-mono text-[10px] font-bold tracking-widest text-void">
                  RECOMMENDED
                </span>
              )}
              <h3 className="font-display text-xl font-extrabold tracking-tight text-mist">
                {tier.name}
              </h3>
              <p className="mt-1 font-mono text-xs text-dimmer">{tier.tagline}</p>
              <p className="mt-5 font-display text-4xl font-extrabold tracking-crush text-mist">
                {tier.price}
                <span className="font-sans text-sm font-medium text-dimmer">/mo</span>
              </p>
              <ul className="mt-6 flex-1 space-y-2.5">
                {tier.features.map((f) => (
                  <li key={f} className="flex items-start gap-2.5 text-sm text-dim">
                    <span className="mt-0.5 font-mono text-xs text-orange">›</span>
                    {f}
                  </li>
                ))}
              </ul>
              <Link
                href="/onboarding"
                className={tier.highlight ? 'btn-send mt-7 w-full' : 'btn-ghost mt-7 w-full'}
              >
                {tier.cta}
              </Link>
            </div>
          ))}
        </div>

        <p className="mt-6 font-mono text-xs text-dimmer">
          Billing is Stripe-ready and switched off by default — run the whole product without it.
        </p>
      </div>
    </section>
  );
}

/* ── Close ──────────────────────────────────────────────────────────────── */

function FinalCta() {
  return (
    <section className="relative overflow-hidden border-b border-edge">
      <div className="absolute inset-0 grid-backdrop" />
      <div className="absolute inset-0 orange-bloom" />
      <div className="relative mx-auto max-w-4xl px-5 py-24 text-center sm:px-8 sm:py-32">
        <h2 className="font-display text-5xl font-extrabold leading-[0.9] tracking-crush text-mist sm:text-7xl">
          Ready to send?
        </h2>
        <p className="mt-6 text-lg text-dim">
          Paste a repo. Watch it figure out your product. Decide if you believe it.
        </p>
        <Link href="/onboarding" className="btn-send mt-9 text-lg">
          SEND IT →
        </Link>
        <p className="mt-6 font-mono text-xs text-dimmer">
          BUILD ONCE. MARKET FOREVER.
        </p>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="bg-void">
      <div className="mx-auto max-w-7xl px-5 py-12 sm:px-8">
        <div className="flex flex-col items-start justify-between gap-6 sm:flex-row sm:items-center">
          <FullSendLockup width={132} />
          <div className="flex flex-wrap gap-6 font-mono text-xs text-dimmer">
            <a href="#how" className="transition-colors hover:text-mist">
              How it works
            </a>
            <a href="#pricing" className="transition-colors hover:text-mist">
              Pricing
            </a>
            <SignInLink className="transition-colors hover:text-mist" />
          </div>
        </div>
        <p className="mt-8 border-t border-edge pt-8 font-mono text-xs text-dimmer">
          FullSend. Everything goes live.
        </p>
      </div>
    </footer>
  );
}
