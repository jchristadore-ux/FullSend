/**
 * What the Send Center claims about a project.
 *
 * The headline and the status dot are the first things a founder reads, and
 * they were driven by the autopilot *setting* rather than the project's state:
 * a project whose analysis had died still reported "AUTOPILOT ACTIVE / Your
 * marketing is running." above an empty dashboard. A page that is confidently
 * wrong at the top is worse than one that says nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProject, setupContext, teardown, type TestContext } from './helpers';
import { loadSendCenter } from '@/lib/dashboard';
import type { ProjectStatus } from '@/lib/types';

describe('autopilot status', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupContext();
  });

  afterEach(() => teardown());

  async function running(status: ProjectStatus, mode: 'manual' | 'full_send' = 'full_send') {
    const project = await createProject(ctx.scope, ctx.user.id, {
      status,
      autopilot_mode: mode,
    });
    const data = await loadSendCenter(ctx.scope, project);
    return data.autopilotOn;
  }

  it('does not claim marketing is running when the analysis failed', async () => {
    expect(await running('failed')).toBe(false);
  });

  it('does not claim marketing is running before anything has been analysed', async () => {
    expect(await running('created')).toBe(false);
  });

  it('still reports paused as paused', async () => {
    expect(await running('paused')).toBe(false);
  });

  it('reports running once the project is live', async () => {
    expect(await running('live')).toBe(true);
  });

  it('counts a project mid-analysis as running', async () => {
    expect(await running('analyzing')).toBe(true);
  });

  it('respects manual mode whatever the status', async () => {
    expect(await running('live', 'manual')).toBe(false);
  });
});
