import { handleIngestPost } from '@/lib/ingest/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Signed ingest from The Brovisional. Contract: docs/INGEST.md. */
export async function POST(req: Request): Promise<Response> {
  return handleIngestPost(req);
}
