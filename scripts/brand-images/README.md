# Brand image sources

Static PNGs in the app are rendered once from these HTML files with headless
Chromium (Chrome for Testing 157, the Playwright `chromium-1252` build) and
committed. Nothing is generated at runtime. Run from this directory:

```sh
CHROME=~/.cache/ms-playwright/chromium-1252/chrome-linux64/chrome
shot() { "$CHROME" --headless=new --no-sandbox --disable-gpu --hide-scrollbars \
  --force-device-scale-factor="$1" --window-size="$2" --screenshot="$3" "file://$PWD/$4"; }

# Link-preview images (Open Graph)
shot 2 600,315 /tmp/og-site.png og-site.html
shot 1 600,600 /tmp/og-announcement.png 'symbol-tile.html#52'

# Flatten to opaque 8-bit RGB and strip metadata
convert /tmp/og-site.png         -strip -background '#141900' -alpha remove -alpha off -define png:color-type=2 ../../app/opengraph-image.png
convert /tmp/og-announcement.png -strip -background '#141900' -alpha remove -alpha off -define png:color-type=2 '../../app/a/[slug]/opengraph-image.png'
```

Fonts: the title asks for Georgia. Where Georgia is not installed the stack
falls back to C059 (URW Century Schoolbook); record which one was used in the
commit that changes the PNG.
