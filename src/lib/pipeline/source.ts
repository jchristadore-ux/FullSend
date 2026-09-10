/**
 * What a project's product source actually is.
 *
 * Three places can answer this and they do not always agree. The project row
 * is the intended answer, a `repositories` row is the GitHub answer, and the
 * analysis job's payload is the answer of last resort — the one that survives
 * when the project row could not record the source in the first place.
 *
 * That last case is not hypothetical. The Supabase driver drops a column the
 * database does not have yet rather than failing the whole write, so a website
 * project created while migration 0007 was pending was stored with no
 * `source_type` and no `website_url`: a project that reads as GitHub, has no
 * repository, and therefore cannot be analysed or retried by any route that
 * trusts the row alone. The founder sees "No repository is attached to this
 * project" on a project they created by pasting a website URL.
 *
 * So the source is resolved from all three, and repaired in the row as soon as
 * the schema can hold it.
 */
import 'server-only';
import { type TenantScope } from '../db';
import { db, getRepository, updateProject } from '../db/repo';
import { canonicalWebsiteUrl } from '../website/url';
import { logger } from '../logger';
import type { Project } from '../types';

const log = logger('pipeline.source');

export type ProjectSource =
  | { kind: 'website'; url: string }
  | { kind: 'github'; repository: string }
  | { kind: 'none' };

/** The websiteUrl / repository the most recent analysis run was given. */
async function sourceFromJobHistory(
  scope: TenantScope,
  projectId: string,
): Promise<ProjectSource> {
  const jobs = await db().find(scope, 'jobs', {
    where: { project_id: projectId, type: 'analyze_repository' },
    orderBy: 'created_at',
    direction: 'desc',
    limit: 5,
  });
  for (const job of jobs) {
    const payload = job.payload ?? {};
    if (payload.websiteUrl) {
      try {
        return { kind: 'website', url: canonicalWebsiteUrl(String(payload.websiteUrl)) };
      } catch {
        /* a payload we cannot parse is not an answer */
      }
    }
    if (payload.repository) return { kind: 'github', repository: String(payload.repository) };
  }
  return { kind: 'none' };
}

/** The project's source, from the row first and its history last. */
export async function resolveProjectSource(
  scope: TenantScope,
  project: Project,
): Promise<ProjectSource> {
  if (project.source_type === 'website' && project.website_url) {
    try {
      return { kind: 'website', url: canonicalWebsiteUrl(project.website_url) };
    } catch {
      /* stored value is unusable — keep looking */
    }
  }

  const repository = await getRepository(scope, project.id);
  if (repository) {
    return { kind: 'github', repository: `${repository.owner}/${repository.name}` };
  }

  return sourceFromJobHistory(scope, project.id);
}

/**
 * Resolves the source and writes it back to the project when the row is wrong.
 *
 * Returns the project as it now stands, so callers can trust `source_type` and
 * `website_url` after this. A repair that cannot land — because the columns
 * still do not exist — leaves the row as it was and says so in the log; the
 * resolved source is returned either way, so the work is never blocked on the
 * repair succeeding.
 */
export async function healProjectSource(
  scope: TenantScope,
  project: Project,
): Promise<{ project: Project; source: ProjectSource }> {
  const source = await resolveProjectSource(scope, project);

  const rowIsWrong =
    source.kind === 'website' &&
    (project.source_type !== 'website' || project.website_url !== source.url);
  if (!rowIsWrong) return { project, source };

  try {
    const updated = await updateProject(scope, project.id, {
      source_type: 'website',
      website_url: source.url,
    });
    if (updated.source_type === 'website' && updated.website_url === source.url) {
      log.info('recorded the website source this project was created with', {
        project: project.id,
        url: source.url,
      });
      return { project: updated, source };
    }
    log.warn('this database cannot record a website source yet', {
      project: project.id,
      remedy: 'Apply supabase/migrations/0007_website_source.sql from the Control Room.',
    });
    return { project: updated, source };
  } catch (e) {
    log.warn('could not record the website source on the project', {
      project: project.id,
      error: e instanceof Error ? e.message : String(e),
    });
    return { project, source };
  }
}
