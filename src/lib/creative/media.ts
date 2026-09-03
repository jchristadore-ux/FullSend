/**
 * Media hosting.
 *
 * Instagram and TikTok both fetch media from a public URL — they will not
 * accept an upload from us, and neither accepts SVG. So generated creative is
 * rasterised to JPEG at the platform's expected dimensions and uploaded to
 * object storage, and the resulting public URL is what gets published.
 *
 * Without storage configured this fails loudly with the exact remedy, because
 * publishing an unreachable URL would fail at the platform anyway.
 *
 * This is the *only* place creative becomes a raster. There used to be two —
 * one writing JPEG at publish time, one writing PNG at scheduling time — and
 * because the scheduler's ran first, the other never did. Two implementations
 * of the same step is two sets of bugs, and only one of them gets fixed.
 *
 * Every raster here is proved before it is stored: the process must be able to
 * draw text at all (see `fonts.ts`), and the image that comes out must not be
 * a flat field of colour. A blank image stored under a public URL is worse
 * than a failure, because everything downstream treats it as a success.
 */
import 'server-only';
import sharp from 'sharp';
import { createClient } from '@supabase/supabase-js';
import { env } from '../env';
import { FullSendError } from '../errors';
import { logger } from '../logger';
import { type TenantScope } from '../db';
import { db } from '../db/repo';
import { assertTextRenderable, ensureFontsConfigured } from './fonts';
import type { CreativeAsset, Uuid } from '../types';

const log = logger('media');

/** Meta accepts JPEG for feed images; keep quality high but under 8MB. */
const JPEG_QUALITY = 88;

/**
 * How much variation an image must show before it counts as having content.
 *
 * A typeset card runs well into the tens; a card that drew its background and
 * nothing else sits near zero. This does not try to be clever — the font probe
 * is what catches missing type. This catches the wider family of "the image is
 * empty", including a card whose copy was empty to begin with.
 */
export const MIN_IMAGE_STDDEV = 1.5;

export async function rasterize(
  svg: string,
  size: { width: number; height: number },
  background = '#08090A',
): Promise<Buffer> {
  // Before anything is drawn: can this process draw text at all? A deployment
  // without fonts renders every card blank, and the whole point is to find
  // that out here rather than on somebody's Instagram feed.
  ensureFontsConfigured();
  await assertTextRenderable();

  const buffer = await sharp(Buffer.from(svg, 'utf8'), { density: 144 })
    .resize(size.width, size.height, { fit: 'contain', background })
    .jpeg({ quality: JPEG_QUALITY, progressive: true, mozjpeg: true })
    .toBuffer();

  await assertNotBlank(buffer);
  return buffer;
}

/**
 * Refuses an image that carries no visible content.
 *
 * Measured on the actual pixels rather than inferred from the SVG, because the
 * failure this exists for happens *during* rasterisation: the markup was
 * correct and the output was empty.
 */
export async function assertNotBlank(image: Buffer): Promise<void> {
  const stats = await sharp(image).stats();
  const spread = Math.max(...stats.channels.map((c) => c.stdev));
  if (spread >= MIN_IMAGE_STDDEV) return;

  throw new FullSendError('creative_blank', 'The rendered creative came out blank', {
    retryable: false,
    remedy:
      'FullSend has held this post rather than publish an empty image. Regenerate the creative ' +
      'from the post, and if it happens again check the Control Room for the creative renderer.',
    meta: { stddev: spread },
  });
}

function storageClient() {
  const { url, serviceRoleKey } = env.supabase;
  if (!url || !serviceRoleKey) {
    throw new FullSendError('storage_not_configured', 'Media storage is not configured', {
      remedy:
        'Instagram and TikTok fetch media from a public URL, so FullSend needs somewhere to host ' +
        'generated creative. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, and ' +
        `create a public bucket named "${env.supabase.storageBucket}".`,
    });
  }
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function storageAvailable(): boolean {
  return Boolean(env.supabase.url && env.supabase.serviceRoleKey);
}

export async function uploadBuffer(
  path: string,
  body: Buffer,
  contentType: string,
): Promise<string> {
  const client = storageClient();
  const bucket = env.supabase.storageBucket;

  const { error } = await client.storage
    .from(bucket)
    .upload(path, body, { contentType, upsert: true, cacheControl: '31536000' });

  if (error) {
    throw new FullSendError('storage_upload_failed', `Could not upload media: ${error.message}`, {
      retryable: true,
      remedy: `Check that the "${bucket}" bucket exists and is public.`,
    });
  }

  const { data } = client.storage.from(bucket).getPublicUrl(path);
  if (!data?.publicUrl) {
    throw new FullSendError('storage_upload_failed', 'Upload succeeded but no public URL returned', {
      remedy: `Make the "${bucket}" bucket public so platforms can fetch the media.`,
    });
  }
  return data.publicUrl;
}

/**
 * Ensures an asset has a URL a platform can fetch, rasterising and uploading on
 * first use. Repo screenshots already have one and pass straight through.
 *
 * The stored URL is also what the product previews, deliberately: the founder
 * sees the file Instagram will fetch, not a browser's more forgiving reading
 * of the same SVG. That is how the blank-card failure stayed invisible for as
 * long as it did.
 */
export async function ensurePublicUrl(
  scope: TenantScope,
  asset: CreativeAsset,
): Promise<string> {
  if (asset.url) return asset.url;
  if (!asset.svg) {
    throw new FullSendError('media_missing', 'This creative asset has no renderable content', {
      remedy: 'Regenerate the creative for this post.',
    });
  }

  const jpeg = await rasterize(asset.svg, { width: asset.width, height: asset.height });
  const path = `${asset.project_id}/${asset.id}.jpg`;
  const url = await uploadBuffer(path, jpeg, 'image/jpeg');

  await db().update(scope, 'creative_assets', asset.id, {
    url,
    storage_path: path,
    mime_type: 'image/jpeg',
  });

  log.info('creative published to storage', { assetId: asset.id, bytes: jpeg.length });
  return url;
}

/**
 * Materialises an asset's public form and hands the updated row back.
 *
 * The scheduler wants the asset, the publisher wants the URL; both go through
 * the same code so a post cannot be scheduled against a raster that publishing
 * would reject.
 */
export async function ensurePublicCreative(
  scope: TenantScope,
  asset: CreativeAsset,
): Promise<CreativeAsset> {
  const url = await ensurePublicUrl(scope, asset);
  if (asset.url === url) return asset;
  return {
    ...asset,
    url,
    storage_path: asset.storage_path ?? `${asset.project_id}/${asset.id}.jpg`,
    mime_type: 'image/jpeg',
  };
}

/** Public URLs for every asset on a post, in slide order. */
export async function publicUrlsFor(
  scope: TenantScope,
  projectId: Uuid,
  assetIds: Uuid[],
): Promise<{ images: string[]; video: string | null; cover: string | null }> {
  const images: string[] = [];
  let video: string | null = null;
  let cover: string | null = null;

  for (const id of assetIds) {
    const asset = await db().get(scope, 'creative_assets', id);
    if (!asset || asset.project_id !== projectId) continue;

    if (asset.kind === 'video') {
      video = asset.url;
      continue;
    }
    const url = await ensurePublicUrl(scope, asset);
    if (asset.kind === 'thumbnail') cover = url;
    else images.push(url);
  }

  return { images, video, cover };
}
