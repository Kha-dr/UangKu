# KasIn Remote MCP Worker (`kasin-mcp-server`)

Optional, self-hostable, **stateless** Cloudflare Worker implementing the Model Context Protocol (MCP) over Streamable HTTP (`POST /mcp`) with OAuth 2.0 (RFC 9728 / RFC 8414 / Dynamic Client Registration) for **Claude Web** and **Google Gemini Web**.

Your SQLite database (`kasin.sqlite`) remains 100% in your own **Google Drive `appDataFolder`** — the Worker never stores user tokens, credentials, or database files on Cloudflare.

---

## Prerequisites

- [Node.js](https://nodejs.org/) v18+ and `npm`
- A free [Cloudflare Workers](https://workers.cloudflare.com/) account
- A [Google Cloud Console](https://console.cloud.google.com/) project with **Google Drive API** enabled

---

## 1. Install Dependencies

```bash
cd mcp-server
npm install
```

---

## 2. Create Google Cloud OAuth Web Client ID & Secret

1. Open [Google Cloud Console → APIs & Services → Library](https://console.cloud.google.com/apis/library) and enable **Google Drive API**.
2. Go to **APIs & Services → OAuth consent screen**:
   - Choose **External** (or Internal if using Google Workspace).
   - Add the scope: `https://www.googleapis.com/auth/drive.appdata`.
   - Under **Test users**, add your Gmail address (if the app is in Testing mode).
3. Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**:
   - Application type: **Web application**
   - Name: `KasIn MCP Worker`
   - **Authorized redirect URIs**: add your deployed Worker callback URL:
     ```text
     https://<your-worker-subdomain>.workers.dev/oauth/callback
     ```
     _(For local testing with `npm run dev`, you can also add `http://localhost:8787/oauth/callback`.)_
4. Copy the **Client ID** and **Client Secret**.

---

## 3. Configure Wrangler Secrets & Deploy

Never commit secrets to `wrangler.toml`. Store them as encrypted Cloudflare Worker secrets:

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

Deploy to Cloudflare Workers:

```bash
npx wrangler deploy
```

Verify the health endpoint:

```bash
curl https://<your-worker-subdomain>.workers.dev/health
# {"status":"ok","service":"kasin-mcp-server","stateless":true}
```

---

## Deploy with Docker

You can also self-host `kasin-mcp-server` as a stateless Bun container (e.g., behind a reverse proxy or Cloudflare Tunnel).

### Option A: Prebuilt Docker Hub Image (`khad1r/kasin-mcp:latest`)

```bash
docker run -d \
  --name kasin-mcp \
  -p 8787:8787 \
  -e GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com \
  -e GOOGLE_CLIENT_SECRET=your-client-secret \
  khad1r/kasin-mcp:latest
```

Or using `docker-compose.yml`:

```yaml
services:
  kasin-mcp:
    image: khad1r/kasin-mcp:latest
    ports:
      - "${PORT:-8787}:8787"
    environment:
      - GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID}
      - GOOGLE_CLIENT_SECRET=${GOOGLE_CLIENT_SECRET}
    restart: unless-stopped
```

### Option B: Build Locally (`docker compose up -d`)

1. Create a `.env` file in `mcp-server/` (or export these variables in your shell):

   ```dotenv
   GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=your-client-secret
   PORT=8787
   ```

   _(Remember to add your public HTTPS callback URL, e.g. `https://mcp.yourdomain.com/oauth/callback`, to **Authorized redirect URIs** in Google Cloud Console.)_

2. Build and start the container:

   ```bash
   cd mcp-server
   docker compose up -d
   ```

3. Verify the health endpoint:

   ```bash
   curl http://localhost:8787/health
   # {"status":"ok","service":"kasin-mcp-server","stateless":true}
   ```

To run directly with Bun without Docker:

```bash
npm run start:docker
```

---

## 4. Connect to Claude Web & Google Gemini Web

### Claude Web (`claude.ai`)

1. Open **Settings → Connectors** (or **Integrations**).
2. Click **Add custom connector**.
3. Enter your MCP endpoint URL:
   ```text
   https://<your-worker-subdomain>.workers.dev/mcp
   ```
4. Complete the Google OAuth consent flow when prompted.
5. All 10 KasIn tools (`catat_transaksi`, `get_transaksi`, `update_transaksi`, `get_rekening`, `get_kelompok`, `get_harta`, `list_wishlist`, `add_wishlist`, `update_wishlist`, `delete_wishlist`), the `kasin://system_prompt` resource, and the `Transaksi` prompt are now available.

### Google Gemini Web (`gemini.google.com`)

1. Open **Settings → Extensions / Connected Apps / MCP** (where custom remote MCP servers are supported).
2. Add a new remote MCP server URL:
   ```text
   https://<your-worker-subdomain>.workers.dev/mcp
   ```
3. Sign in with your Google account when prompted to grant `drive.appdata` access.

### Cloudflare MCP Portal

1. In **Cloudflare Zero Trust → Access → AI Controls → MCP Servers**, add your server:
   - **URL:** `https://<your-worker-subdomain>.workers.dev/mcp`
   - **Authentication:** **OAuth** (auto-discovered via `/.well-known/oauth-protected-resource/mcp`)
2. Attach it to your existing **MCP Portal** and connect your AI clients to the Portal URL.

---

## Local Development

Create `mcp-server/.dev.vars` (gitignored):

```dotenv
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
```

Then run:

```bash
npm run dev
```

Type-check with:

```bash
npm run typecheck
```
