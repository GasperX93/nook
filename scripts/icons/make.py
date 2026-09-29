import os, subprocess, sys
HERE = os.getcwd()
PEBBLE = "M188.241 328.696C156.006 328.696 142.625 350 104.612 350C80.5877 350 62.9496 336.304 59.3004 295.522C56.8675 266.304 52.306 256.565 38.0131 239.826C18.8545 217.304 0 204.217 0 176.522C0 150.043 13.9888 136.957 28.5858 125.696C41.9664 115.043 56.5634 101.957 60.5168 72.1304C66.2948 28.6087 95.7929 0 152.66 0C196.452 0 211.657 14.6087 248.453 16.1304C289.812 17.6522 310.491 35.3043 310.491 73.6522C310.491 101.652 301.063 110.174 301.063 141.826C301.063 189.609 326 200.87 326 265.391C326 318.348 298.631 347.261 263.05 347.261C239.938 347.261 217.739 328.696 188.241 328.696Z"
N = "M133.257 79H152V140H133.257L109.743 107.931V140H91V79H109.743L133.257 110.284V79Z"
N_IN_PEB = "translate(-152.9 -106.7) scale(2.6)"

def app_svg(size):
    # macOS grid: 824 px tile on a 1024 canvas, ~185 px corners.
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 1024 1024">
<rect x="100" y="100" width="824" height="824" rx="185" fill="#141414"/>
<g transform="translate(251 232) scale(1.6)"><path d="{PEBBLE}" fill="#ffffff"/><path transform="{N_IN_PEB}" d="{N}" fill="#141414"/></g></svg>'''

def win_svg(size):
    # Windows/Linux icons use the full square (no macOS margin), same corner feel.
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 1024 1024">
<rect x="0" y="0" width="1024" height="1024" rx="230" fill="#141414"/>
<g transform="translate(212 176) scale(1.84)"><path d="{PEBBLE}" fill="#ffffff"/><path transform="{N_IN_PEB}" d="{N}" fill="#141414"/></g></svg>'''

def fav_svg(size=None, dark_aware=False):
    wh = f'width="{size}" height="{size}" ' if size else ''
    style = ''
    if dark_aware:
        style = '<style>.p{fill:#141414}.n{fill:#fff}@media (prefers-color-scheme:dark){.p{fill:#f2f2f2}.n{fill:#1d1f22}}</style>'
        return f'<svg xmlns="http://www.w3.org/2000/svg" {wh}viewBox="0 0 350 350">{style}<g transform="translate(12 0)"><path class="p" d="{PEBBLE}"/><path class="n" transform="{N_IN_PEB}" d="{N}"/></g></svg>'
    return f'<svg xmlns="http://www.w3.org/2000/svg" {wh}viewBox="0 0 350 350"><g transform="translate(12 0)"><path d="{PEBBLE}" fill="#141414"/><path transform="{N_IN_PEB}" d="{N}" fill="#ffffff"/></g></svg>'

def tray_svg(size, color='#000000'):
    # Just the N (wordmark letterform), a little padding so it sits like other menu-bar glyphs.
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="-5 -5 71 71"><path transform="translate(-91 -79)" d="{N}" fill="{color}"/></svg>'

# ── Jobs for render.mjs (one headless Chrome over CDP) ──────────────────────
import json

out = os.path.join(HERE, 'out')
os.makedirs(os.path.join(out, 'Nook.iconset'), exist_ok=True)
jobs = []
for base in [16, 32, 128, 256, 512]:
    for scale in [1, 2]:
        px = base * scale
        jobs.append((app_svg(px), f'{out}/Nook.iconset/icon_{base}x{base}{"@2x" if scale == 2 else ""}.png', px))
for px in [16, 24, 32, 48, 64, 128, 256, 512, 1024]:
    jobs.append((win_svg(px), f'{out}/win-{px}.png', px))
jobs.append((app_svg(1024), f'{out}/app-1024.png', 1024))
for px in [32, 180, 192, 512]:
    jobs.append((fav_svg(px), f'{out}/favicon-{px}.png', px))
jobs.append((tray_svg(16), f'{out}/nookTrayTemplate.png', 16))
jobs.append((tray_svg(32), f'{out}/nookTrayTemplate@2x.png', 32))
for px in [16, 32]:
    jobs.append((fav_svg(px), f'{out}/tray-color-{px}.png', px))
json.dump([{'svg': s, 'out': o, 'size': n} for s, o, n in jobs], open(os.path.join(HERE, 'jobs.json'), 'w'))
open(f'{out}/favicon.svg', 'w').write(fav_svg(dark_aware=True))
open(f'{out}/app-icon.svg', 'w').write(app_svg(1024))
print(len(jobs), 'jobs → run: node render.mjs')
