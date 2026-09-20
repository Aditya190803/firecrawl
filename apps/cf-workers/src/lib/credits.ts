import { cfg, type Env } from "../env";

export const CREDIT_COSTS = {
  scrape: 1,
  search: 1,
  map: 1,
  crawlPage: 1,
  extract: 5,
  agent: 5,
  llmstxt: 1,
  deepResearch: 10,
} as const;

/** Credit ledger on D1. MONTHLY_CREDIT_LIMIT=0 (default) = unlimited. */
export async function checkCredits(
  env: Env,
  teamId: string,
): Promise<{ ok: boolean; used: number; limit: number }> {
  const { monthlyCreditLimit: limit } = cfg(env);
  if (!limit || limit <= 0) return { ok: true, used: 0, limit: 0 };
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const row = await env.DB.prepare(
    "SELECT COALESCE(SUM(credits),0) AS used FROM usage_log WHERE team_id = ?1 AND created_at >= ?2",
  )
    .bind(teamId, monthStart.toISOString())
    .first<{ used: number }>();
  const used = row?.used ?? 0;
  return { ok: used < limit, used, limit };
}

export async function spendCredits(
  env: Env,
  teamId: string,
  endpoint: string,
  credits: number,
): Promise<void> {
  if (credits <= 0) return;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO usage_log (team_id, endpoint, credits) VALUES (?1, ?2, ?3)",
    ).bind(teamId, endpoint, credits),
    env.DB.prepare(
      "UPDATE teams SET credits_used = credits_used + ?1 WHERE id = ?2",
    ).bind(credits, teamId),
  ]);
}
