# Firecrawl CF Console (playground UI)

Static single-page console for the Workers API in `../cf-workers`. No build
step, no framework, no backend — one `index.html` (~15KB). API keys stay in
the browser's `localStorage`; nothing is sent anywhere except your worker.

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

Point the page at your worker (default is baked in, editable in the UI):
`https://firecrawl-cf.<you>.workers.dev`

## Tabs

Scrape · Map · Search · Crawl (auto-poll) · Batch (auto-poll) · Extract ·
Summarize (template endpoint demo) · Job status · Credits.

Each tab shows the endpoint description, runs live against the worker, prints
status + latency + JSON, and offers **Copy as curl** plus an SDK snippet.
