# Slim Router

A hardened, ultra-slim personal AI routing & observability gateway dedicated to **Google Vertex AI** (`vertex`, `vertex-partner`) and **Google AI Studio** (`gemini`).

Built on a **Pure Node.js 26 LTS** HTTP server (zero Next.js), built-in **`node:sqlite`** (3-file split database with forever retention), **Vite 6 + React 19 + Tailwind CSS v4 + shadcn/ui** dashboard, and **only 4 production runtime dependencies** (`bcryptjs`, `jose`, `undici`, `uuid`).

> **Attribution & Fork Notice**  
> This project is a hard-pruned, security-hardened personal fork of [**decolua/9router**](https://github.com/decolua/9router) (upstream commit `1855aa44`, MIT License).  
> Core protocol translators (`open-sse`) and routing concepts originate from `decolua/9router` and its contributors. See [LICENSE](./LICENSE) for full copyright and license terms.

---

## Key Highlights

### 1. Focused Google AI Multimodal Gateway
- **Providers**: Google Vertex AI (Service Account JSON / ADC JSON / Vertex API Key), Google AI Studio (`x-goog-api-key`), and Vertex AI Partner Models (MaaS).
- **Full Multimodal & SDK Compatibility**:
  - OpenAI-compatible: `POST /v1/chat/completions`, `POST /v1/responses`, `POST /v1/embeddings`, `POST /v1/images/generations`, `POST /v1/audio/speech`, `POST /v1/audio/transcriptions`, `GET /v1/models`
  - Anthropic-compatible: `POST /v1/messages`, `POST /v1/messages/count_tokens`
  - Native Gemini: `GET/POST /v1beta/models/*`
  - Vertex Veo Video: `/v1/videos/{generations,edits,extensions,:id}`
- **Reliability**: Model Combos (priority fallback chains), Model Aliases, and Multi-Account/Key failover.

### 2. Enterprise-Grade Security Hardening
- **Fail-Closed Startup**: Refuses to boot without strong `JWT_SECRET`, `API_KEY_SECRET`, `ENCRYPTION_KEY`, and `ADMIN_PASSWORD` / `ADMIN_PASSWORD_HASH` (no default `123456`, no unauthenticated mode).
- **Zero-Plaintext Storage**:
  - Provider secrets encrypted at rest with **AES-256-GCM + AAD** (`enc:v1:...`) and verified on every boot via a **Vault Canary**.
  - Client API keys (`sk-9r_...`) stored strictly as **HMAC-SHA256** hashes (`timingSafeEqual`); shown once on creation.
- **No Auth Bypasses**: Strict API key verification on all `/v1/*` and `/v1beta/*` endpoints (zero localhost or CLI header bypasses).
- **Reverse-Proxy & Brute-Force Hardening**: Rightmost untrusted `X-Forwarded-For` parsing against `TRUSTED_PROXY_IPS`, internal `PEER_TOKEN` header stamping, bcrypt cost 12 with `sessionVersion` session revocation, CSRF `Origin`/`Referer` enforcement, and strict HTTP security headers.
- **2-Tier Anti-DNS-Rebinding SSRF Guard**: Strict TLS (`rejectUnauthorized: true`) + `undici` `connect.lookup` blocking loopback, RFC1918, CGNAT, IPv6 ULA/mapped, and cloud metadata (`169.254.169.254`, `fe80::/10`).
- **Per-Key Governance**: Model allow-lists, expiry, sliding-window RPM/TPM limits (`429`), and daily/monthly USD budget caps (`402`) with atomic in-flight pre-reservation.
- **Hardened Docker Runtime**: Non-root `USER node`, `read_only: true` rootfs, `tmpfs` `/tmp`, `cap_drop: [ALL]`, `no-new-privileges:true`, bound to `127.0.0.1:20128`.

### 3. Observability, Tracing & Dynamic Live Pricing (Forever Retention)
- **3-File Split `node:sqlite` Architecture** (`DATA_DIR/db/`):
  - `config.sqlite`: Encrypted connections, HMAC keys, combos, aliases, settings, live & overridden pricing.
  - `telemetry.sqlite`: Forever-retained `request_traces` (UUIDv7 `X-Trace-Id`), `trace_spans` waterfall, and `metrics_hourly` / `metrics_daily` rollups.
  - `payloads.sqlite`: Dedicated `node:worker_threads` sanitizer strips multimodal base64 binary to `{ _media, mimeType, bytes, sha256 }` metadata, redacts secrets & `?key=` query params, and gzip-compresses payloads into BLOBs.
- **Zero Hardcoded Pricing**: Live pricing synced from `https://models.dev/api.json` (`google`, `google-vertex`, `google-vertex-anthropic`) into `config.sqlite`, with per-model manual overrides and on-demand sync in the Dashboard.
- **Accurate Metrics**: Canonical prompt token normalization (`prompt_tokens = uncached_input + cached_read + cache_write`), net cache savings, streaming-only TPOT & tokens/sec (`NULL` for non-streaming), log-linear p50/p95/p99 latency/TTFT histograms, and daily atomic `VACUUM INTO` hot backups.

---

## Architecture

```text
slim-router/
├── server/          # Pure Node 26 HTTP server, ESM loader hook, hardened middleware & route table
├── src/             # Auth, AES-256-GCM vault, 3-file node:sqlite repos, tracer, governance, API handlers
├── open-sse/        # Protocol translators (OpenAI/Responses/Claude <-> Gemini/Vertex) & Vertex/Gemini adapters
├── client/          # Vite 6 + React 19 + Tailwind CSS v4 + shadcn/ui SPA (zero-dep SVG charts)
├── scripts/         # End-to-end security, DB, pricing & server verification suite
├── Dockerfile       # 3-stage slim Node 26 Alpine image (4 prod deps in runner)
└── docker-compose.yml
```

---

## Quick Start (Docker)

```bash
git clone https://github.com/fizray/slim-router.git
cd slim-router
cp .env.example .env
```

Generate strong secrets in `.env`:

```bash
# Required secrets
JWT_SECRET=$(openssl rand -hex 32)
API_KEY_SECRET=$(openssl rand -hex 32)
ENCRYPTION_KEY=$(openssl rand -hex 32)
ADMIN_PASSWORD="ReplaceWithAStrongPassword!2026"
```

Build and start the hardened container (binds strictly to `127.0.0.1:20128` for your HTTPS reverse proxy or VPN/Tailscale):

```bash
docker compose up -d --build
```

Open `http://127.0.0.1:20128` (or your reverse proxy domain), sign in with `ADMIN_PASSWORD`, add your **Vertex AI** or **Google AI Studio** credentials, click **Sync Live Pricing** in **Cost & Pricing**, and generate an API key (`sk-9r_...`).

---

## Local Development & Verification

Requires **Node.js >= 26.0.0**.

```bash
npm install
npm run build        # Builds Vite + shadcn/ui SPA into dist/
npm run verify       # Runs 8-check security, vault, pricing, SSRF, governance, SQLite & live server suite
```

Run in development mode:

```bash
# Terminal 1: Node 26 API & Gateway Server (port 20128)
npm run dev:server

# Terminal 2: Vite Frontend Dev Server (port 20127, proxies /api, /v1, /v1beta)
npm run dev:client
```

---

## License

MIT License — see [LICENSE](./LICENSE).  
Original upstream project: [decolua/9router](https://github.com/decolua/9router).
