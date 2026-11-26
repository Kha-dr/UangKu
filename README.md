# KasIn

<div align="center">
  <img src="./web/assets/img/logo.png" alt="KasIn Logo" width="180" />

Local-first personal cashflow, multi-account, asset depreciation, and wishlist PWA with optional Google Drive sync, WebMCP, and a stateless Remote MCP server.

[Web App Guide](web/README.md) | [MCP Server Guide](mcp-server/README.md)

</div>

## Features

- **100% Local-First SQLite:** Runs SQLite WASM in-browser via `SharedWorker` (live multi-tab sync) with IndexedDB/OPFS persistence and versioned `PRAGMA user_version` migrations.
- **Direct Local `.sqlite` Linking:** Connect or create a `.sqlite` file directly on disk (File System Access API) with automatic debounced saves.
- **Optional Google Drive Sync:** Encrypted user-owned `appDataFolder` sync (`kasin.sqlite` snapshot + JSON deltas) with bidirectional conflict protection.
- **Multi-Account, Assets & Debt:** Track liquid cash, foreign currencies, depreciating physical assets (`Harta`), credit cards (`limit_kredit`, due-date badges), loans, and wishlists.
- **Voice & AI Analytics (WebMCP):** Record transactions by voice, ask AI agents to analyze/chart spending via WebMCP tools, and save local Highcharts presets.
- **Stateless Remote MCP Server:** Connect Claude Web or Gemini Web directly to your Google Drive `kasin.sqlite` via Cloudflare Workers or Docker/Bun.

## Quick Start

### 1. Host the Web App (`web/`)

`web/` is pure static files (zero build step) using relative `./` paths. Remember to add your deployed origin to **Authorized JavaScript origins** in Google Cloud Console if using Google Drive sync.

- **GitHub Pages (Automated on Release):** Enable **Settings → Pages → Source: GitHub Actions**. Publishing a `v*` release (or manual `workflow_dispatch`) triggers [`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml), automatically stamping `APP_VERSION`, Service Worker `CACHE_VERSION`, and optional `GOOGLE_CLIENT_ID` (from Actions variable or secret).
- **Cloudflare Pages:** Connect the repo in **Workers & Pages → Create → Pages**, set **Build output directory** to `web`, and set **Build command** to:
  ```bash
  sed -i "s/const CACHE_VERSION = '.*';/const CACHE_VERSION = 'kasin-pwa-${CF_PAGES_COMMIT_SHA:0:7}';/" web/sw.js
  ```
- **Local Development:**
  ```bash
  npx serve web -l 3000
  ```

### 2. Host the Remote MCP Server (`mcp-server/`)

- **Cloudflare Workers (Free Tier):**
  ```bash
  cd mcp-server
  npm install
  npx wrangler secret put GOOGLE_CLIENT_ID
  npx wrangler secret put GOOGLE_CLIENT_SECRET
  npx wrangler deploy
  ```
- **Docker / Self-Hosted (Automated via CI):** [`.github/workflows/docker-build.yml`](.github/workflows/docker-build.yml) builds `mcp-server/Dockerfile` and pushes `khad1r/kasin-mcp` to Docker Hub on `main` pushes and `v*` release tags (`DOCKER_USERNAME`, `DOCKER_PASSWORD`), or run locally:
  ```bash
  cd mcp-server
  docker compose up -d
  ```

See [mcp-server/README.md](mcp-server/README.md) for Google OAuth redirect URI setup and connecting Claude Web / Gemini Web.

## Repository Structure

```text
.
├── .github/
│   └── workflows/          # Pages deploy, Docker build, and git-cliff draft releases
├── mcp-server/             # Stateless Remote MCP server (Cloudflare Workers & Docker/Bun)
│   └── src/
│       ├── tools/          # MCP tool handlers (transaksi, rekening, wishlist, sqlite, prompt)
│       ├── gdrive.ts       # Google Drive appDataFolder snapshot + delta sync
│       ├── oauth.ts        # OAuth 2.0 / RFC 9728 / DCR endpoints
│       └── schema.ts       # Versioned PRAGMA user_version SQLite migrations
├── web/                    # Zero-build local-first PWA
│   ├── assets/             # CSS theme, icons, logo, banner
│   ├── js/
│   │   ├── db/             # SQLite WASM SharedWorker, client, local-file handle, schema
│   │   ├── models/         # Rekening, Transaksi, Wishlist data models
│   │   ├── sync/           # Google Drive snapshot/delta sync & conflict guards
│   │   └── views/          # Onboarding, Transactions, Record, Rekening, Wishlist, Analisis, Databases
│   ├── manifest.json       # PWA manifest & Share Target config
│   └── sw.js               # Service Worker (network-first on localhost, CI-stamped in prod)
├── cliff.toml              # git-cliff conventional changelog & semver config
└── README.md
```

## Release & CI Flow

1. Pushing conventional commits (`feat:`, `fix:`, `refactor:`, etc.) to `main` runs [`.github/workflows/draft-release.yml`](.github/workflows/draft-release.yml) with [`cliff.toml`](cliff.toml) to create/update a Draft Release (`vX.Y.Z`).
2. Publishing that release in GitHub creates the `vX.Y.Z` tag, which triggers both [`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml) (stamping `APP_VERSION` + `CACHE_VERSION` and deploying `web/`) and [`.github/workflows/docker-build.yml`](.github/workflows/docker-build.yml) (pushing `khad1r/kasin-mcp:vX.Y.Z` and `:latest`).

## License

Copyright (c) 2025-2026 khadr.dev.

Licensed under the **GNU Affero General Public License v3.0** ([LICENSE](LICENSE)).

- **Third-Party Libraries:** External CDN libraries (including Highcharts, which is free for personal/non-commercial use) remain governed by their respective licenses.
- **Commercial Licensing:** Separate commercial licenses for closed-source or proprietary distribution are available from `khadr.dev`.
