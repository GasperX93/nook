# Nook Installer Size Analysis

> Current DMG size: **125 MB** (ZIP: 129 MB)
> This report explains why and what can be done about it.

---

## Size Breakdown

The app bundle (`Nook.app`) is ~400 MB uncompressed, compressed to ~125 MB in the DMG.

| Section | Size | Should be included? |
|---|---|---|
| **Electron Framework** (Chromium + Node.js) | ~186 MB | Yes — unavoidable |
| **`ui/node_modules/`** (frontend build tools) | **182 MB** | ❌ No |
| **Root `node_modules/`** (backend runtime deps) | 59 MB | Partially |
| **`dist/ui/`** (the actual built React app) | 7.7 MB | Yes |
| **`dist/desktop/`** (compiled backend JS) | 8 MB | Yes |
| **`assets/`** (icons, fonts) | 1 MB | Yes |
| **`src/`** (TypeScript source files) | 296 KB | ❌ No |
| **`.github/`**, **`.claude/`**, config files | ~50 KB | ❌ No |

---

## Root Cause #1 — `ui/node_modules/` is fully bundled (182 MB)

This is the biggest problem. The `ui/` folder is a separate npm project with its own `node_modules/`. Because there is **no `ignore` pattern** in `forge.config.js`, electron-forge packages the entire `ui/` directory — including all frontend build tools that are only needed at build time, not at runtime.

The biggest offenders inside `ui/node_modules/`:

| Package | Size | Purpose |
|---|---|---|
| `lucide-react` | 32 MB | Icon library (5,000+ SVG icons — only ~30 are used) |
| `typescript` | 23 MB | TypeScript compiler |
| `prettier` | 11 MB | Code formatter |
| `@babel/` | 10 MB | JS transpiler |
| `esbuild` + `@esbuild/` | 19 MB | Vite's bundler |
| `@typescript-eslint/` | 8.7 MB | Linting |
| `tailwindcss` | 6.2 MB | CSS framework |
| `vite` | 5.9 MB | Build tool |
| `caniuse-lite` | 4.1 MB | Browser compat database |
| `eslint` | 4 MB | Linting |

None of these should be in the installer. The built output (`dist/ui/`) is just 7.7 MB — the build tools are only needed to produce that output.

**The fix:** add `ignore: [/^\/ui\/node_modules/]` to `packagerConfig` in `forge.config.js`.

---

## Root Cause #2 — Accumulated old Vite build artifacts

The `dist/ui/assets/` directory contains **43 JS/CSS chunk files** from multiple past builds:

```
index-_w_mMIPN.js   index-ajTpiXAE.js   index-aOqSTGGe.js
index-B-wHPNb_.js   index-B1l1a5kD.js   index-B4e8GyWq.js
... (43 total)
```

Vite uses content-hash filenames. Each time you run `npm run build:ui` without first running `npm run clean`, the new hash-named files are added without deleting old ones. The correct app only needs 3–4 files from the latest build. The rest are leftover from every previous build session.

**The fix:** always run `npm run clean` before building, or add a `prebuild:ui` step that clears `dist/ui/`.

---

## Root Cause #3 — Electron version is old (v18, from 2022)

Nook uses `electron@^18.0.1` which bundles Chromium ~100. Current Electron (v33+) uses a significantly updated Chromium but benefits from many optimisations. However, upgrading Electron is a larger effort and won't dramatically reduce the installer size by itself.

---

## Root Cause #4 — Source files and dev configs bundled

The asar contains TypeScript source files, GitHub Actions workflows, `.claude/` settings, `.eslintrc.js`, `.prettierrc`, `CLAUDE.md`, test configs, etc. These are not needed at runtime.

---

## Root Cause #5 — Some production deps are large and unused or replaceable

In root `node_modules/` (the backend, legitimately bundled):

| Package | Size | Notes |
|---|---|---|
| `ethers` | 10 MB | Required for feed signing and wallet |
| `@ethersproject/` | 11 MB | ethers v5 sub-packages |
| `node-notifier` | 5.5 MB | Desktop notifications — ships `vendor/` binaries for all platforms |
| `moment` | 5.2 MB | Heavy date library — only used by `file-stream-rotator` (log rotation) |
| `@types/` | 2.4 MB | TypeScript definitions — not needed at runtime |

`node-notifier` bundles Windows/Linux binaries even on macOS because it's packaged for all platforms at once. `moment` is a known bloat issue — replaceable with a smaller library. `@types/` packages should be devDependencies.

---

## Summary — Where the size actually comes from

```
Electron itself:           ~186 MB  (Chrome + Node.js, unavoidable)
ui/node_modules (bundled): ~182 MB  ← BIGGEST BUG, easy fix
root node_modules:          ~59 MB  (mostly legitimate, some reducible)
dist/ (app code):           ~16 MB  (correct)
```

Of the ~125 MB DMG:
- **~50 MB** is fixable by excluding `ui/node_modules/` and source files
- The remaining ~75 MB is Electron overhead (Chrome engine, Node.js runtime)
- Comparable apps like VS Code or Slack are 100–300 MB for the same reason

---

## Recommended Fixes (in order of impact)

### Fix 1 — Exclude `ui/node_modules/` from packaging (saves ~50 MB in DMG)

In `forge.config.js`, add to `packagerConfig`:

```js
packagerConfig: {
  // ... existing config
  ignore: [
    /^\/ui\/node_modules/,   // frontend build tools — NEVER needed at runtime
    /^\/ui\/src/,             // TypeScript source
    /^\/src/,                 // TypeScript source
    /^\/\.github/,            // CI workflows
    /^\/\.claude/,            // local dev settings
    /^\/node_modules\/@types/, // TypeScript definitions (runtime not needed)
  ],
},
```

### Fix 2 — Clean before build to avoid accumulated artifacts

In `package.json`, update the build script:

```json
"build:ui": "cd ui && rm -rf dist && npm run build && cd .."
```

Or use the existing `clean` script before every `make`:

```bash
npm run clean && npm run build && npm run make
```

### Fix 3 — Remove `moment` from production deps (saves ~5 MB)

`moment` is only pulled in by `file-stream-rotator` as an optional dependency. Pin `file-stream-rotator` to a version that doesn't require `moment`, or replace it with a lighter log rotation solution.

### Fix 4 — Move `@types/*` to devDependencies

Any `@types/` package in `dependencies` (not `devDependencies`) will be bundled. TypeScript definitions are never needed at runtime. Audit `package.json` and move all `@types/*` to `devDependencies`.

---

## Expected result after fixes

| Metric | Now | After fixes |
|---|---|---|
| DMG size | ~125 MB | ~70–80 MB |
| App bundle (uncompressed) | ~400 MB | ~220 MB |
| Main reduction | — | ui/node_modules + source files excluded |
