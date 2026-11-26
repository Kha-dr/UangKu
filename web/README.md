# KasIn v2 — Local-First PWA

KasIn v2 is a zero-server, local-first Progressive Web App for personal cashflow tracking with optional Google Drive `appDataFolder` sync and in-browser WebMCP support.

## Deployment (Zero Build Step)

Because `web/` is pure static files with relative `./` paths, you can host it directly on any static host. Remember to add your deployed origin to **Authorized JavaScript origins** in Google Cloud Console if using Google Drive sync.

### GitHub Pages (Automated via Actions)

1. Push the repository to GitHub and enable **Settings → Pages → Source: GitHub Actions**.
2. Optionally add `GOOGLE_CLIENT_ID` under **Settings → Secrets and variables → Actions** (as a variable or secret).
3. Publish a `v*` release (or run `.github/workflows/deploy-pages.yml` manually) — it automatically stamps `APP_VERSION`, Service Worker `CACHE_VERSION`, and `DEFAULT_GOOGLE_CLIENT_ID`.

### Cloudflare Pages

1. Connect your repository in **Workers & Pages → Create → Pages**.
2. Set **Build output directory** to `web` and optionally add `GOOGLE_CLIENT_ID` as an environment variable.
3. Set **Build command** to stamp the Service Worker cache version (and optional Client ID):
   ```bash
   sed -i "s/const CACHE_VERSION = '.*';/const CACHE_VERSION = 'kasin-pwa-${CF_PAGES_COMMIT_SHA:0:7}';/" web/sw.js && sed -i "s|export const DEFAULT_GOOGLE_CLIENT_ID = '.*';|export const DEFAULT_GOOGLE_CLIENT_ID = '${GOOGLE_CLIENT_ID}';|" web/js/config.js
   ```

### Local Development

Serve `web/` with any static HTTP server (required for ES Modules, Web Workers, and Service Workers):

```bash
npx serve web -l 3000
```

Then open `http://localhost:3000`.

## Google Drive Sync Setup (OAuth 2.0 Client ID)

Google Drive sync uses Google Identity Services (GIS) in the browser with no backend client secret:

1. Open [Google Cloud Console](https://console.cloud.google.com/) and create/select a project.
2. Enable the **Google Drive API**.
3. Configure the **OAuth consent screen** (External or Internal) and add the non-sensitive scope:
   - `https://www.googleapis.com/auth/drive.appdata`
4. Go to **Credentials → Create Credentials → OAuth client ID**:
   - **Application type**: `Web application`
   - **Authorized JavaScript origins**: add your deployment origin(s), e.g.:
     - `http://localhost:8080` (local dev)
     - `https://<username>.github.io` (GitHub Pages)
     - `https://<your-app>.pages.dev` (Cloudflare Pages)
5. Copy the generated **Client ID** and either:
   - Paste it in the **Basis Data** view (`#/databases`) inside the app (saved in `localStorage`), **or**
   - Hardcode it in `web/js/config.js` (`DEFAULT_GOOGLE_CLIENT_ID`) for your own deployment.

### Token Lifetime & Refresh Behavior

- Because `web/` is a 100% static client-side PWA using Google Identity Services (`initTokenClient`), Google does not issue a `refresh_token` to the browser and hidden-iframe silent refresh is not supported.
- The 1-hour Google Drive `access_token` is cached in `sessionStorage` (`kasin_drive_access_token` + `kasin_drive_token_expires_at`), so page reloads within 1 hour stay connected automatically.
- Once the token expires (or after closing and reopening an installed PWA), KasIn drops to **Local Mode** while continuing to save locally and queue changes in `kasin_pending_deltas`.
- A minimal **`Sync Drive`** pill (showing pending delta count when > 0) appears in the header for previously signed-in users: tapping it triggers a 1-tap reconnect (`prompt: ''` + `hint: email`) that auto-closes without an account picker or consent screen and flushes queued deltas to Google Drive.

## Local `.sqlite` & Backups

- **Direct Local File (Chromium):** Connect an existing `.sqlite` file or create a brand-new `kasin.sqlite` on disk during onboarding or in **Basis Data** (`#/databases`) with automatic saves.
- **Export / Restore:** Export `kasin.sqlite` or CSV backups anytime from **Basis Data** (`#/databases`), or restore an existing `.sqlite` file into browser storage.
