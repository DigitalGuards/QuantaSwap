# Brand assets

The canonical mark lives in `../public/favicon.svg` (and is hand-mirrored in
`../src/components/Logo.tsx` with theme tokens instead of literal colors).
Everything else derives from it.

Regenerate the shipped rasters after changing the mark (needs `rsvg-convert`
from librsvg2-bin, ImageMagick, and the Lato system font):

```bash
# OG card (also update the mark groups inside og-card.svg first)
rsvg-convert -w 1200 -h 630 og-card.svg -o ../public/og-image.png

# Apple touch icon: 176px mark centered on a 180px transparent canvas
rsvg-convert -w 176 -h 176 ../public/favicon.svg -o /tmp/qs-mark-176.png
convert -size 180x180 xc:none /tmp/qs-mark-176.png -gravity center -composite ../public/apple-touch-icon.png
```

Design notes: the arrowheads are intentionally oversized (about 2x the stroke
width) after community feedback that the first version's arrows disappeared at
small sizes. Keep them dominant.
