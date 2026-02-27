# Swarm Desktop UI

React frontend for Swarm Desktop. Served by the Electron backend's Koa server at `/dashboard`.

## Stack

- **Vite** + **React 18** + **TypeScript**
- **React Router v6** (HashRouter — required by Koa static file serving)
- **Tanstack Query v5** — data fetching and caching against the desktop API
- **Zustand** — global state (API key)
- **Tailwind CSS** — styling via CSS custom properties for theming

## Development

```bash
npm install --legacy-peer-deps   # first time only
npm start                        # dev server on http://localhost:3002
npm run build                    # production build → build/
npm run lint                     # lint + fix
npm run lint:check               # lint check only
```

In development the Vite dev server proxies all API routes (`/info`, `/status`, `/config`, etc.) to `http://localhost:3000` (the Electron backend).

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `VITE_BEE_DESKTOP_URL` | same-origin | Backend base URL. Set in `.env.development`. |
| `VITE_API_KEY` | — | API key for dev without the Electron wrapper. |

In production the API key is injected by the Electron backend as a `?v=` URL parameter when it opens the dashboard window. The app reads it from `window.location.search` on startup.

## Architecture

```
src/
├── main.tsx              # entry point — reads API key from URL, mounts app
├── App.tsx               # route definitions
├── index.css             # Tailwind base + dark theme CSS variables
├── vite-env.d.ts         # Vite env type declarations
├── store/
│   └── app.ts            # Zustand store (API key)
├── api/
│   ├── client.ts         # typed fetch wrapper + API types
│   └── queries.ts        # Tanstack Query hooks for all endpoints
├── components/
│   └── Layout.tsx        # sidebar navigation + <Outlet />
└── pages/
    ├── Overview.tsx      # node status, peers, version, restart
    ├── Wallet.tsx        # placeholder
    ├── Settings.tsx      # Bee config viewer + editor
    └── Logs.tsx          # Bee / Desktop log viewer
```

### API key flow

1. Electron backend generates a key and stores it in `api-key.txt`
2. On launch it opens `http://localhost:{port}/dashboard/?v={key}`
3. `main.tsx` reads `?v=` from the URL and stores it in the Zustand store
4. `api/client.ts` reads the key from the store and adds it as the `authorization` header on every authenticated request

### Adding a new page

1. Create `src/pages/MyPage.tsx`
2. Add a route in `App.tsx`
3. Add a nav item in `components/Layout.tsx`

### Adding a new API endpoint

1. Add the typed call to `api/client.ts`
2. Add a query/mutation hook in `api/queries.ts`
3. Use the hook in your component

## Updating Bee version

Bee version is managed in the Electron layer, not here. Change the download URL in `../src/downloader.ts` and bump the root `package.json` version.
