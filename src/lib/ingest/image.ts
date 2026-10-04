/**
 * Bringing a sender's card into FullSend's own storage.
 *
 * Instagram fetches media from a URL at publish time, possibly days after the
 * post was sent. Pointing it at the sender's URL would make every publish
 * depend on another app's hosting staying put, so the image is copied into the
 * FullSend creative bucket at ingest time and only our copy is published.
 *
 * Instagram feed images must be JPEG, so the PNG is flattened and re-encoded.
 * The fetch is guarded exactly like website ingestion: https only, public
 * addresses only, every redirect hop re-checked, hard time and size caps.
 */
import 'server-only';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { assertSafePublicUrl } from '../website/ssrf';
import { isFullSendError } from '../errors';
import { IngestError } from './errors';

const MAX_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;
/** Instagram feed aspect-ratio limits (width / height). */
const MIN_ASPECT = 0.8 - 0.01;
const MAX_ASPECT = 1.91 + 0.01;
const MAX_WIDTH = 1440;

export async function fetchIngestImage(imageUrl: string): Promise<Buffer> {
  let current: URL;
  try {
    current = await assertSafePublicUrl(imageUrl);
  } catch (e) {
    throw new IngestError(400, 'invalid_image_url', isFullSendError(e) ? e.message : 'image_url is not fetchable');
  }
  if (current.protocol !== 'https:') {
    throw new IngestError(400, 'invalid_image_url', 'image_url must be https');
  }

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let res: Response;
    try {
      res = await fetch(current, {
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { Accept: 'image/png,image/jpeg,image/*;q=0.8' },
      });
    } catch {
      throw new IngestError(502, 'image_fetch_failed', 'Could not download image_url (network error or timeout)');
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw new IngestError(400, 'image_fetch_failed', 'image_url redirected without a Location');
      try {
        current = await assertSafePublicUrl(new URL(location, current).href);
      } catch (e) {
        throw new IngestError(400, 'invalid_image_url', isFullSendError(e) ? e.message : 'Redirect target refused');
      }
      if (current.protocol !== 'https:') {
        throw new IngestError(400, 'invalid_image_url', 'image_url redirected to a non-https address');
      }
      continue;
    }
    if (res.status >= 500 || res.status === 429) {
      throw new IngestError(502, 'image_fetch_failed', `image_url responded ${res.status}`);
    }
    if (!res.ok) {
      throw new IngestError(400, 'image_unavailable', `image_url responded ${res.status}`);
    }
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > MAX_BYTES) throw new IngestError(400, 'image_too_large', `Image exceeds ${MAX_BYTES} bytes`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new IngestError(400, 'image_too_large', `Image exceeds ${MAX_BYTES} bytes`);
    if (buf.length === 0) throw new IngestError(400, 'image_unavailable', 'image_url returned an empty body');
    return buf;
  }
  throw new IngestError(400, 'image_fetch_failed', 'image_url redirected too many times');
}

export interface NormalizedImage {
  jpeg: Buffer;
  width: number;
  height: number;
  /** sha256 of the source bytes — names the stored file so an update busts caches. */
  sourceHash: string;
}

export async function normalizeIngestImage(source: Buffer, background = '#000000'): Promise<NormalizedImage> {
  let meta: Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>>;
  try {
    meta = await sharp(source).metadata();
  } catch {
    throw new IngestError(400, 'invalid_image', 'image_url did not return a readable image');
  }
  if (!meta.format || !['png', 'jpeg', 'webp'].includes(meta.format)) {
    throw new IngestError(400, 'invalid_image', `Unsupported image format: ${meta.format ?? 'unknown'} (send PNG)`);
  }
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width < 320 || height < 320) {
    throw new IngestError(400, 'invalid_image', `Image is too small (${width}x${height}); send 1080x1350`);
  }
  const aspect = width / height;
  if (aspect < MIN_ASPECT || aspect > MAX_ASPECT) {
    throw new IngestError(
      400,
      'invalid_image',
      `Image aspect ratio ${width}x${height} is outside Instagram's 4:5 to 1.91:1 range; send 1080x1350`,
    );
  }

  let pipeline = sharp(source).flatten({ background });
  if (width > MAX_WIDTH) pipeline = pipeline.resize({ width: 1080 });
  const { data, info } = await pipeline
    .jpeg({ quality: 92, progressive: true, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });

  return {
    jpeg: data,
    width: info.width,
    height: info.height,
    sourceHash: createHash('sha256').update(source).digest('hex'),
  };
}
