/**
 * Shared Cloudflare bindings + env knobs.
 * Everything here is free-tier: Workers, D1, KV, Queues, R2, Workers AI.
 * Browser Rendering is NOT used (paid plan required).
 */

export interface Env {
  API_KEY?: string;
  DB: D1Database;
  CACHE: KVNamespace;
  DOCS: R2Bucket;
  WORK_QUEUE: Queue;
  WORK_DLQ: Queue;
  AI?: Ai;
  BROWSER?: Fetcher; // optional: only if user binds Browser Rendering (paid). Unused by default.

  MONTHLY_CREDIT_LIMIT?: string;
  DEFAULT_SCRAPE_TIMEOUT_MS?: string;
  MAX_CRAWL_PAGES?: string;
  MAX_CRAWL_DEPTH?: string;
  SEARCH_PROVIDER?: string;
  SERPER_API_KEY?: string;
  TAVILY_API_KEY?: string;
  BRAVE_API_KEY?: string;
  REMOTE_RENDER_URL?: string;
  REMOTE_RENDER_SECRET?: string;
}

export const num = (v: string | undefined, fallback: number): number => {
  const n = v === undefined || v === "" ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

export const cfg = (env: Env) => ({
  monthlyCreditLimit: num(env.MONTHLY_CREDIT_LIMIT, 0), // 0 = unlimited
  scrapeTimeoutMs: num(env.DEFAULT_SCRAPE_TIMEOUT_MS, 30_000),
  maxCrawlPages: num(env.MAX_CRAWL_PAGES, 100),
  maxCrawlDepth: num(env.MAX_CRAWL_DEPTH, 5),
  searchProvider: (env.SEARCH_PROVIDER ?? "duckduckgo").toLowerCase(),
});
