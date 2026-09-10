import 'server-only';
import { cookies } from 'next/headers';
import { getAnalysis, listProjects } from './db/repo';
import { type TenantScope } from './db';
import type { Session } from './auth/session';
import type { Project, ProjectStatus } from './types';

/** Where the switcher records which project the founder is looking at. */
export const ACTIVE_PROJECT_COOKIE = 'fs_project';

/**
 * How far a project actually got through the pipeline.
 *
 * The default used to be `projects[0]` out of a list ordered newest-first,
 * which is the right answer only while there is exactly one project. Send
 * Center now has an "Add app" button, so a second project is one press away —
 * and the moment one existed, the newest and emptiest project won the default
 * slot for every page in the app, because all of them resolve through here.
 *
 * The founder's report of that is "my analysed repo, my content and my
 * calendar are gone". Nothing was gone: the app was pointed at the wrong
 * project. So the fallback is now the project with the most work in it rather
 * than the most recent one, and the switcher pins its choice in a cookie so a
 * later "Add app" cannot quietly take the slot again.
 */
const STATUS_RANK: Record<ProjectStatus, number> = {
  live: 6,
  content_ready: 5,
  strategy_ready: 4,
  analyzed: 3,
  // A paused project is a finished one that was switched off, not an empty one.
  paused: 3,
  analyzing: 2,
  failed: 1,
  created: 0,
};

function rankOf(project: Project): number {
  return STATUS_RANK[project.status] ?? 0;
}

/**
 * The project to show when nobody has chosen one.
 *
 * Ranked by pipeline progress, then by most recent activity, then oldest
 * first — the original project is the one a founder means by "my app".
 */
export function pickDefaultProject(projects: Project[]): Project | null {
  if (projects.length === 0) return null;
  return [...projects].sort(compareForDefault)[0];
}

/** Best default first. Exported ordering so the probe below agrees with it. */
function compareForDefault(a: Project, b: Project): number {
  const byRank = rankOf(b) - rankOf(a);
  if (byRank !== 0) return byRank;
  const byActivity = Date.parse(b.updated_at) - Date.parse(a.updated_at);
  if (byActivity !== 0) return byActivity;
  return Date.parse(a.created_at) - Date.parse(b.created_at);
}

/**
 * Resolves the project a request is about, given the list and the cookie.
 *
 * Split out from `activeProject` so the app layout can reuse the projects it
 * has already loaded instead of querying for them twice.
 */
export async function resolveActiveProject(
  scope: TenantScope,
  projects: Project[],
  chosenId: string | undefined,
): Promise<Project | null> {
  if (projects.length === 0) return null;

  // Never trust the cookie past ownership — listProjects is already scoped.
  const chosen = projects.find((p) => p.id === chosenId);
  if (chosen) return chosen;

  const ordered = [...projects].sort(compareForDefault);
  const best = ordered[0];
  if (rankOf(best) > 0) return best;

  /*
   * Every project claims to be untouched, which is exactly the case where the
   * status column is not to be trusted: a run that died between writing its
   * analysis and updating the project leaves real work behind a `created`
   * status. Ask the database which project has an analysis before falling back
   * to a guess. Only reached when nothing looks established, so the ordinary
   * render pays for none of this.
   */
  for (const project of ordered) {
    try {
      if (await getAnalysis(scope, project.id)) return project;
    } catch {
      // A read that fails here must not blank the app; the guess still stands.
      break;
    }
  }
  return best;
}

/**
 * Resolves which project the current request is about, from the cookie the
 * switcher sets, reusing an already-loaded project list.
 */
export async function activeProjectFrom(
  session: Session,
  projects: Project[],
): Promise<Project | null> {
  const jar = await cookies();
  return resolveActiveProject(session.scope, projects, jar.get(ACTIVE_PROJECT_COOKIE)?.value);
}

/**
 * Resolves which project the current request is about, from the cookie the
 * switcher sets. Falls back to the project with the most work in it so a fresh
 * session — or a newly added second app — still lands on the founder's app.
 */
export async function activeProject(session: Session): Promise<Project | null> {
  const projects = await listProjects(session.scope, session.user.id);
  return activeProjectFrom(session, projects);
}

/**
 * A different project of the founder's that has an analysis, if there is one.
 *
 * Recovery, for the case the fallback above cannot reach: a cookie already
 * pointing at an empty project. The Send Center is then correct and useless —
 * it truthfully reports no analysis, no content and an empty calendar for a
 * project that has none of those things, while the founder's real app sits one
 * switch away. This is what lets the page say so.
 */
export async function otherProjectWithWork(
  session: Session,
  activeId: string,
): Promise<Project | null> {
  const projects = await listProjects(session.scope, session.user.id);
  const others = projects.filter((p) => p.id !== activeId).sort(compareForDefault);
  if (others.length === 0) return null;

  for (const project of others) {
    if (rankOf(project) === 0) continue;
    try {
      if (await getAnalysis(session.scope, project.id)) return project;
    } catch {
      return null;
    }
  }
  return null;
}
