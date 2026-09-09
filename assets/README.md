# Icon sources

`icon.svg` and `icon-maskable.svg` are the live app icon — the "Sliced A" design.
Run `npm run icons` after changing either; it regenerates every PNG the manifest
points at, plus the SVG the browser tab uses.

The maskable variant keeps its artwork inside a centred circle at 80% of the
width, because ChromeOS crops it to a circle or squircle.

`alternates/` holds the "Cut bars" design from the same set, unused. Kept
because it reads well at large sizes if the icon is ever revisited.
