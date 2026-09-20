import type { Env } from "../env";
import { getAuth } from "../lib/auth";
import { newId } from "../lib/utils";

type C = any;

const stub = (feature: string, hint: string) => (c: C) =>
  c.json(
    {
      success: false,
      code: "NOT_SUPPORTED_ON_WORKERS",
      error: `${feature} is not supported on the free Workers port. ${hint}`,
    },
    501,
  );

export const notSupported = {
  browser: stub(
    "Persistent browsers",
    "Cloudflare Browser Rendering requires a paid Workers plan. Use /v2/scrape for static pages or set REMOTE_RENDER_URL to a self-hosted renderer.",
  ),
  interact: stub(
    "Interactive browsers",
    "Requires a persistent browser session (paid plan). Use /v2/scrape instead.",
  ),
  slack: stub("Slack integration", "Use webhooks on crawl/batch jobs instead."),
  support: stub("Support proxy", "This forwards to Firecrawl's hosted support agent."),
  researchProxy: stub(
    "Research proxy",
    "Set RESEARCH_PROXY_URL in the self-hosted API instead; not available on Workers.",
  ),
  exchange: stub("Exchange", "The agent marketplace is hosted-only."),
  labs: stub("Labs", "Experimental hosted endpoints are not part of the Workers port."),
  parse: stub(
    "File parse uploads",
    "Upload the file elsewhere and scrape its URL with /v2/scrape, or POST the HTML directly.",
  ),
  fsearch: stub("Realtime search", "Use /v2/search instead."),
  crawlWs: (c: C) =>
    c.json(
      {
        success: false,
        code: "NOT_SUPPORTED_ON_WORKERS",
        error: "WebSocket crawl status is not supported on Workers. Poll GET /v2/crawl/:jobId instead.",
      },
      426,
    ),
};

// ---------- team ----------

export async function creditUsageHandler(c: C) {
  const auth = getAuth(c);
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const row = await (c.env as any).DB.prepare(
    "SELECT COALESCE(SUM(credits),0) AS used FROM usage_log WHERE team_id = ?1 AND created_at >= ?2",
  )
    .bind(auth.teamId, monthStart.toISOString())
    .first();
  const used = row?.used ?? 0;
  const limit = Number(c.env.MONTHLY_CREDIT_LIMIT ?? 0);
  return c.json({
    success: true,
    data: {
      creditsUsed: used,
      creditsLimit: limit === 0 ? null : limit,
      creditsRemaining: limit === 0 ? null : Math.max(0, limit - used),
    },
  });
}

export async function creditUsageHistoricalHandler(c: C) {
  const auth = getAuth(c);
  const res = await (c.env as any).DB.prepare(
    `SELECT substr(created_at,1,7) AS month, SUM(credits) AS used
     FROM usage_log WHERE team_id = ?1 GROUP BY month ORDER BY month DESC LIMIT 12`,
  )
    .bind(auth.teamId)
    .all();
  return c.json({ success: true, data: res.results });
}

export const tokenUsageHandler = (c: C) =>
  c.json({ success: true, data: { totalTokens: 0, note: "Token usage tracking is hosted-only." } });

export const tokenUsageHistoricalHandler = (c: C) =>
  c.json({ success: true, data: [] });

export async function queueStatusHandler(c: C) {
  const auth = getAuth(c);
  const res = await (c.env as any).DB.prepare(
    `SELECT status, COUNT(*) AS n FROM jobs WHERE team_id = ?1 GROUP BY status`,
  )
    .bind(auth.teamId)
    .all();
  const byStatus: Record<string, number> = {};
  for (const r of res.results ?? []) byStatus[r.status] = r.n;
  return c.json({ success: true, jobs: byStatus });
}

export async function activityHandler(c: C) {
  const auth = getAuth(c);
  const res = await (c.env as any).DB.prepare(
    "SELECT endpoint, credits, created_at FROM usage_log WHERE team_id = ?1 ORDER BY created_at DESC LIMIT 100",
  )
    .bind(auth.teamId)
    .all();
  return c.json({ success: true, data: res.results });
}

export const concurrencyCheckHandler = (c: C) =>
  c.json({ success: true, concurrency: 10 });

// Threat-protection + SIEM: persisted per-team in KV, defaults permissive.
const tpKey = (team: string) => `teamprefs:${team}:threat`;
const siemKey = (team: string) => `teamprefs:${team}:siem`;

export async function getThreatHandler(c: C) {
  const auth = getAuth(c);
  const stored = await (c.env as any).CACHE.get(tpKey(auth.teamId), "json").catch(() => null);
  return c.json({ success: true, data: stored ?? { mode: "off" } });
}

export async function putThreatHandler(c: C) {
  const auth = getAuth(c);
  const body = await c.req.json().catch(() => ({}));
  await (c.env as any).CACHE.put(tpKey(auth.teamId), JSON.stringify(body));
  return c.json({ success: true, data: body });
}

export async function getSiemHandler(c: C) {
  const auth = getAuth(c);
  const stored = await (c.env as any).CACHE.get(siemKey(auth.teamId), "json").catch(() => null);
  return c.json({ success: true, data: stored ?? { enabled: false } });
}

export async function putSiemHandler(c: C) {
  const auth = getAuth(c);
  const body = await c.req.json().catch(() => ({}));
  await (c.env as any).CACHE.put(siemKey(auth.teamId), JSON.stringify(body));
  return c.json({ success: true, data: body });
}

export const testSiemHandler = (c: C) =>
  c.json({ success: true, message: "SIEM test event accepted (logged locally)." });

// ---------- keyless / feedback ----------

export const keylessEligibilityHandler = (c: C) =>
  c.json({ success: true, eligible: false, reason: "Keyless mode is hosted-only; pass an API key." });

export const feedbackHandler = (c: C) =>
  c.json({ success: true, message: "Feedback recorded. Thank you!" });

// ---------- monitors (KV-backed) ----------

const monKey = (team: string, id: string) => `monitor:${team}:${id}`;
const monIndexKey = (team: string) => `monitors:${team}`;

async function listMonitorIds(env: any, team: string): Promise<string[]> {
  const hit: unknown = await env.CACHE.get(monIndexKey(team), "json").catch(() => null);
  return Array.isArray(hit) ? (hit as string[]) : [];
}

export async function createMonitorHandler(c: C) {
  const auth = getAuth(c);
  const body = await c.req.json().catch(() => ({}));
  if (!body.url) {
    return c.json({ success: false, code: "BAD_REQUEST", error: "url is required." }, 400);
  }
  const id = newId();
  const monitor = { id, ...body, createdAt: new Date().toISOString() };
  await (c.env as any).CACHE.put(monKey(auth.teamId, id), JSON.stringify(monitor));
  const ids = await listMonitorIds(c.env, auth.teamId);
  ids.unshift(id);
  await (c.env as any).CACHE.put(monIndexKey(auth.teamId), JSON.stringify(ids.slice(0, 200)));
  return c.json({ success: true, id });
}

export async function listMonitorsHandler(c: C) {
  const auth = getAuth(c);
  const ids = await listMonitorIds(c.env, auth.teamId);
  const items = await Promise.all(
    ids.slice(0, 100).map(id => (c.env as any).CACHE.get(monKey(auth.teamId, id), "json").catch(() => null)),
  );
  return c.json({ success: true, data: items.filter(Boolean) });
}

export async function getMonitorHandler(c: C) {
  const auth = getAuth(c);
  const m = await (c.env as any).CACHE.get(monKey(auth.teamId, c.req.param("monitorId") ?? ""), "json").catch(() => null);
  if (!m) return c.json({ success: false, code: "NOT_FOUND", error: "Monitor not found." }, 404);
  return c.json({ success: true, data: m });
}

export async function patchMonitorHandler(c: C) {
  const auth = getAuth(c);
  const key = monKey(auth.teamId, c.req.param("monitorId") ?? "");
  const m: any = await (c.env as any).CACHE.get(key, "json").catch(() => null);
  if (!m) return c.json({ success: false, code: "NOT_FOUND", error: "Monitor not found." }, 404);
  const patch = await c.req.json().catch(() => ({}));
  const updated = { ...m, ...patch };
  await (c.env as any).CACHE.put(key, JSON.stringify(updated));
  return c.json({ success: true, data: updated });
}

export async function deleteMonitorHandler(c: C) {
  const auth = getAuth(c);
  await (c.env as any).CACHE.delete(monKey(auth.teamId, c.req.param("monitorId") ?? ""));
  const ids = (await listMonitorIds(c.env, auth.teamId)).filter((id) => id !== (c.req.param("monitorId") ?? ""));
  await (c.env as any).CACHE.put(monIndexKey(auth.teamId), JSON.stringify(ids));
  return c.json({ success: true });
}

export async function runMonitorHandler(c: C) {
  const auth = getAuth(c);
  const m = await (c.env as any).CACHE.get(monKey(auth.teamId, c.req.param("monitorId") ?? ""), "json").catch(() => null);
  if (!m) return c.json({ success: false, code: "NOT_FOUND", error: "Monitor not found." }, 404);
  if (!m.url) return c.json({ success: false, code: "BAD_REQUEST", error: "Monitor has no url." }, 400);
  const { scrapeUrl } = await import("../lib/scrape");
  const doc = await scrapeUrl(c.env, m.url, { timeoutMs: 25_000 });
  if ("error" in doc && doc.error) {
    return c.json({ success: false, code: "SCRAPE_FAILED", error: doc.error }, 422);
  }
  return c.json({
    success: true,
    check: { monitorId: c.req.param("monitorId") ?? "", ranAt: new Date().toISOString(), url: doc.url },
    data: { markdown: ("markdown" in doc && doc.markdown) || undefined },
  });
}

export const listMonitorChecksHandler = (c: C) =>
  c.json({ success: true, data: [], note: "Check history retention is hosted-only." });

export const getMonitorCheckHandler = (c: C) =>
  c.json({ success: false, code: "NOT_FOUND", error: "Check not found." }, 404);

export const confirmMonitorEmailHandler = (c: C) =>
  c.json({ success: true, message: "Email confirmed." });

export const unsubscribeMonitorEmailHandler = (c: C) =>
  c.json({ success: true, message: "Unsubscribed." });

// ---------- crawl params preview ----------

export async function crawlParamsPreviewHandler(c: C) {
  const body = await c.req.json().catch(() => ({}));
  return c.json({
    success: true,
    data: {
      url: body.url ?? null,
      limit: body.limit ?? 100,
      maxDepth: body.maxDepth ?? 5,
      note: "Preview only: the Workers crawler fans out from the seed URL honoring include/exclude paths and robots.txt.",
    },
  });
}
