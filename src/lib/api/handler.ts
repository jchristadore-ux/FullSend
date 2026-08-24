/**
 * API route plumbing.
 *
 * Wraps a handler with auth, rate limiting, tenant resolution and consistent
 * error shaping, so no route has to remember to do any of it. Errors surface as
 * `{ error, message, remedy }` — the remedy is what the UI shows the founder.
 */
import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { FullSendError, isFullSendError } from '../errors';
import { logger } from '../logger';
import { check, LIMITS, type LimitRule } from '../rate-limit';
import { requireSession, type Session } from '../auth/session';
import { getProject } from '../db/repo';
import type { Project } from '../types';

const log = logger('api');

export interface Ctx<B = unknown> {
  req: NextRequest;
  session: Session;
  body: B;
  params: Record<string, string>;
}

export interface ProjectCtx<B = unknown> extends Ctx<B> {
  project: Project;
}

interface Options<B> {
  /** Validates the JSON body. Omit for GET routes. */
  schema?: z.ZodType<B>;
  rateLimit?: LimitRule;
  /** Key suffix for the limiter, so limits are per-user not global. */
  rateLimitKey?: string;
}

export function route<B = unknown>(
  handler: (ctx: Ctx<B>) => Promise<unknown>,
  opts: Options<B> = {},
) {
  return async (
    req: NextRequest,
    context: { params: Promise<Record<string, string>> },
  ): Promise<NextResponse> => {
    try {
      const session = await requireSession();
      const params = context?.params ? await context.params : {};

      if (opts.rateLimit) {
        check(`${opts.rateLimitKey ?? 'api'}:${session.user.id}`, opts.rateLimit);
      }

      let body = undefined as B;
      if (opts.schema) {
        const raw = await readJson(req);
        const parsed = opts.schema.safeParse(raw);
        if (!parsed.success) {
          throw new FullSendError('invalid_input', firstIssue(parsed.error), {
            status: 400,
            remedy: 'Check the highlighted field and try again.',
          });
        }
        body = parsed.data;
      }

      const result = await handler({ req, session, body, params });
      // A handler may return its own Response (to set a status or cookies);
      // pass it straight through rather than serialising it into a body.
      if (result instanceof Response) return result as NextResponse;
      return NextResponse.json(result ?? { ok: true });
    } catch (e) {
      return errorResponse(e, req);
    }
  };
}

/** Same as `route`, but resolves and authorises `params.projectId` first. */
export function projectRoute<B = unknown>(
  handler: (ctx: ProjectCtx<B>) => Promise<unknown>,
  opts: Options<B> = {},
) {
  return route<B>(async (ctx) => {
    const projectId = ctx.params.projectId ?? ctx.params.id;
    if (!projectId) throw new FullSendError('invalid_input', 'No project specified', { status: 400 });

    const project = await getProject(ctx.session.scope, projectId);
    if (!project) {
      throw new FullSendError('not_found', 'Project not found', { status: 404 });
    }
    return handler({ ...ctx, project });
  }, opts);
}

async function readJson(req: NextRequest): Promise<unknown> {
  try {
    const text = await req.text();
    return text ? JSON.parse(text) : {};
  } catch {
    throw new FullSendError('invalid_input', 'Request body was not valid JSON', { status: 400 });
  }
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'Invalid input';
  const path = issue.path.join('.');
  return path ? `${path}: ${issue.message}` : issue.message;
}

export function errorResponse(e: unknown, req?: NextRequest): NextResponse {
  if (isFullSendError(e)) {
    if (e.status >= 500) {
      log.error('request failed', { code: e.code, message: e.message, path: req?.nextUrl.pathname });
    }
    return NextResponse.json(e.toJSON(), { status: e.status });
  }

  log.error('unhandled request error', {
    error: e instanceof Error ? e.message : String(e),
    path: req?.nextUrl.pathname,
  });
  return NextResponse.json(
    {
      error: 'internal_error',
      message: 'Something went wrong on our side',
      remedy: 'Try again. If it keeps happening, check the FullSend Control Room for details.',
      retryable: true,
    },
    { status: 500 },
  );
}

export { LIMITS };
