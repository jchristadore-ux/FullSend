import { redirect } from 'next/navigation';
import { requireSession } from '@/lib/auth/session';
import { activeProject } from '@/lib/active-project';
import { getRepository, getSettings } from '@/lib/db/repo';
import { aiSpend } from '@/lib/ai/client';
import { subscriptionFor, PLANS, billingEnabled } from '@/lib/billing/plans';
import { capabilities } from '@/lib/env';
import { SettingsView } from '@/components/app/SettingsView';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Settings' };

export default async function SettingsPage() {
  const session = await requireSession();
  const project = await activeProject(session);
  if (!project) redirect('/onboarding');

  const [settings, repository, spend, subscription] = await Promise.all([
    getSettings(session.scope, project.id),
    getRepository(session.scope, project.id),
    aiSpend(session.scope, { projectId: project.id }),
    subscriptionFor(session.scope, session.user.id),
  ]);

  return (
    <SettingsView
      project={project}
      settings={settings}
      repository={repository}
      spend={spend}
      plan={{
        tier: subscription.tier,
        name: PLANS[subscription.tier].name,
        billingEnabled: billingEnabled(),
      }}
      capabilities={capabilities()}
      userEmail={session.user.email}
    />
  );
}
