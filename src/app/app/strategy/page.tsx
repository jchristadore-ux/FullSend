import { redirect } from 'next/navigation';
import Link from 'next/link';
import { requireSession } from '@/lib/auth/session';
import { activeProject } from '@/lib/active-project';
import {
  getAnalysis,
  getBrandProfile,
  getStrategy,
  listCampaigns,
  listPersonas,
  listPillars,
} from '@/lib/db/repo';
import { StrategyView } from '@/components/app/StrategyView';
import { BrandIdentityPanel } from '@/components/app/BrandIdentityPanel';
import { StrategyWaiting } from '@/components/app/StrategyWaiting';
import { identityFrom } from '@/lib/brand/identity';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Marketing Strategy' };

export default async function StrategyPage() {
  const session = await requireSession();
  const project = await activeProject(session);
  if (!project) redirect('/onboarding');

  const [strategy, pillars, campaigns, brand, personas, analysis] = await Promise.all([
    getStrategy(session.scope, project.id),
    listPillars(session.scope, project.id),
    listCampaigns(session.scope, project.id),
    getBrandProfile(session.scope, project.id),
    listPersonas(session.scope, project.id),
    getAnalysis(session.scope, project.id),
  ]);

  if (!strategy) {
    if (analysis) return <StrategyWaiting />;
    return (
      <div className="mx-auto max-w-3xl px-4 py-16 sm:px-8">
        <span className="label">Marketing Strategy</span>
        <h1 className="mt-3 font-display text-3xl font-extrabold tracking-crush text-mist">
          Not built yet.
        </h1>
        <p className="mt-3 text-dim">FullSend needs to analyse your repository first.</p>
        <p className="mt-6">
          <Link href="/onboarding" className="btn-send !px-4 !py-2 text-xs">
            ANALYSE THE REPO →
          </Link>
        </p>
        <p className="mt-4">
          <Link href="/app" className="font-mono text-[11px] text-orange hover:underline">
            Or open the Send Center →
          </Link>
        </p>
      </div>
    );
  }

  const identity = identityFrom(analysis);

  return (
    <>
      <StrategyView
        projectId={project.id}
        projectName={project.name}
        strategy={strategy}
        pillars={pillars}
        campaigns={campaigns}
        brand={brand}
        personas={personas}
      />
      <div className="mx-auto max-w-5xl px-4 pb-16 sm:px-8">
        <BrandIdentityPanel
          projectId={project.id}
          projectName={project.name}
          brand={brand}
          discovery={
            identity
              ? {
                  read_from: identity.evidence.style_files,
                  not_found: identity.evidence.unresolved,
                }
              : null
          }
        />
      </div>
    </>
  );
}
