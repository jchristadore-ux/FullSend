/**
 * The typeface FullSend ships with itself.
 *
 * Its own module because both ends of the pipeline need the name and neither
 * should have to pull in the other: the renderer names it in every font stack,
 * and the rasteriser configures fontconfig to find it. Pure data, no imports —
 * so a server component that only wants to typeset an SVG does not drag the
 * image encoder in behind it.
 */
export const BUNDLED_FONT_FAMILY = 'Inter';
