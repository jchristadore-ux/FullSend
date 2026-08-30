import 'server-only';
import { createClient } from '@supabase/supabase-js';
import sharp from 'sharp';
import { env } from '../env';
import { FullSendError } from '../errors';
import type { CreativeAsset } from '../types';

export async function ensurePublicCreative(asset: CreativeAsset): Promise<CreativeAsset> {
  if (asset.url) return asset;
  if (!asset.svg) throw new FullSendError('media_missing', 'Creative asset has no publishable media', { retryable: false, remedy: 'Regenerate the creative asset.' });
  if (!env.supabase.url || !env.supabase.serviceRoleKey) {
    throw new FullSendError('storage_not_configured', 'Public creative storage is not configured', { retryable: false, remedy: 'Configure NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, then run the storage migration.' });
  }
  const client = createClient(env.supabase.url, env.supabase.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const path = asset.storage_path ?? `projects/${asset.project_id}/creative/${asset.id}.png`;
  const png = await sharp(Buffer.from(asset.svg)).png().toBuffer();
  const { error } = await client.storage.from(env.supabase.storageBucket).upload(path, png, { contentType: 'image/png', upsert: true, cacheControl: '31536000' });
  if (error) throw new FullSendError('storage_error', `Creative storage upload failed: ${error.message}`, { retryable: true, remedy: 'FullSend will retry the media step.', cause: error });
  const { data } = client.storage.from(env.supabase.storageBucket).getPublicUrl(path);
  if (!data.publicUrl) throw new FullSendError('storage_error', 'Creative storage did not return a public URL', { retryable: true, remedy: 'Check the Supabase storage bucket configuration.' });
  return { ...asset, url: data.publicUrl, storage_path: path, mime_type: 'image/png' };
}
