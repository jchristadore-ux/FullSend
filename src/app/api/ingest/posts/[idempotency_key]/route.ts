import { handleIngestDelete } from '@/lib/ingest/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/** Withdraws an unpublished ingested post. Contract: docs/INGEST.md. */
export async function DELETE(
  req: Request,
  context: { params: Promise<{ idempotency_key: string }> },
): Promise<Response> {
  const { idempotency_key } = await context.params;
  return handleIngestDelete(req, idempotency_key);
}
