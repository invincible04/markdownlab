# Design sources

Editable source files for visual assets. These are **not** referenced
by the site — the rasterized outputs are. Regenerate the PNGs here
whenever the sources change.

## `icon.svg` → `icons/icon-{192,512}.png`, `icons/apple-touch-icon.png`

App icon used by the PWA manifest and iOS home-screen installs.

```sh
rsvg-convert -w 192 -h 192 design/icon.svg -o icons/icon-192.png
rsvg-convert -w 512 -h 512 design/icon.svg -o icons/icon-512.png
rsvg-convert -w 180 -h 180 design/icon.svg -o icons/apple-touch-icon.png
```

## `og-image.svg` → `og-image.png`

1200×630 social share card. Referenced by `<meta og:image>`,
`<meta twitter:image>`, and the JSON-LD Organization logo.

> Previously also referenced under `manifest.webmanifest → screenshots[]`,
> but Chrome's install dialog requires **≥ 1280×720** for `form_factor: wide`
> screenshots. The 1200×630 OG format fails that check, so the manifest
> entry was removed. Re-add with purpose-built artwork if PWA install
> polish becomes important.

Twitter/X, Facebook, LinkedIn, WhatsApp, and Bluesky all reject SVG as
a social image, which is why we ship the PNG in production.

### Regenerate

```sh
# librsvg (macOS: brew install librsvg) — preferred
rsvg-convert -w 1200 -h 630 design/og-image.svg -o og-image.png

# ImageMagick
magick -background none -size 1200x630 design/og-image.svg og-image.png

# Inkscape
inkscape design/og-image.svg --export-type=png --export-filename=og-image.png \
  --export-width=1200 --export-height=630
```

After deploying, force a re-scrape on each platform — social caches
hold for 7–30 days:

- Facebook: https://developers.facebook.com/tools/debug/ → "Scrape Again"
- LinkedIn: https://www.linkedin.com/post-inspector/
- Twitter/X: https://cards-dev.twitter.com/validator (requires login)
