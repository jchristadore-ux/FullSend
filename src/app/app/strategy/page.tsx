import { redirect } from 'next/navigation';
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
    return (
      <div className="mx-auto max-w-3xl px-4 py-16 sm:px-8">
        <span className="label">Marketing Strategy</span>
        <h1 className="mt-3 font-display text-3xl font-extrabold tracking-crush text-mist">
          Not built yet.
        </h1>
        <p className="mt-3 text-dim">
          {analysis
            ? 'The analysis is done — the strategy is still being generated. Give it a moment and refresh.'
            : 'FullSend needs to analyse your repository first.'}
        </p>
      </div>
    );
  }

  return (
    <StrategyView
      projectId={project.id}
      projectName={project.name}
      strategy={strategy}
      pillars={pillars}
      campaigns={campaigns}
      brand={brand}
      personas={personas}
    />
  );
}
