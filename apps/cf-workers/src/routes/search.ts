import type { Env } from "../env";
import { parseZodError, searchRequestSchema } from "../schemas";
import { getAuth } from "../lib/auth";
import { checkCredits, spendCredits } from "../lib/credits";
import { runSearch } from "../lib/search";
import { scrapeUrl } from "../lib/scrape";

type C = any;

export async function searchHandler(c: C) {
  const auth = getAuth(c);
  const parsed = searchRequestSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json(parseZodError(parsed.error), 400);
  const body = parsed.data;

  const credits = await checkCredits(c.env, auth.teamId, auth.keyMonthlyLimit, auth.keyId);
  if (!credits.ok) {
    return c.json(
      { success: false, code: "INSUFFICIENT_CREDITS", error: "Monthly credit limit reached." },
      402,
    );
  }

  let hits = await runSearch(c.env, body.query, body.limit, { lang: body.lang }).catch(
    (e: Error) => ({ __error: e.message }) as const,
  );
  if ("__error" in hits) {
    return c.json(
      { success: false, code: "SEARCH_FAILED", error: hits.__error },
      502,
    );
  }

  if (body.includeDomains.length > 0) {
    const allow = body.includeDomains.map(d => d.toLowerCase());
    hits = hits.filter(h => {
      try {
        return allow.some(d => new URL(h.url).hostname.toLowerCase().includes(d));
      } catch {
        return false;
      }
    });
  }
  if (body.excludeDomains.length > 0) {
    const deny = body.excludeDomains.map(d => d.toLowerCase());
    hits = hits.filter(h => {
      try {
        return !deny.some(d => new URL(h.url).hostname.toLowerCase().includes(d));
      } catch {
        return true;
      }
    });
  }

  // Optional scrape-back (same as upstream `scrapeOptions` on search).
  let data = hits.map(h => ({ ...h, markdown: undefined as string | undefined }));
  if (body.scrapeOptions) {
    const jobs = hits.slice(0, Math.min(hits.length, 10)).map(async h => {
      const doc = await scrapeUrl(c.env, h.url, {
        timeoutMs: Math.min(body.scrapeOptions?.timeout ?? 20_000, 30_000),
      });
      return { ...h, markdown: doc.error ? undefined : doc.markdown };
    });
    data = await Promise.all(jobs);
  }

  await spendCredits(c.env, auth.teamId, "search", 1, auth.keyId);
  return c.json({ success: true, data });
}
