import type { Env } from "../env";
import { cfg } from "../env";
import { parseZodError, scrapeRequestSchema } from "../schemas";
import { getAuth } from "../lib/auth";
import { checkCredits, spendCredits } from "../lib/credits";
import { rateLimit, rateLimitHeaders } from "../lib/ratelimit";
import { cacheKeyFor } from "../lib/robots";
import { scrapeUrl } from "../lib/scrape";
import { err } from "../lib/utils";

type C = any;

const baseFormats = (body: { formats?: Array<{ type: string }> }) => {
  const f = body.formats?.map(x => x.type) ?? ["markdown"];
  return new Set(f);
};

export async function scrapeHandler(c: C) {
  const auth = getAuth(c);
  const rl = await rateLimit(c.env, `scrape:${auth.teamId}`, 60, 60);
  if (!rl.allowed) {
    return c.json(
      { success: false, code: "RATE_LIMIT", error: "Rate limit exceeded." },
      429,
    );
  }
  const parsed = scrapeRequestSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json(parseZodError(parsed.error), 400);
  const body = parsed.data;

  const credits = await checkCredits(c.env, auth.teamId, auth.keyMonthlyLimit, auth.keyId);
  if (!credits.ok) {
    return c.json(
      { success: false, code: "INSUFFICIENT_CREDITS", error: "Monthly credit limit reached." },
      402,
    );
  }

  const timeoutMs = Math.min(body.timeout ?? cfg(c.env).scrapeTimeoutMs, 60_000);

  // KV cache: exact-URL hits within maxAge (default 1h when useCache set).
  const maxAge = body.useCache === false ? 0 : (body.maxAge ?? 3600);
  const key = await cacheKeyFor(body.url);
  if (maxAge > 0) {
    try {
      const hit = await c.env.CACHE.get(key, "json");
      if (hit) {
        await spendCredits(c.env, auth.teamId, "scrape", 1, auth.keyId);
        return c.json(hit, 200, rateLimitHeaders(rl.remaining));
      }
    } catch {
      /* cache miss */
    }
  }

  const doc = await scrapeUrl(c.env, body.url, { timeoutMs });
  if (doc.error) {
    return c.json(
      { success: false, code: "SCRAPE_FAILED", error: `${body.url}: ${doc.error}` },
      422,
    );
  }
  const wants = baseFormats(body);
  const data: Record<string, unknown> = {
    url: doc.url,
    title: doc.title,
    description: doc.description,
    statusCode: doc.statusCode,
  };
  if (wants.has("markdown")) data.markdown = doc.markdown;
  if (wants.has("html") || wants.has("rawHtml")) data.html = doc.html;
  if (wants.has("text")) data.text = doc.text;
  if (wants.has("links")) data.links = doc.links;
  if (wants.has("screenshot")) {
    data.screenshot = null;
    data.screenshotNote =
      "Screenshots need Browser Rendering (paid plan) — set REMOTE_RENDER_URL to a self-hosted renderer, or drop this format.";
  }

  const response = { success: true as const, data };
  if (maxAge > 0) {
    c.executionCtx.waitUntil(
      c.env.CACHE.put(key, JSON.stringify(response), {
        expirationTtl: Math.min(maxAge, 86_400),
      }).catch(() => undefined),
    );
  }
  await spendCredits(c.env, auth.teamId, "scrape", 1, auth.keyId);
  return c.json(response, 200, rateLimitHeaders(rl.remaining));
}

export async function crawlStatusShim(c: C) {
  return c.json(err("Use /v2/crawl/:jobId — see migration notes.", "NOT_FOUND"), 404);
}
