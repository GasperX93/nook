# App icons (option B: pebble N)

`make.py` holds the master SVGs — the pebble + N from the Nook wordmark on
the macOS 824/1024 icon grid, the dark-aware favicon, and the menu-bar N —
and writes `jobs.json`. `render.mjs` rasterises the jobs with one headless
Chrome over CDP (Chrome's one-shot `--screenshot` hangs on macOS).

    cd scripts/icons
    python3 make.py && node render.mjs
    iconutil -c icns out/Nook.iconset -o out/icon.icns
    python3 -c "from PIL import Image; s=[16,24,32,48,64,128,256]; i=[Image.open(f'out/win-{x}.png') for x in s]; i[-1].save('out/icon.ico', sizes=[(x,x) for x in s], append_images=i[:-1])"

Then copy into the app: `out/icon.icns`, `out/icon.ico`, `out/win-512.png` → `assets/icon.png`;
`nookTrayTemplate.png` + `@2x` (macOS menu bar, tinted by the system) and
`tray-color-16/32.png` → `assets/nookTrayColor.png` + `@2x` (Windows/Linux);
`favicon.svg`, `favicon-32.png` → `ui/public/favicon.png`, `favicon-180.png` →
`ui/public/apple-touch-icon.png`, `favicon-192/512.png` → `ui/public/logo192/512.png`.
`out/` and `jobs.json` are scratch — don't commit them.
