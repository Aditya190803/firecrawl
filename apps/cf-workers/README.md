# Firecrawl on Cloudflare Workers (free tier only)

A full port of the Firecrawl API (`apps/api`, Express + Postgres + Redis +
BullMQ + Playwright/fire-engine) to **100% free-tier Cloudflare**: Workers +
D1 + KV + Queues + R2 (+ optional Workers AI). No paid bindings anywhere —
Browser Rendering is deliberately not used.

## What works

| Endpoint | Status |
|---|---|
| `POST /v2/scrape`, `/v1/scrape`, `/v0/scrape` | ✅ fetch + cheerio readability, KV cache |
| `POST /v2/map`, `/v1/map` | ✅ sitemap + homepage links |
| `POST /v2/search`, `/v1/search`, `/v0/search` | ✅ DuckDuckGo keyless (or Serper/Tavily/Brave with your key) |
| `POST /v2/crawl` + status/cancel/errors/ongoing | ✅ Queues fan-out + D1 state |
| `POST /v2/batch/scrape` + status/cancel/errors | ✅ Queues + D1 state |
| `POST /v2/extract`, `GET /v2/extract/:id` | ✅ needs Workers AI `[ai]` (free 10k neurons/day) |
| `POST /v2/agent` (+ status/cancel) | ✅ needs Workers AI |
| `POST /v1/deep-research`, `POST /v2/llmstxt` | ✅ needs Workers AI / fetch only |
| team credit-usage/history, token-usage, queue-status, activity, concurrency-check | ✅ D1 ledger |
| threat-protection + SIEM get/put | ✅ KV-backed prefs |
| monitors CRUD + run | ✅ KV-backed |
| v0/v1 compat shims | ✅ |
| `GET /health`, `/admin/status`, `/docs` | ✅ |
| browsers (`/v2/browser*`, interact, screenshots), WS crawl status, Slack, support proxy, exchange, labs, parse uploads, research proxy | ❌ 501 with reason (need paid plans / hosted services) |

## Deploy (all free)

```bash
cd apps/cf-workers
npm install

# 1. login + create resources (each has a free tier)
npx wrangler login
npx wrangler kv:namespace create CACHE
npx wrangler d1 create firecrawl-db
npx wrangler queues create firecrawl-jobs
npx wrangler queues create firecrawl-jobs-dlq
npx wrangler r2 bucket create firecrawl-docs

# 2. paste the returned IDs into wrangler.toml (CACHE id/preview_id, DB database_id)

# 3. migrate D1 + set your key
npx wrangler d1 migrations apply firecrawl-db --remote
npm run keygen          # prints a fc-... key
npx wrangler secret put API_KEY

# 4. (optional) seed a D1-backed key instead of the master key:
API_KEY=fc-... npm run seed:key   # prints the SQL, then run it via d1 execute

# 5. deploy
npm run deploy
```

Local dev: `npm run dev` (needs the same IDs in `wrangler.toml`; use
`npm run db:migrate:local` for the local D1).

## Config (all optional, all free)

| Var | Default | Notes |
|---|---|---|
| `API_KEY` (secret) | open mode | master key; when set, all `/v*` routes require it |
| `MONTHLY_CREDIT_LIMIT` | `0` (unlimited) | set e.g. `1000` to enforce a cap |
| `SEARCH_PROVIDER` | `duckduckgo` | or `serper`/`tavily`/`brave` + matching `*_API_KEY` secret |
| `REMOTE_RENDER_URL` (+`REMOTE_RENDER_SECRET`) | unset | POST `{url}` → `{html,status,url}` passthrough to a self-hosted renderer for JS-heavy pages |
| `MAX_CRAWL_PAGES` / `MAX_CRAWL_DEPTH` | `100` / `5` | queue fan-out bounds |
| `DEFAULT_SCRAPE_TIMEOUT_MS` | `30000` | capped at 60s (Workers subrequest discipline) |

Remove the `[ai]` block from `wrangler.toml` if you never use extract/agent —
nothing else needs it.

## SDKs

Point any Firecrawl SDK at your worker:

```ts
import Firecrawl from "firecrawl";
const app = new Firecrawl({ apiKey: process.env.API_KEY, apiUrl: "https://firecrawl-cf.<you>.workers.dev" });
await app.scrape("https://example.com", { formats: ["markdown"] });
await app.crawl("https://example.com", { limit: 20 });
await app.map("https://example.com");
await app.search("firecrawl");
```

## Architecture

```
fetch → Hono router (src/index.ts)
  ├─ auth (API_KEY secret or D1 api_keys, else open local mode)
  ├─ scrape: fetch(+REMOTE_RENDER_URL) → cheerio readability → KV cache
  ├─ map: sitemap.xml + homepage links
  ├─ search: DuckDuckGo HTML (or keyed provider) + optional scrape-back
  ├─ crawl/batch: D1 jobs + job_pages, fan-out via Queues (queue() consumer)
  ├─ extract/agent/deep-research: Workers AI llama-3.1-8b over scraped markdown
  └─ credits: D1 usage_log (unlimited unless MONTHLY_CREDIT_LIMIT set)
```

## Tests

```bash
npm test   # 19 vitest tests, all offline with fake D1/KV/Queue bindings
```
