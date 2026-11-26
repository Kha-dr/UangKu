# KasIn Remote MCP Server (`mcp-server/`)

Stateless MCP server (`POST /mcp`) for **Claude Web**, **Gemini Web**, and **Cloudflare MCP Portal**. Your `kasin.sqlite` file stays in your own Google Drive `appDataFolder` — the server doesn't store user tokens or databases.

## Prerequisites

- Node.js 18+
- A Google Cloud project with **Google Drive API** enabled
- A Cloudflare Workers account (or Docker / Bun for self-hosting)

## 1. Google Cloud OAuth Setup

1. In [Google Cloud Console](https://console.cloud.google.com/), enable **Google Drive API**.
2. On **OAuth consent screen**, add `https://www.googleapis.com/auth/drive.appdata`.
   - Add yourself under **Test users** while testing, or switch to **In production** so refresh tokens don't expire every 7 days.
3. Create an **OAuth client ID** (Web application) and add your callback URL to **Authorized redirect URIs**:
   - Cloudflare Workers: `https://<your-worker-subdomain>.workers.dev/oauth/callback`
   - Self-hosted / Docker: `https://<your-domain>/oauth/callback`
   - Local dev: `http://localhost:8787/oauth/callback`
4. Copy the **Client ID** and **Client Secret**.

## 2. Deploy

### Cloudflare Workers

```bash
cd mcp-server
npm install
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler deploy
```

Check `/health`:

```bash
curl https://<your-worker-subdomain>.workers.dev/health
```

### Docker (Prebuilt Image)

```bash
docker run -d \
  --name kasin-mcp \
  -p 8787:8787 \
  -e GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com \
  -e GOOGLE_CLIENT_SECRET=your-client-secret \
  khad1r/kasin-mcp:latest
```

Or with Docker Compose (`khad1r/kasin-mcp:latest`):

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

### Docker (Build Locally)

1. Create `mcp-server/.env`:
   ```dotenv
   GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=your-client-secret
   PORT=8787
   ```
2. Start it behind HTTPS (Caddy, Nginx, or Cloudflare Tunnel):
   ```bash
   cd mcp-server
   docker compose up -d
   ```

Or run directly with Bun: `npm run start:docker`.

## 3. Connect Your AI Client

- **Claude Web:** Settings → Connectors → Add custom connector → `https://<your-domain>/mcp`, then sign in with Google.
- **Gemini Web:** Settings → Extensions / MCP → add `https://<your-domain>/mcp`, then sign in with Google.
- **Cloudflare MCP Portal:** In Zero Trust → Access → AI Controls → MCP Servers, add `https://<your-domain>/mcp` with **OAuth** auth and attach it to your Portal.

## Token Refresh

- Login requests `access_type=offline`, so your MCP client or Cloudflare MCP Portal gets a refresh token and renews expired 1-hour access tokens automatically.
- Keep your Google OAuth consent screen **In production** (verification isn't required for personal use) to avoid Google's 7-day Testing token expiry.

## Local Development

Create `mcp-server/.dev.vars`:

```dotenv
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
```

```bash
cd mcp-server
npm run dev
npm run typecheck
```
