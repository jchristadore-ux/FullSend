import { projectRoute } from '@/lib/api/handler';
import { updateBrandInput } from '@/lib/schemas';
import { audit, db, getAnalysis, getBrandProfile } from '@/lib/db/repo';
import { identityFrom, identityGaps, lockFields, paletteFor } from '@/lib/brand/identity';
import { nowIso } from '@/lib/ids';
import { FullSendError } from '@/lib/errors';

export const runtime = 'nodejs';

/**
 * The project's brand profile, plus where each part of it came from.
 *
 * Provenance is the point. Repository analysis gets things wrong — a demo
 * page's accent read as the brand colour, a vendored stylesheet's typeface
 * picked over the product's own — and a founder looking at a wrong colour can
 * only act on it if they can see which file produced it. So every discovered
 * field ships with its source, every gap is named, and the palette the
 * renderer will actually use is returned alongside the raw values, because
 * those differ whenever something is missing.
 */
export const GET = projectRoute(async ({ session, project }) => {
  const [brand, analysis] = await Promise.all([
    getBrandProfile(session.scope, project.id),
    getAnalysis(session.scope, project.id),
  ]);

  const identity = identityFrom(analysis);

  return {
    brand,
    // What the cards are drawn with, which is not the same as what is stored:
    // an unset colour resolves to a neutral here.
    palette: paletteFor(brand),
    gaps: identityGaps(brand),
    discovery: identity
      ? {
          read_from: identity.evidence.style_files,
          color_tokens: identity.evidence.color_tokens.slice(0, 40),
          logo_candidates: identity.evidence.logo_candidates,
          not_found: identity.evidence.unresolved,
        }
      : null,
  };
});

/**
 * Corrects the profile by hand.
 *
 * Every field sent is locked, and a locked field is never overwritten by a
 * later analysis. That is the whole contract: an override a re-run silently
 * reverts is not an override, and a founder who has to re-fix the same colour
 * after every analysis will stop trusting the profile entirely.
 *
 * `unlock` is the way back — it hands a field to discovery again, for when the
 * correction was the mistake.
 */
export const PATCH = projectRoute(
  async ({ session, project, body }) => {
    const brand = await getBrandProfile(session.scope, project.id);
    if (!brand) {
      throw new FullSendError('not_found', 'This project has no brand profile yet', {
        status: 404,
        remedy: 'Run the analysis first — the brand profile is built from it.',
      });
    }

    const { unlock = [], ...edits } = body;
    const edited = Object.keys(edits);
    if (edited.length === 0 && unlock.length === 0) {
      throw new FullSendError('invalid_input', 'Nothing to change', {
        status: 400,
        remedy: 'Send at least one field to update.',
      });
    }

    const unlockSet = new Set(unlock);
    const locked = lockFields(brand, edited).filter((f) => !unlockSet.has(f));

    // Provenance for a hand-edited field is the person who edited it. Leaving
    // the old file path there would credit a stylesheet with a value it never
    // contained.
    const sources = { ...brand.identity_sources };
    for (const field of edited) sources[field] = 'edited by hand';
    for (const field of unlock) delete sources[field];

    const updated = await db().update(session.scope, 'brand_profiles', brand.id, {
      ...edits,
      locked_fields: locked,
      identity_sources: sources,
      updated_at: nowIso(),
    });

    await audit(session.scope, {
      user_id: session.user.id,
      project_id: project.id,
      action: 'brand.edited',
      target: brand.id,
      // Field names only. The values are the founder's brand, and an audit log
      // is not the place to duplicate them.
      metadata: { fields: edited, unlocked: unlock },
      ip: null,
    });

    return { brand: updated, palette: paletteFor(updated), gaps: identityGaps(updated) };
  },
  { schema: updateBrandInput },
);
