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
  keyMonthlyLimit = 0,
  keyId?: string | null,
): Promise<{ ok: boolean; used: number; limit: number }> {
  const { monthlyCreditLimit: globalLimit } = cfg(env);
  if (keyMonthlyLimit > 0 && keyId) {
    const used = await monthlyUsage(env, teamId, keyId);
    if (used >= keyMonthlyLimit) return { ok: false, used, limit: keyMonthlyLimit };
    if (!(globalLimit > 0)) return { ok: true, used, limit: keyMonthlyLimit };
  }
  if (globalLimit > 0) {
    const used = await monthlyUsage(env, teamId);
    if (used >= globalLimit) return { ok: false, used, limit: globalLimit };
    return { ok: true, used, limit: globalLimit };
  }
  return { ok: true, used: 0, limit: 0 };
}

export async function monthlyUsage(
  env: Env,
  teamId: string,
  keyId?: string | null,
): Promise<number> {
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const iso = monthStart.toISOString();
  const row = keyId
    ? await env.DB.prepare(
        "SELECT COALESCE(SUM(credits),0) AS used FROM usage_log WHERE key_id = ?1 AND created_at >= ?2",
      )
        .bind(keyId, iso)
        .first<{ used: number }>()
    : await env.DB.prepare(
        "SELECT COALESCE(SUM(credits),0) AS used FROM usage_log WHERE team_id = ?1 AND created_at >= ?2",
      )
        .bind(teamId, iso)
        .first<{ used: number }>();
  return row?.used ?? 0;
}

export async function spendCredits(
  env: Env,
  teamId: string,
  endpoint: string,
  credits: number,
  keyId?: string | null,
): Promise<void> {
  if (credits <= 0) return;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO usage_log (team_id, endpoint, credits, key_id) VALUES (?1, ?2, ?3, ?4)",
    ).bind(teamId, endpoint, credits, keyId ?? null),
    env.DB.prepare(
      "UPDATE teams SET credits_used = credits_used + ?1 WHERE id = ?2",
    ).bind(credits, teamId),
  ]);
}
