import type { Env } from "../env";
import { cfg } from "../env";
import { newId } from "./utils";

export type JobKind =
  | "crawl"
  | "batch"
  | "extract"
  | "map"
  | "deep_research"
  | "llmstxt";
export type JobStatus =
  | "queued"
  | "active"
  | "completed"
  | "failed"
  | "cancelled";

export interface JobRow {
  id: string;
  kind: JobKind;
  team_id: string;
  status: JobStatus;
  request_json: string;
  result_json: string | null;
  error: string | null;
  total: number;
  completed: number;
  credits_cost: number;
  webhook_url: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
}

export interface QueueMessage {
  jobId: string;
  kind: JobKind;
  teamId: string;
  keyId?: string | null;
  /** For fan-out: one message per page/batch item. */
  url?: string;
  urls?: string[];
  depth?: number;
  attempt?: number;
}

export async function createJob(
  env: Env,
  kind: JobKind,
  teamId: string,
  request: unknown,
  total: number,
  ttlDays = 1,
): Promise<string> {
  const id = newId();
  const expires = new Date(Date.now() + ttlDays * 86_400_000).toISOString();
  const req = request as { webhook?: { url?: string } };
  await env.DB.prepare(
    `INSERT INTO jobs (id, kind, team_id, status, request_json, total, webhook_url, expires_at)
     VALUES (?1, ?2, ?3, 'queued', ?4, ?5, ?6, ?7)`,
  )
    .bind(
      id,
      kind,
      teamId,
      JSON.stringify(request ?? {}),
      total,
      req?.webhook?.url ?? null,
      expires,
    )
    .run();
  return id;
}

export async function getJob(
  env: Env,
  jobId: string,
): Promise<JobRow | null> {
  return env.DB.prepare("SELECT * FROM jobs WHERE id = ?1")
    .bind(jobId)
    .first<JobRow>();
}

export async function getJobForTeam(
  env: Env,
  jobId: string,
  teamId: string,
): Promise<JobRow | null> {
  return env.DB.prepare("SELECT * FROM jobs WHERE id = ?1 AND team_id = ?2")
    .bind(jobId, teamId)
    .first<JobRow>();
}

export async function setJobStatus(
  env: Env,
  jobId: string,
  status: JobStatus,
  patch?: { error?: string; result?: unknown; completed?: number; credits?: number },
): Promise<void> {
  await env.DB.prepare(
    `UPDATE jobs SET status = ?1, error = COALESCE(?2, error),
     result_json = COALESCE(?3, result_json),
     completed = COALESCE(?4, completed),
     credits_cost = credits_cost + COALESCE(?5, 0),
     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ?6`,
  )
    .bind(
      status,
      patch?.error ?? null,
      patch?.result !== undefined ? JSON.stringify(patch.result) : null,
      patch?.completed ?? null,
      patch?.credits ?? 0,
      jobId,
    )
    .run();
}

export async function appendJobPages(
  env: Env,
  jobId: string,
  pages: Array<{ url: string; data?: unknown; error?: string; depth?: number }>,
): Promise<void> {
  if (pages.length === 0) return;
  const stmts = pages.map(p =>
    env.DB.prepare(
      `INSERT INTO job_pages (job_id, url, status, data_json, error, depth)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT (job_id, url) DO UPDATE SET
         status = excluded.status, data_json = excluded.data_json,
         error = excluded.error, depth = excluded.depth`,
    ).bind(
      jobId,
      p.url,
      p.error ? "failed" : "done",
      p.data !== undefined ? JSON.stringify(p.data) : null,
      p.error ?? null,
      p.depth ?? 0,
    ),
  );
  // D1 batch limit is generous; chunk to be safe.
  for (let i = 0; i < stmts.length; i += 50) {
    await env.DB.batch(stmts.slice(i, i + 50));
  }
}

export async function getJobPages(
  env: Env,
  jobId: string,
  limit = 1000,
): Promise<Array<{ url: string; status: string; data_json: string | null; error: string | null }>> {
  const res = await env.DB.prepare(
    "SELECT url, status, data_json AS data_json, error FROM job_pages WHERE job_id = ?1 LIMIT ?2",
  )
    .bind(jobId, Math.min(limit, 5000))
    .all<{ url: string; status: string; data_json: string | null; error: string | null }>();
  return res.results ?? [];
}

export async function fireWebhook(
  ctx: { waitUntil: (p: Promise<unknown>) => void },
  url: string | undefined | null,
  payload: unknown,
): Promise<void> {
  if (!url) return;
  ctx.waitUntil(
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => undefined),
  );
}

export const maxPages = (env: Env) => cfg(env).maxCrawlPages;
