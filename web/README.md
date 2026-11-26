# KasIn Web App (`web/`)

Static browser app for KasIn. No build step required.

## Hosting

If you use Google Drive sync, add your site's origin to **Authorized JavaScript origins** in Google Cloud Console.

### GitHub Pages

1. Enable **Settings → Pages → Source: GitHub Actions**.
2. Optionally add `GOOGLE_CLIENT_ID` under **Settings → Secrets and variables → Actions**.
3. Publish a `v*` release (or run `.github/workflows/deploy-pages.yml` manually).

### Cloudflare Pages

1. Connect the repo in **Workers & Pages → Create → Pages**.
2. Set **Build output directory** to `web` and optionally add a `GOOGLE_CLIENT_ID` env var.
3. Set **Build command** to:
   ```bash
   sed -i "s/const CACHE_VERSION = '.*';/const CACHE_VERSION = 'kasin-pwa-${CF_PAGES_COMMIT_SHA:0:7}';/" web/sw.js && sed -i "s|export const DEFAULT_GOOGLE_CLIENT_ID = '.*';|export const DEFAULT_GOOGLE_CLIENT_ID = '${GOOGLE_CLIENT_ID}';|" web/js/config.js
   ```

### Local Dev

```bash
npx serve web -l 3000
```

Open `http://localhost:3000`.

## Google Drive Sync Setup

1. In [Google Cloud Console](https://console.cloud.google.com/), enable **Google Drive API**.
2. On **OAuth consent screen**, add the scope `https://www.googleapis.com/auth/drive.appdata`.
3. Under **Credentials → Create Credentials → OAuth client ID** (Web application), add your origins under **Authorized JavaScript origins** (e.g. `http://localhost:3000`, `https://<user>.github.io`, `https://<app>.pages.dev`).
4. Paste the **Client ID** in **Basis Data** (`#/databases`) inside the app, or set `DEFAULT_GOOGLE_CLIENT_ID` in `web/js/config.js`.

### How Token Refresh Works

- Because the app runs purely in the browser without a backend secret, Google issues a 1-hour access token with no refresh token.
- Reloading the page within 1 hour keeps you signed in.
- After 1 hour (or after closing and reopening the installed PWA), the app switches back to local mode, keeps saving your edits locally, and queues them for upload.
- A small **Sync Drive** pill (with the pending count, if any) appears in the header — tap it once to reconnect without an account picker and flush queued changes.

## Local Files & Backups

- **Direct `.sqlite` file (Chromium):** Link an existing `.sqlite` file or create a new `kasin.sqlite` during onboarding or in **Basis Data** (`#/databases`).
- **Export / Restore:** Export `.sqlite` or CSV backups, or restore a `.sqlite` file from **Basis Data** (`#/databases`).
