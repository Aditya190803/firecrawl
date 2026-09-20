import { cfg, type Env } from "../env";
import {
  agentRequestSchema,
  batchScrapeRequestSchema,
  crawlRequestSchema,
  deepResearchRequestSchema,
  extractRequestSchema,
  llmsTxtRequestSchema,
  monitorRequestSchema,
  parseZodError,
} from "../schemas";
import { getAuth } from "../lib/auth";
import { checkCredits, spendCredits } from "../lib/credits";
import {
  createJob,
  fireWebhook,
  getJob,
  getJobForTeam,
  getJobPages,
  setJobStatus,
  type JobRow,
  type QueueMessage,
} from "../lib/jobs";
import { robotsAllowed } from "../lib/robots";
import { newId, safeJsonParse } from "../lib/utils";

type C = any;

// ---------- crawl ----------

export async function crawlStartHandler(c: C) {
  const auth = getAuth(c);
  const parsed = crawlRequestSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json(parseZodError(parsed.error), 400);
  const body = parsed.data;
  const credits = await checkCredits(c.env, auth.teamId);
  if (!credits.ok) {
    return c.json(
      { success: false, code: "INSUFFICIENT_CREDITS", error: "Monthly credit limit reached." },
      402,
    );
  }
  const idemKey = c.req.header("x-idempotency-key");
  if (idemKey) {
    const prior = await (c.env as any).DB.prepare(
      "SELECT response_json FROM idempotency_keys WHERE team_id = ?1 AND key = ?2",
    )
      .bind(auth.teamId, idemKey)
      .first();
    if (prior) return c.json(safeJsonParse(prior.response_json, {}));
  }

  const jobId = await createJob(c.env, "crawl", auth.teamId, body, body.limit);
  await (c.env as any).DB.prepare(
    "INSERT INTO job_pages (job_id, url, status, depth) VALUES (?1, ?2, 'queued', 0) ON CONFLICT (job_id, url) DO NOTHING",
  )
    .bind(jobId, body.url)
    .run();
  await (c.env as any).WORK_QUEUE.send({
    jobId,
    kind: "crawl",
    teamId: auth.teamId,
    url: body.url,
    depth: 0,
  } satisfies QueueMessage);

  const response = { success: true as const, id: jobId, url: `/v2/crawl/${jobId}` };
  if (idemKey) {
    await (c.env as any).DB.prepare(
      "INSERT INTO idempotency_keys (team_id, key, response_json) VALUES (?1, ?2, ?3) ON CONFLICT (team_id, key) DO NOTHING",
    )
      .bind(auth.teamId, idemKey, JSON.stringify(response))
      .run();
  }
  return c.json(response);
}

export async function batchStartHandler(c: C) {
  const auth = getAuth(c);
  const parsed = batchScrapeRequestSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json(parseZodError(parsed.error), 400);
  const body = parsed.data;
  const credits = await checkCredits(c.env, auth.teamId);
  if (!credits.ok) {
    return c.json(
      { success: false, code: "INSUFFICIENT_CREDITS", error: "Monthly credit limit reached." },
      402,
    );
  }
  const jobId = await createJob(c.env, "batch", auth.teamId, body, body.urls.length);
  const stmts = body.urls.map(u =>
    (c.env as any).DB.prepare(
      "INSERT INTO job_pages (job_id, url, status) VALUES (?1, ?2, 'queued') ON CONFLICT (job_id, url) DO NOTHING",
    ).bind(jobId, u),
  );
  for (let i = 0; i < stmts.length; i += 50) await (c.env as any).DB.batch(stmts.slice(i, i + 50));
  await (c.env as any).WORK_QUEUE.send({
    jobId,
    kind: "batch",
    teamId: auth.teamId,
    urls: body.urls,
  } satisfies QueueMessage);
  return c.json({ success: true as const, id: jobId, url: `/v2/batch/scrape/${jobId}` });
}

const jobShape = (job: JobRow, pages: Array<{ url: string; status: string; data_json: string | null; error: string | null }>) => {
  const done = pages.filter(p => p.status !== "queued");
  const data = done
    .filter(p => p.status === "done" && p.data_json)
    .map(p => safeJsonParse(p.data_json, null))
    .filter(Boolean);
  return {
    success: true as const,
    status: job.status,
    total: job.total,
    completed: job.completed,
    creditsUsed: job.credits_cost,
    data,
    errors:
      job.kind === "crawl" || job.kind === "batch"
        ? pages.filter(p => p.status === "failed").map(p => ({ url: p.url, error: p.error }))
        : undefined,
  };
};

export async function jobStatusHandler(c: C, kind: "crawl" | "batch") {
  const auth = getAuth(c);
  const job = await getJobForTeam(c.env, c.req.param("jobId") ?? "", auth.teamId);
  if (!job) return c.json({ success: false, code: "NOT_FOUND", error: "Job not found." }, 404);
  const pages = await getJobPages(c.env, job.id);
  return c.json(jobShape(job, pages));
}

export async function jobCancelHandler(c: C) {
  const auth = getAuth(c);
  const job = await getJobForTeam(c.env, c.req.param("jobId") ?? "", auth.teamId);
  if (!job) return c.json({ success: false, code: "NOT_FOUND", error: "Job not found." }, 404);
  if (job.status === "completed" || job.status === "failed") {
    return c.json({ success: true, status: job.status });
  }
  await setJobStatus(c.env, job.id, "cancelled");
  return c.json({ success: true, status: "cancelled" });
}

export async function jobErrorsHandler(c: C) {
  const auth = getAuth(c);
  const job = await getJobForTeam(c.env, c.req.param("jobId") ?? "", auth.teamId);
  if (!job) return c.json({ success: false, code: "NOT_FOUND", error: "Job not found." }, 404);
  const pages = await getJobPages(c.env, job.id);
  return c.json({
    success: true,
    errors: pages.filter(p => p.status === "failed").map(p => ({ url: p.url, error: p.error })),
  });
}

export async function ongoingJobsHandler(c: C) {
  const auth = getAuth(c);
  const res = await (c.env as any).DB.prepare(
    "SELECT id, kind, status, total, completed, created_at FROM jobs WHERE team_id = ?1 AND status IN ('queued','active') ORDER BY created_at DESC LIMIT 100",
  )
    .bind(auth.teamId)
    .all();
  return c.json({ success: true, crawls: res.results });
}

// ---------- queue consumer (crawl fan-out + batch) ----------

export async function consumeJob(
  env: Env,
  msg: QueueMessage,
  workerCtx: { waitUntil: (p: Promise<unknown>) => void },
): Promise<void> {
  const { scrapeUrl } = await import("../lib/scrape");
  const { htmlToMarkdown } = await import("../lib/scrape");
  void htmlToMarkdown;
  const job = await getJob(env, msg.jobId);
  if (!job || job.status === "cancelled" || job.status === "completed") return;
  if (job.status === "queued") await setJobStatus(env, job.id, "active");

  const req = safeJsonParse<Record<string, unknown>>(job.request_json, {});
  const webhookUrl =
    (req.webhook as { url?: string } | undefined)?.url ?? job.webhook_url;

  if (msg.kind === "batch" && msg.urls) {
    for (const url of msg.urls.slice(0, 50)) {
      const existing = await env.DB.prepare(
        "SELECT status FROM job_pages WHERE job_id = ?1 AND url = ?2",
      )
        .bind(job.id, url)
        .first();
      if (existing && existing.status !== "queued") continue;
      const doc = await scrapeUrl(env, url, { timeoutMs: 30_000 });
      if (doc.error) {
        await env.DB.prepare(
          "UPDATE job_pages SET status='failed', error=?3 WHERE job_id=?1 AND url=?2",
        )
          .bind(job.id, url, doc.error)
          .run();
      } else {
        await env.DB.prepare(
          "UPDATE job_pages SET status='done', data_json=?3 WHERE job_id=?1 AND url=?2",
        )
          .bind(job.id, url, JSON.stringify({ url: doc.url, markdown: doc.markdown, title: doc.title }))
          .run();
        await spendCredits(env, job.team_id, "scrape", 1);
      }
      await env.DB.prepare("UPDATE jobs SET completed = completed + 1 WHERE id = ?1")
        .bind(job.id)
        .run();
    }
    await finishIfDone(env, workerCtx, job.id, webhookUrl);
    return;
  }

  if (msg.kind === "crawl" && msg.url) {
    const limit = Math.min(
      (req.limit as number | undefined) ?? cfg(env).maxCrawlPages,
      cfg(env).maxCrawlPages,
    );
    const current = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM job_pages WHERE job_id = ?1 AND status != 'queued'",
    )
      .bind(job.id)
      .first();
    if (((current as any)?.n ?? 0) >= limit) {
      await finishIfDone(env, workerCtx, job.id, webhookUrl, true);
      return;
    }
    const allowed = await robotsAllowed(
      env,
      msg.url,
      (req.ignoreRobotsTxt as boolean | undefined) ?? false,
    );
    const doc = allowed
      ? await scrapeUrl(env, msg.url, { timeoutMs: 25_000 })
      : { url: msg.url, statusCode: 403 as number, error: "Blocked by robots.txt" };
    const depth = msg.depth ?? 0;
    const maxDepth = Math.min(
      (req.maxDepth as number | undefined) ?? cfg(env).maxCrawlDepth,
      cfg(env).maxCrawlDepth,
    );
    if (doc && !(doc as { error?: string }).error) {
      const d = doc as { url: string; markdown?: string; title?: string; links?: string[] };
      await env.DB.prepare(
        "UPDATE job_pages SET status='done', data_json=?3, depth=?4 WHERE job_id=?1 AND url=?2",
      )
        .bind(
          job.id,
          msg.url,
          JSON.stringify({ url: d.url, markdown: d.markdown, title: d.title }),
          depth,
        )
        .run();
      await spendCredits(env, job.team_id, "scrape", 1);
      // Fan out child links (bounded).
      if (depth < maxDepth) {
        const allowExternal = (req.allowExternalLinks as boolean | undefined) ?? false;
        const children = (d.links ?? [])
          .filter(l => allowExternal || sameHost(l, msg.url!))
          .slice(0, 20);
        const fresh: string[] = [];
        for (const child of children) {
          const ins = await env.DB.prepare(
            "INSERT INTO job_pages (job_id, url, status, depth) VALUES (?1, ?2, 'queued', ?3) ON CONFLICT (job_id, url) DO NOTHING",
          )
            .bind(job.id, child, depth + 1)
            .run();
          if ((ins.meta as { changes?: number })?.changes) fresh.push(child);
        }
        if (fresh.length > 0) {
          await env.WORK_QUEUE.send({
            jobId: job.id,
            kind: "crawl",
            teamId: job.team_id,
            url: fresh[0],
            depth: depth + 1,
          } satisfies QueueMessage);
          // Remaining children stay queued in D1; a follow-up sweep picks them up.
        }
      }
    } else {
      await env.DB.prepare(
        "UPDATE job_pages SET status='failed', error=?3 WHERE job_id=?1 AND url=?2",
      )
        .bind(job.id, msg.url, (doc as { error?: string }).error ?? "fetch failed")
        .run();
    }
    await env.DB.prepare(
      "UPDATE jobs SET completed = completed + 1 WHERE id = ?1",
    )
      .bind(job.id)
      .run();

    // Sweep: if queued pages remain and we're under the limit, keep going.
    const next = await env.DB.prepare(
      "SELECT url, depth FROM job_pages WHERE job_id = ?1 AND status = 'queued' LIMIT 1",
    )
      .bind(job.id)
      .first();
    const doneCount = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM job_pages WHERE job_id = ?1 AND status != 'queued'",
    )
      .bind(job.id)
      .first();
    if (next && (((doneCount as any)?.n ?? 0) < limit)) {
      await env.WORK_QUEUE.send({
        jobId: job.id,
        kind: "crawl",
        teamId: job.team_id,
        url: next.url,
        depth: next.depth,
      });
    } else {
      await finishIfDone(env, workerCtx, job.id, webhookUrl, true);
    }
  }
}

function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).hostname === new URL(b).hostname;
  } catch {
    return false;
  }
}

async function finishIfDone(
  env: Env,
  workerCtx: { waitUntil: (p: Promise<unknown>) => void },
  jobId: string,
  webhookUrl: string | null,
  force = false,
): Promise<void> {
  const job = await getJob(env, jobId);
  if (!job) return;
  const pages = await getJobPages(env, jobId, 5000);
  const pending = pages.filter(p => p.status === "queued").length;
  if (pending > 0 && !force) return;
  await setJobStatus(env, jobId, "completed", { completed: pages.length });
  await fireWebhook(workerCtx, webhookUrl, {
    success: true,
    id: jobId,
    status: "completed",
  });
}

// ---------- extract / agent (Workers AI, optional) ----------

export async function extractStartHandler(c: C) {
  const auth = getAuth(c);
  const parsed = extractRequestSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json(parseZodError(parsed.error), 400);
  if (!c.env.AI) {
    return c.json(
      {
        success: false,
        code: "NOT_CONFIGURED",
        error:
          "Workers AI is not bound. Add the [ai] binding in wrangler.toml (free: 10k neurons/day) or use /v2/scrape with formats ['json'] instead.",
      },
      501,
    );
  }
  const body = parsed.data;
  const jobId = await createJob(c.env, "extract", auth.teamId, body, 1);
  const urls = body.urls ?? (body.url ? [body.url] : []);
  // Scrape first, then LLM-extract over the markdown.
  const { scrapeUrl } = await import("../lib/scrape");
  const docs = await Promise.all(
    urls.slice(0, 5).map(u => scrapeUrl(c.env, u, { timeoutMs: 25_000 })),
  );
  const combined = docs
    .map(d => ("markdown" in d && d.markdown ? d.markdown.slice(0, 8000) : ""))
    .filter(Boolean)
    .join("\n\n---\n\n")
    .slice(0, 24_000);
  const prompt = `Extract structured data from the page content below. Prompt: ${body.prompt ?? "Extract key facts"}. Schema: ${JSON.stringify(body.schema ?? {})}. Return ONLY valid JSON.\n\nCONTENT:\n${combined}`;
  const ai = await (c.env as any).AI.run("@cf/meta/llama-3.2-1b-instruct", {
    messages: [{ role: "user", content: prompt }],
  });
  const text =
    (ai as { response?: string }).response ?? JSON.stringify(ai).slice(0, 8000);
  let data: unknown = text;
  try {
    data = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? text);
  } catch {
    /* keep raw text */
  }
  await setJobStatus(c.env, jobId, "completed", {
    result: { data, urls },
    completed: 1,
    credits: 5,
  });
  await spendCredits(c.env, auth.teamId, "extract", 5);
  return c.json({ success: true, id: jobId, data });
}

export async function extractStatusHandler(c: C) {
  const auth = getAuth(c);
  const job = await getJobForTeam(c.env, c.req.param("jobId") ?? "", auth.teamId);
  if (!job) return c.json({ success: false, code: "NOT_FOUND", error: "Job not found." }, 404);
  const result = job.result_json ? JSON.parse(job.result_json) : null;
  return c.json({ success: true, status: job.status, ...result });
}

export async function agentStartHandler(c: C) {
  const auth = getAuth(c);
  const parsed = agentRequestSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json(parseZodError(parsed.error), 400);
  if (!c.env.AI) {
    return c.json(
      {
        success: false,
        code: "NOT_CONFIGURED",
        error:
          "Workers AI is not bound. Add the [ai] binding in wrangler.toml, or use /v2/scrape + /v2/search directly.",
      },
      501,
    );
  }
  const body = parsed.data;
  const jobId = await createJob(c.env, "extract", auth.teamId, body, 1);
  const { scrapeUrl } = await import("../lib/scrape");
  const docs = await Promise.all(
    (body.urls ?? []).slice(0, 5).map(u => scrapeUrl(c.env, u, { timeoutMs: 25_000 })),
  );
  const combined = docs
    .map(d => ("markdown" in d && d.markdown ? d.markdown.slice(0, 8000) : ""))
    .filter(Boolean)
    .join("\n\n---\n\n")
    .slice(0, 24_000);
  const ai = await (c.env as any).AI.run("@cf/meta/llama-3.2-1b-instruct", {
    messages: [{ role: "user", content: `${body.prompt}\n\nCONTENT:\n${combined}` }],
  });
  const answer = (ai as { response?: string }).response ?? JSON.stringify(ai);
  await setJobStatus(c.env, jobId, "completed", {
    result: { data: { answer } },
    completed: 1,
    credits: 5,
  });
  await spendCredits(c.env, auth.teamId, "agent", 5);
  return c.json({ success: true, id: jobId, data: { answer } });
}

// ---------- llmstxt / deep-research / monitor (lightweight) ----------

export async function llmsTxtHandler(c: C) {
  const auth = getAuth(c);
  const parsed = llmsTxtRequestSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json(parseZodError(parsed.error), 400);
  const body = parsed.data;
  const { scrapeUrl } = await import("../lib/scrape");
  const doc = await scrapeUrl(c.env, body.url, { timeoutMs: 25_000 });
  const jobId = newId();
  if (("error" in doc && doc.error) || !("markdown" in doc)) {
    return c.json({ success: false, code: "SCRAPE_FAILED", error: "Could not fetch page." }, 422);
  }
  await spendCredits(c.env, auth.teamId, "llmstxt", 1);
  return c.json({
    success: true,
    id: jobId,
    llmstxt: `# ${("title" in doc && doc.title) || body.url}\n\n${("markdown" in doc && doc.markdown) || ""}`.slice(0, 100_000),
  });
}

export async function deepResearchStartHandler(c: C) {
  const auth = getAuth(c);
  const parsed = deepResearchRequestSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json(parseZodError(parsed.error), 400);
  if (!c.env.AI) {
    return c.json(
      { success: false, code: "NOT_CONFIGURED", error: "Workers AI [ai] binding is required for deep research." },
      501,
    );
  }
  const body = parsed.data;
  const { runSearch } = await import("../lib/search");
  const { scrapeUrl } = await import("../lib/scrape");
  const hits = await runSearch(c.env, body.query, body.limit);
  const docs = await Promise.all(
    hits.slice(0, 5).map(h => scrapeUrl(c.env, h.url, { timeoutMs: 20_000 })),
  );
  const combined = docs
    .map(d => ("markdown" in d && d.markdown ? d.markdown.slice(0, 6000) : ""))
    .filter(Boolean)
    .join("\n\n---\n\n")
    .slice(0, 20_000);
  const ai = await (c.env as any).AI.run("@cf/meta/llama-3.2-1b-instruct", {
    messages: [{ role: "user", content: `Research query: ${body.query}\n\nSOURCES:\n${combined}\n\nWrite a concise research summary with key findings.` }],
  });
  const jobId = newId();
  await spendCredits(c.env, auth.teamId, "deep_research", 10);
  return c.json({
    success: true,
    id: jobId,
    status: "completed",
    data: {
      summary: (ai as { response?: string }).response ?? "",
      sources: hits.map(h => ({ url: h.url, title: h.title })),
    },
  });
}

export async function monitorCreateHandler(c: C) {
  const auth = getAuth(c);
  const parsed = monitorRequestSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json(parseZodError(parsed.error), 400);
  // Monitors = stored crawl requests re-run on a schedule. Full cron needs a
  // Workers Cron Trigger; here we persist the definition so a cron can pick it up.
  const id = newId();
  await (c.env as any).DB.prepare(
    "INSERT INTO jobs (id, kind, team_id, status, request_json, total) VALUES (?1, 'crawl', ?2, 'queued', ?3, 1)",
  )
    .bind(id, auth.teamId, JSON.stringify({ ...parsed.data, monitor: true }))
    .run();
  return c.json({ success: true, id });
}
