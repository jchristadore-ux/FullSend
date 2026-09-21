'use client';

import Link from 'next/link';
import { useState } from 'react';

interface DemoResult {
  source: { kind: 'github' | 'website'; label: string; url: string };
  analysis: {
    one_liner: string;
    what_it_does: string;
    category: string;
    features: { name: string; description: string }[];
    not_capabilities: string[];
    tech_stack: string[];
    confidence: number;
  };
  samplePost: {
    hook: string;
    caption: string;
    cta: string;
    hashtags: string[];
    format: string;
    platform: string;
  };
  publishBlocked: true;
  publishWall: { title: string; body: string; ctaLabel: string; ctaHref: string };
}

/** No-signup demo: paste a public repo, see intelligence + a sample post, hit the publish wall. */
export function InteractiveDemo() {
  const [source, setSource] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remedy, setRemedy] = useState<string | null>(null);
  const [result, setResult] = useState<DemoResult | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setRemedy(null);
    setResult(null);
    setLoading(true);
    try {
      const res = await fetch('/api/demo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.message ?? 'Demo failed');
        setRemedy(json.remedy ?? null);
        return;
      }
      setResult(json as DemoResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <section id="demo" className="border-b border-edge bg-ink">
      <div className="mx-auto max-w-7xl px-5 py-20 sm:px-8 sm:py-28">
        <span className="label">TRY IT — NO SIGNUP</span>
        <h2 className="mt-5 max-w-3xl font-display text-4xl font-extrabold leading-[0.95] tracking-crush text-mist sm:text-5xl">
          Paste a public repo.
          <br />
          <span className="text-orange">See the machine think.</span>
        </h2>
        <p className="mt-5 max-w-2xl text-lg text-dim">
          FullSend reads the product, writes a sample Instagram post, and stops at
          publish. No account. Heavily rate-limited. Private repos and internal
          URLs are blocked.
        </p>

        <form onSubmit={onSubmit} className="mt-10 max-w-2xl">
          <label htmlFor="demo-source" className="label">
            Public GitHub URL or website
          </label>
          <div className="mt-2 flex flex-col gap-3 sm:flex-row">
            <input
              id="demo-source"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="https://github.com/you/your-app"
              autoComplete="off"
              spellCheck={false}
              className="w-full flex-1 !px-4 !py-3 font-mono text-sm"
              disabled={loading}
            />
            <button type="submit" disabled={loading || source.trim().length < 3} className="btn-send shrink-0">
              {loading ? 'READING…' : 'RUN DEMO →'}
            </button>
          </div>
          {error && (
            <div className="mt-4 border border-fail/50 bg-fail/10 px-4 py-3">
              <p className="text-sm font-semibold text-fail">{error}</p>
              {remedy && <p className="mt-1 text-sm text-dim">{remedy}</p>}
            </div>
          )}
        </form>

        {result && (
          <div className="mt-12 grid gap-6 lg:grid-cols-2">
            <div className="panel p-6">
              <span className="label text-live">PRODUCT INTELLIGENCE</span>
              <p className="mt-1 font-mono text-[10px] text-dimmer">
                {result.source.kind} · {result.source.label}
              </p>
              <p className="mt-4 font-display text-2xl font-extrabold tracking-tight text-mist">
                {result.analysis.one_liner}
              </p>
              <p className="mt-3 text-sm leading-relaxed text-dim">{result.analysis.what_it_does}</p>
              <dl className="mt-5 grid gap-3 border-t border-edge pt-4 sm:grid-cols-2">
                <div>
                  <dt className="label">Category</dt>
                  <dd className="mt-0.5 text-sm text-mist">{result.analysis.category}</dd>
                </div>
                <div>
                  <dt className="label">Confidence</dt>
                  <dd className="mt-0.5 text-sm text-mist">
                    {Math.round(result.analysis.confidence * 100)}%
                  </dd>
                </div>
              </dl>
              {result.analysis.features.length > 0 && (
                <ul className="mt-5 space-y-2">
                  {result.analysis.features.slice(0, 4).map((f) => (
                    <li key={f.name} className="border-l-2 border-orange/50 pl-3">
                      <p className="text-sm font-semibold text-mist">{f.name}</p>
                      <p className="text-xs text-dim">{f.description}</p>
                    </li>
                  ))}
                </ul>
              )}
              {result.analysis.not_capabilities.length > 0 && (
                <p className="mt-4 font-mono text-[11px] text-dimmer">
                  Will not claim: {result.analysis.not_capabilities[0]}
                </p>
              )}
            </div>

            <div className="panel p-6">
              <span className="label text-orange">SAMPLE INSTAGRAM POST</span>
              <p className="mt-3 font-display text-lg font-extrabold tracking-tight text-mist">
                {result.samplePost.hook}
              </p>
              <p className="mt-4 whitespace-pre-wrap text-sm leading-relaxed text-mist">
                {result.samplePost.caption}
              </p>
              <p className="mt-4 font-mono text-[11px] text-dimmer">
                {result.samplePost.hashtags.join(' ')}
              </p>
              <div className="mt-8 border border-warn/40 bg-warn/10 p-5">
                <p className="font-display text-lg font-extrabold tracking-tight text-warn">
                  {result.publishWall.title}
                </p>
                <p className="mt-2 text-sm text-dim">{result.publishWall.body}</p>
                <Link href={result.publishWall.ctaHref} className="btn-send mt-5 inline-flex">
                  {result.publishWall.ctaLabel}
                </Link>
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
