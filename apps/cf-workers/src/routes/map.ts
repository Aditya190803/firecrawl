import type { Env } from "../env";
import { cfg } from "../env";
import { mapRequestSchema, parseZodError } from "../schemas";
import { getAuth } from "../lib/auth";
import { checkCredits, spendCredits } from "../lib/credits";
import { discoverSitemaps, robotsAllowed } from "../lib/robots";
import { scrapeUrl } from "../lib/scrape";
import { sameDomain } from "../lib/utils";

type C = any;

const matchesAny = (url: string, patterns: string[]): boolean => {
  if (patterns.length === 0) return true;
  const path = (() => {
    try {
      return new URL(url).pathname;
    } catch {
      return url;
    }
  })();
  return patterns.some(p => {
    try {
      return new RegExp(p).test(path) || path.startsWith(p);
    } catch {
      return path.startsWith(p);
    }
  });
};

/** Single-pass sitemap + homepage map. Free, synchronous, bounded. */
export async function mapHandler(c: C) {
  const auth = getAuth(c);
  const parsed = mapRequestSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json(parseZodError(parsed.error), 400);
  const body = parsed.data;

  const credits = await checkCredits(c.env, auth.teamId, auth.keyMonthlyLimit, auth.keyId);
  if (!credits.ok) {
    return c.json(
      { success: false, code: "INSUFFICIENT_CREDITS", error: "Monthly credit limit reached." },
      402,
    );
  }

  const origin = new URL(body.url).origin;
  const found = new Set<string>();

  // 1. Sitemap (best recall, 1 subrequest).
  try {
    const locs = await discoverSitemaps(c.env, origin);
    for (const loc of locs) {
      if (found.size >= body.limit) break;
      if (!body.includeSubdomains && !sameDomain(loc, body.url)) continue;
      if (body.search && !loc.toLowerCase().includes(body.search.toLowerCase())) continue;
      found.add(loc);
    }
  } catch {
    /* ignore */
  }

  // 2. Homepage links (1 subrequest) if sitemap was thin.
  if (found.size < Math.min(body.limit, 50)) {
    const allowed = await robotsAllowed(c.env, body.url, body.ignoreRobotsTxt);
    if (allowed || body.ignoreRobotsTxt) {
      const doc = await scrapeUrl(c.env, body.url, {
        timeoutMs: Math.min(cfg(c.env).scrapeTimeoutMs, 30_000),
      });
      for (const link of doc.links ?? []) {
        if (found.size >= body.limit) break;
        try {
          const u = new URL(link);
          if (!body.includeSubdomains && !sameDomain(link, body.url)) continue;
          void u;
        } catch {
          continue;
        }
        if (body.search && !link.toLowerCase().includes(body.search.toLowerCase())) continue;
        found.add(link);
      }
    }
  }

  const links = [...found].slice(0, body.limit).map(url => ({ url }));
  await spendCredits(c.env, auth.teamId, "map", 1, auth.keyId);
  return c.json({ success: true, links });
}

export { matchesAny };
