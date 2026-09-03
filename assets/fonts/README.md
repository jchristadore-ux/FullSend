# Fonts

Inter, vendored so that generated creative can be typeset anywhere FullSend
runs.

## Why these files are in the repository

Creative is drawn as SVG and rasterised with `sharp`, which renders `<text>`
through librsvg → pango → **fontconfig**. Fontconfig can only use fonts
installed on the machine doing the drawing, and a serverless runtime has none —
no `/usr/share/fonts`, nothing. Every rectangle and rule drew correctly and
every word came out as a replacement box, so posts published as blank cards
with a brand-coloured bar on them.

A font that travels with the application is the only version of this that
cannot fail on somebody else's host. `src/lib/creative/fonts.ts` writes a
fontconfig configuration pointing here before the first raster, and proves text
actually draws before storing anything.

## What is here

| File | Weight | Used for |
| --- | --- | --- |
| `Inter-Regular.ttf` | 400 | body copy on carousel slides |
| `Inter-Bold.ttf` | 700 | captions, labels |
| `Inter-ExtraBold.ttf` | 800 | display type — hooks and headlines |

A brand's own typeface is still asked for first in every font stack; Inter is
named immediately before the generic keyword, so it is what a card falls back
to rather than whatever the host happens to substitute.

## Licence

Inter is licensed under the SIL Open Font License 1.1 — see `OFL.txt`.
Copyright (c) 2016 The Inter Project Authors (https://github.com/rsms/inter).

## Replacing the family

Change `BUNDLED_FONT_FAMILY` in `src/lib/creative/font-constants.ts`, drop the
new faces in beside these, and update `fontDirectory()`'s existence probe in
`src/lib/creative/fonts.ts` if the regular face is named differently. The
`tests/creative-render.test.ts` probe fails if the result cannot draw text.
