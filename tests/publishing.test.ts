import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  connectPlatform,
  createProject,
  setupContext,
  teardown,
  type TestContext,
} from './helpers';
import { db } from '@/lib/db/repo';
import { newId, nowIso } from '@/lib/ids';
import { backoffMs, buildCaption, publishScheduledPost, resumeAfterReconnect } from '@/lib/publish/publish';
import { scheduleContent, reschedule, unschedule, nextSend, queueDepth } from '@/lib/scheduler/schedule';
import { disconnect, getUsableConnection, loadTokens } from '@/lib/social/connections';
import { encryptSecret, decryptSecret, signState, verifyState, createPkcePair } from '@/lib/crypto';
import { mapMetaError } from '@/lib/social/instagram';
import { mapTikTokError } from '@/lib/social/tiktok';
import { FullSendError } from '@/lib/errors';
import type { ContentItem, Project } from '@/lib/types';

/* truncated intentionally - will use push_files with full file */
