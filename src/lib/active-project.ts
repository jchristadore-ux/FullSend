import 'server-only';
import { cookies } from 'next/headers';
import { listProjects } from './db/repo';
import type { Session } from './auth/session';
import type { Project } from './types';

/**
 * Resolves which project the current request is about, from the cookie the
 * switcher sets. Falls back to the first project so a fresh session works.
 */
export async function activeProject(session: Session): Promise<Project | null> {
  const projects = await listProjects(session.scope, session.user.id);
  if (projects.length === 0) return null;

  const jar = await cookies();
  const id = jar.get('fs_project')?.value;
  // Never trust the cookie past ownership — listProjects is already scoped.
  return projects.find((p) => p.id === id) ?? projects[0];
}
