/**
 * Finding the run already in progress.
 *
 * The durable checkpoints in `state.ts` only mean anything if the same project
 * is the one being resumed. "Analyze it" used to insert a new project on every
 * press, so the work already saved sat on a project nobody looked at again and
 * the founder correctly reported that FullSend starts over every time.
 */
import 'server-only';
import { type TenantScope } from '../db';
import { db, getRepository, listProjects } from '../db/repo';
import { parseRepoInput } from '../github/client';
import type { Project, Uuid } from '../types';

/**
 * The project already working on this repository, if there is one.
 *
 * Matched on the saved repository row first. A project whose analysis never
 * finished has no such row, so the analysis job it was created with is the
 * other record of which repository it was for — without that, a run that died
 * before its first checkpoint could never be resumed, only duplicated, which
 * is exactly the case a founder retries.
 */
export async function findProjectForRepo(
  scope: TenantScope,
  userId: Uuid,
  repositoryInput: string,
): Promise<Project | null> {
  let wanted: string;
  try {
    const ref = parseRepoInput(repositoryInput);
    wanted = `${ref.owner}/${ref.name}`.toLowerCase();
  } catch {
    return null;
  }

  for (const project of await listProjects(scope, userId)) {
    const repository = await getRepository(scope, project.id);
    if (repository) {
      if (`${repository.owner}/${repository.name}`.toLowerCase() === wanted) return project;
      continue;
    }

    const jobs = await db().find(scope, 'jobs', {
      where: { project_id: project.id, type: 'analyze_repository' },
      orderBy: 'created_at',
      direction: 'desc',
      limit: 1,
    });
    const named = String(jobs[0]?.payload?.repository ?? '').toLowerCase();
    if (named && named === wanted) return project;
  }
  return null;
}
