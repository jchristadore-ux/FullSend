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
 */
import 'server-only';
import sharp from 'sharp';
import { createClient } from '@supabase/supabase-js';
import { env } from '../env';
import { FullSendError } from '../errors';
import { logger } from '../logger';
import { type TenantScope } from '../db';
import { db } from '../db/repo';
import type { CreativeAsset, Uuid } from '../types';

const log = logger('media');

/** Meta accepts JPEG for feed images; keep quality high but under 8MB. */
const JPEG_QUALITY = 88;

export async function rasterize(
  svg: string,
  size: { width: number; height: number },
  background = '#08090A',
): Promise<Buffer> {
  return sharp(Buffer.from(svg, 'utf8'), { density: 144 })
    .resize(size.width, size.height, { fit: 'contain', background })
    .jpeg({ quality: JPEG_QUALITY, progressive: true, mozjpeg: true })
    .toBuffer();
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
