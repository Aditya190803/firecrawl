import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { bodyLimit } from "hono/body-limit";
import type { Env } from "../env";
import type { AuthInfo } from "../lib/auth";
import { sha256Hex } from "../lib/utils";
import { scrapeHandler } from "./scrape";
import { searchHandler } from "./search";
import { mapHandler } from "./map";
import { crawlStartHandler, jobStatusHandler } from "./async-jobs";

type PlaygroundEnv = { Bindings: Env; Variables: { auth: AuthInfo } };
const cookieName = "fc_playground";
const sessionTTL = 86400;
interface SavedRun {
  id: string;
  endpoint: string;
  input: string;
  createdAt: string;
  status: number;
  duration: number;
  result: Record<string, unknown>;
}

// KV limits are approximate across concurrent edge locations. Unlike the API's
// limiter, the public demo fails closed if KV is unavailable.
async function allow(env: Env, key: string, limit: number, seconds: number) {
  const bucket = Math.floor(Date.now() / (seconds * 1000));
  const name = `playground:limit:${key}:${bucket}`;
  const count = Number(await env.CACHE.get(name) || 0);
  if (count >= limit) return false;
  await env.CACHE.put(name, String(count + 1), { expirationTtl: seconds * 2 });
  return true;
}

export const playground = new Hono<PlaygroundEnv>();
playground.onError((_error, c) => c.json({ success: false, error: "The playground is temporarily unavailable. Please try again." }, 503));
playground.use("*", bodyLimit({ maxSize: 8192 }));
playground.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  const origin = new URL(c.req.url).origin;
  let source = c.req.header("origin");
  if (!source && c.req.method === "GET") {
    try { source = new URL(c.req.header("referer") || "").origin; } catch { /* no source */ }
  }
  if (source !== origin) return c.json({ success: false, error: "Use the playground on this website." }, 403);
  await next();
});

playground.post("/session", async c => {
  const existing = getCookie(c, cookieName);
  if (existing && await c.env.CACHE.get(`playground:session:${await sha256Hex(existing)}`)) {
    return c.json({ success: true });
  }
  const ip = await sha256Hex(c.req.header("cf-connecting-ip") || "local");
  if (!await allow(c.env, `sessions:${ip}`, 10, 60)) {
    return c.json({ success: false, error: "Too many playground sessions. Try again in a minute." }, 429);
  }
  const token = crypto.randomUUID() + crypto.randomUUID();
  await c.env.CACHE.put(`playground:session:${await sha256Hex(token)}`, "1", { expirationTtl: sessionTTL });
  setCookie(c, cookieName, token, {
    httpOnly: true, sameSite: "Strict", secure: new URL(c.req.url).protocol === "https:",
    path: "/playground", maxAge: sessionTTL,
  });
  return c.json({ success: true });
});

playground.use("*", async (c, next) => {
  const token = getCookie(c, cookieName);
  const hash = token ? await sha256Hex(token) : "";
  if (!hash || !await c.env.CACHE.get(`playground:session:${hash}`)) {
    return c.json({ success: false, error: "Playground session expired. Run the request again." }, 401);
  }
  const ip = await sha256Hex(c.req.header("cf-connecting-ip") || "local");
  const polling = c.req.method === "GET";
  if (!await allow(c.env, `${polling ? "poll" : "run"}:${ip}`, polling ? 120 : 5, 60)
    || (!polling && !await allow(c.env, `daily:${ip}`, 50, 86400))) {
    return c.json({ success: false, error: "Playground limit reached. Please try later, or use an API key in your app." }, 429);
  }
  c.set("auth", { teamId: `playground:${hash}`, keyId: null, keyPrefix: null, rateLimitPerMin: 5, keyMonthlyLimit: 0 });
  await next();
});

playground.get("/crawl/:jobId", c => jobStatusHandler(c, "crawl"));
playground.get("/runs/:runId", async c => {
  const id = c.req.param("runId");
  if (!/^[a-f0-9-]{36}$/.test(id)) return c.json({ success: false, error: "Run not found." }, 404);
  const run = await c.env.CACHE.get<SavedRun>(`playground:run:${c.get("auth").teamId}:${id}`, "json");
  if (!run) return c.json({ success: false, error: "Run not found or expired. Runs are available in this browser for 24 hours." }, 404);
  if (run.endpoint === "crawl" && typeof run.result.id === "string") {
    const inner = new Hono<PlaygroundEnv>();
    inner.use("*", async (ctx, next) => { ctx.set("auth", c.get("auth")); await next(); });
    inner.get("/:jobId", ctx => jobStatusHandler(ctx, "crawl"));
    const response = await inner.fetch(new Request(new URL(`/${run.result.id}`, c.req.url)), c.env, c.executionCtx);
    if (response.ok) run.result = await response.json() as Record<string, unknown>;
  }
  return c.json({ success: true, data: run });
});

const bounded = (value: unknown, fallback: number, max: number, min = 1) =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : fallback;

playground.post("/:endpoint", async c => {
  const endpoint = c.req.param("endpoint");
  if (!["scrape", "search", "map", "crawl"].includes(endpoint)) {
    return c.json({ success: false, error: "This endpoint requires an API key. See the API docs." }, 404);
  }
  const raw = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return c.json({ success: false, error: "Expected a JSON object." }, 400);
  let body: Record<string, unknown>;
  if (endpoint === "search") {
    body = { query: typeof raw.query === "string" ? raw.query.slice(0, 500) : raw.query, limit: bounded(raw.limit, 5, 5) };
  } else {
    body = { url: raw.url };
    if (endpoint === "scrape") {
      const formats = Array.isArray(raw.formats) ? raw.formats : [{ type: "markdown" }];
      body.formats = formats.filter(f => f && ["markdown", "html", "rawHtml", "text", "links"].includes(f.type)).slice(0, 5).map(f => ({ type: f.type }));
      if (!(body.formats as unknown[]).length) return c.json({ success: false, error: "Choose markdown, HTML, text, or links." }, 400);
      body.timeout = bounded(raw.timeout, 15000, 15000, 1000);
      body.onlyMainContent = raw.onlyMainContent !== false;
      // Existing cache entries are keyed by URL, not format. Bypass that cache so
      // format switches in the playground always produce the requested output.
      body.useCache = false;
    } else if (endpoint === "map") {
      Object.assign(body, { limit: bounded(raw.limit, 10, 20), includeSubdomains: false, search: typeof raw.search === "string" ? raw.search.slice(0, 100) : undefined });
    } else {
      Object.assign(body, { limit: bounded(raw.limit, 5, 5), maxDepth: bounded(raw.maxDepth, 2, 2, 0), allowExternalLinks: false, includeSubdomains: false, scrapeOptions: { timeout: 15000, formats: [{ type: "markdown" }] } });
    }
  }
  // Dispatch only the allowlisted, bounded request. Never forward a master key
  // or expose a generic proxy to authenticated endpoints.
  const handler = { scrape: scrapeHandler, search: searchHandler, map: mapHandler, crawl: crawlStartHandler }[endpoint]!;
  const inner = new Hono<PlaygroundEnv>();
  inner.use("*", async (ctx, next) => { ctx.set("auth", c.get("auth")); await next(); });
  inner.post("/", handler);
  const started = Date.now();
  const response = await inner.fetch(new Request(new URL("/", c.req.url), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }), c.env, c.executionCtx);
  const result = await response.json() as Record<string, unknown>;
  if (endpoint === "crawl" && response.ok) result.url = `/playground/crawl/${result.id}`;
  const id = crypto.randomUUID();
  const run: SavedRun = { id, endpoint, input: String(body.url || body.query || ""), createdAt: new Date().toISOString(), status: response.status, duration: Date.now() - started, result };
  await c.env.CACHE.put(`playground:run:${c.get("auth").teamId}:${id}`, JSON.stringify(run), { expirationTtl: sessionTTL });
  return new Response(JSON.stringify({ ...result, runId: id }), {
    status: response.status, headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
});
