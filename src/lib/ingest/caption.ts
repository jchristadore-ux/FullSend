/**
 * Caption for an ingested card.
 *
 * Deterministic on purpose. FullSend's AI copywriter enriches from the
 * product analysis and brand profile, which is right for marketing posts and
 * wrong here: these posts are about real golfers, and the privacy rule is that
 * a caption may only use what the sender put in `facts` — display names and
 * golf numbers. A template cannot invent a surname, a hometown or a handle.
 */
import type { IngestEventType, IngestFacts } from './schema';

export const INGEST_HASHTAGS = ['#golf', '#handicap', '#TheBrovisional'];
const CAPTION_MAX = 2200;

function fmt(n: number | undefined, digits = 1): string | null {
  if (n === undefined || !Number.isFinite(n)) return null;
  return n.toFixed(digits);
}

/** +0.4 / −1.2 — a signed change, typographic minus. */
function signed(n: number | undefined): string | null {
  if (n === undefined || !Number.isFinite(n)) return null;
  const v = Math.abs(n).toFixed(1);
  if (n > 0) return `+${v}`;
  if (n < 0) return `−${v}`;
  return '±0.0';
}

function names(facts: IngestFacts): string | null {
  const list = facts.players.map((p) => p.display_name);
  if (list.length === 0) return null;
  if (list.length === 1) return list[0]!;
  return `${list.slice(0, -1).join(', ')} & ${list[list.length - 1]}`;
}

export function factsLines(eventType: IngestEventType, facts: IngestFacts): string[] {
  const who = names(facts);
  const score = facts.score !== undefined ? String(facts.score) : null;
  const diff = fmt(facts.differential);
  const index = fmt(facts.index);
  const delta = signed(facts.delta);

  if (eventType === 'weekly_leaderboard') {
    const rows = (facts.leaderboard ?? []).slice().sort((a, b) => a.rank - b.rank).slice(0, 10);
    const lines = rows.map((r) => {
      const parts = [`${r.rank}. ${r.display_name}`];
      const value = fmt(r.index) ?? (r.score !== undefined ? String(r.score) : null) ?? fmt(r.differential);
      if (value) parts.push(`— ${value}`);
      const d = signed(r.delta);
      if (d) parts.push(`(${d})`);
      return parts.join(' ');
    });
    return lines.length ? ['This week’s leaderboard:', ...lines] : [];
  }

  if (eventType === 'handicap_drop') {
    const bits: string[] = [];
    if (who && index) bits.push(`${who}’s index is now ${index}${delta ? ` (${delta})` : ''}`);
    else if (index) bits.push(`New index: ${index}${delta ? ` (${delta})` : ''}`);
    if (score || facts.course) {
      bits.push(
        `after ${score ? `a ${score}` : 'a round'}${facts.course ? ` at ${facts.course}` : ''}` +
          (diff ? ` (differential ${diff})` : ''),
      );
    }
    return bits.length ? [`${bits.join(' ')}.`] : [];
  }

  // round_result
  const parts: string[] = [];
  const head = [who, score ? `shot ${score}` : null, facts.course ? `at ${facts.course}` : null]
    .filter(Boolean)
    .join(' ');
  if (head) parts.push(head);
  if (diff) parts.push(`differential ${diff}`);
  if (index) parts.push(`index ${index}${delta ? ` (${delta})` : ''}`);
  return parts.length ? [`${parts.join(' · ')}.`] : [];
}

export interface BuiltCaption {
  hook: string;
  caption: string;
  hashtags: string[];
}

export function buildIngestCaption(input: {
  eventType: IngestEventType;
  captionHint: string;
  facts: IngestFacts;
}): BuiltCaption {
  const hint = input.captionHint.trim();
  const lines = factsLines(input.eventType, input.facts);
  const body = [hint, lines.join('\n')].filter(Boolean).join('\n\n');
  const fallback =
    input.eventType === 'weekly_leaderboard'
      ? 'The weekly leaderboard is in.'
      : input.eventType === 'handicap_drop'
        ? 'Handicap on the move.'
        : 'Round posted.';
  const caption = (body || fallback).slice(0, CAPTION_MAX - 80);
  const firstLine = (hint || lines[0] || fallback).split('\n')[0]!.trim();
  const hook = firstLine.length > 120 ? `${firstLine.slice(0, 117)}…` : firstLine;
  return { hook, caption, hashtags: [...INGEST_HASHTAGS] };
}
