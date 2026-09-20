# Firecrawl CF Console (Pages mirror)

Static single-page console for the Workers API in `../cf-workers`. No build step,
no framework, no backend. `index.html` here is a byte-for-byte mirror of
`../cf-workers/public/index.html`, which is the canonical copy served from the
Worker custom domain. Edit that file, then copy it here.

Sessions and API keys stay in the browser's `localStorage`; nothing is sent
anywhere except your worker.

## Base URL

The console calls the origin it is served from. On `*.pages.dev` that is not the
API, so it falls back to the Worker domain (`WORKER_ORIGIN` near the top of the
script). The control in the header overrides it per browser.

## Run locally

Open `index.html` directly, or serve it:

```bash
npm run dev   # http://localhost:8788
```

## Deploy (free, Cloudflare Pages)

```bash
cd apps/cf-console
npx wrangler pages project create firecrawl-cf-console --production-branch main
npm run deploy
```

## Sections

Overview (credits, requests, daily curve, jobs) · API keys (per-key rate limit
and monthly cap) · People (invites and password resets, admin only) · Tester
(every endpoint, live, with copy-as-curl and auto-polling for crawl and batch) ·
Docs (request shapes, SDK snippets, error codes).
