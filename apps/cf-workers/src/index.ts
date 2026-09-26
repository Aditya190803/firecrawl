import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./env";
import { authMiddleware } from "./lib/auth";
import { playground } from "./routes/playground";
import { scrapeHandler } from "./routes/scrape";
import { mapHandler } from "./routes/map";
import { searchHandler } from "./routes/search";
import { summarizeHandler } from "./routes/summarize";
import {
  acceptInviteHandler,
  createKeyHandler,
  inviteUserHandler,
  listKeysHandler,
  listUsersHandler,
  loginHandler,
  logoutHandler,
  meHandler,
  recentJobsHandler,
  requireSession,
  resetPasswordHandler,
  revokeKeyHandler,
  signupHandler,
  updateKeyHandler,
  usageHandler,
} from "./routes/dashboard";
import {
  agentStartHandler,
  batchStartHandler,
  crawlStartHandler,
  deepResearchStartHandler,
  extractStartHandler,
  extractStatusHandler,
  jobCancelHandler,
  jobErrorsHandler,
  jobStatusHandler,
  llmsTxtHandler,
  monitorCreateHandler,
  ongoingJobsHandler,
} from "./routes/async-jobs";
import {
  activityHandler,
  concurrencyCheckHandler,
  confirmMonitorEmailHandler,
  createMonitorHandler,
  creditUsageHandler,
  creditUsageHistoricalHandler,
  crawlParamsPreviewHandler,
  deleteMonitorHandler,
  feedbackHandler,
  getMonitorCheckHandler,
  getMonitorHandler,
  getSiemHandler,
  getThreatHandler,
  keylessEligibilityHandler,
  listMonitorChecksHandler,
  listMonitorsHandler,
  notSupported,
  patchMonitorHandler,
  putSiemHandler,
  putThreatHandler,
  queueStatusHandler,
  runMonitorHandler,
  testSiemHandler,
  tokenUsageHandler,
  tokenUsageHistoricalHandler,
  unsubscribeMonitorEmailHandler,
} from "./routes/misc";
import type { QueueMessage } from "./lib/jobs";

const app = new Hono<{ Bindings: Env }>();

app.use("*", cors());
app.onError((e, c) => {
  console.error("unhandled", e);
  return c.json(
    { success: false, code: "INTERNAL_ERROR", error: e.message || "Internal error." },
    500,
  );
});

/** Dashboard HTML for GET / (same origin as the API). Falls back if ASSETS isn't bound (tests). */
const serveDashboard = async (c: { env: Env; req: { url: string; raw: Request }; html: (s: string) => Response }) => {
  if (c.env.ASSETS) {
    return c.env.ASSETS.fetch(new Request(new URL("/index.html", c.req.url)));
  }
  return c.html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"/><title>Firecrawl Console</title></head><body><p>Console assets are not bound.</p></body></html>`,
  );
};

// ---------- public ----------
app.get("/", c => serveDashboard(c as any));
app.get("/favicon.svg", async c => {
  if (c.env.ASSETS) {
    return c.env.ASSETS.fetch(new Request(new URL("/favicon.svg", c.req.url)));
  }
  return c.body(null, 404);
});
app.get("/docs", c =>
  c.json({
    message: "Free-tier Workers port of the Firecrawl API.",
    endpoints: [
      "POST /v2/scrape",
      "POST /v2/map",
      "POST /v2/search",
      "POST /v2/crawl  GET /v2/crawl/:jobId  DELETE /v2/crawl/:jobId  GET /v2/crawl/:jobId/errors  GET /v2/crawl/ongoing  POST /v2/crawl/params-preview",
      "POST /v2/batch/scrape  GET /v2/batch/scrape/:jobId  DELETE /v2/batch/scrape/:jobId  GET /v2/batch/scrape/:jobId/errors",
      "POST /v2/extract  GET /v2/extract/:jobId  (needs Workers AI [ai] binding)",
      "POST /v2/agent  GET /v2/agent/:jobId  DELETE /v2/agent/:jobId  (needs Workers AI)",
      "POST /v1/deep-research (Workers AI)  POST /v2/llmstxt (via /v1/llmstxt)",
      "GET /v2/team/credit-usage  GET /v2/team/credit-usage/historical  GET /v2/team/token-usage  GET /v2/team/token-usage/historical  GET /v2/team/queue-status  GET /v2/team/activity  GET /v2/concurrency-check",
      "GET|PUT /v2/team/threat-protection  GET|PUT /v2/team/siem  POST /v2/team/siem/test",
      "CRUD /v2/monitor  POST /v2/monitor/email/confirm  POST /v2/monitor/email/unsubscribe",
      "GET /v2/keyless/eligibility  POST /v2/feedback  POST /v2/search/:jobId/feedback",
      "v1 + v0 compatibility shims (same handlers, same auth)",
      "GET /health  GET /admin/status",
    ],
    unsupported: [
      "/v2/browser*, /v2/interact*, /v2/scrape/:jobId/interact (paid Browser Rendering)",
      "WS /v2/crawl/:jobId (poll GET instead)",
      "/v2/slack*, /v2/support/*, /exchange/*, /labs/*, /v2/parse*",
    ],
  }),
);
app.get("/health", c => c.json({ status: "ok" }));
app.route("/playground", playground);
app.get("/v0/health/liveness", c => c.text("OK"));
app.get("/v0/health/readiness", c => c.text("OK"));

// ---------- v2 ----------
const v2 = new Hono<{ Bindings: Env }>();
v2.use("*", authMiddleware);

v2.get("/keyless/eligibility", keylessEligibilityHandler);
v2.post("/search", searchHandler);
v2.post("/search/:jobId/feedback", feedbackHandler);
v2.post("/feedback", feedbackHandler);
v2.post("/parse/upload-url", notSupported.parse);
v2.put("/parse/upload/:uploadId", notSupported.parse);
v2.post("/parse", notSupported.parse);

v2.post("/scrape", scrapeHandler);
v2.get("/scrape/:jobId", c => jobStatusHandler(c, "batch"));
v2.post("/scrape/:jobId/interact", notSupported.interact);
v2.delete("/scrape/:jobId/interact", notSupported.interact);

v2.post("/batch/scrape", batchStartHandler);
v2.post("/map", mapHandler);
v2.post("/crawl", crawlStartHandler);
v2.post("/crawl/params-preview", crawlParamsPreviewHandler);
v2.get("/crawl/ongoing", ongoingJobsHandler);
v2.get("/crawl/active", ongoingJobsHandler);
v2.get("/crawl/:jobId", c => jobStatusHandler(c, "crawl"));
v2.delete("/crawl/:jobId", jobCancelHandler);
v2.get("/crawl/:jobId/errors", jobErrorsHandler);
v2.get("/batch/scrape/:jobId", c => jobStatusHandler(c, "batch"));
v2.delete("/batch/scrape/:jobId", jobCancelHandler);
v2.get("/batch/scrape/:jobId/errors", jobErrorsHandler);

v2.post("/extract", extractStartHandler);
v2.get("/extract/:jobId", extractStatusHandler);

v2.get("/agent", ongoingJobsHandler);
v2.get("/agent/threads/:threadId", c =>
  c.json({ success: false, code: "NOT_FOUND", error: "Thread not found." }, 404),
);
v2.post("/agent", agentStartHandler);
v2.get("/agent/:jobId", extractStatusHandler);
v2.get("/agent/:jobId/trace", extractStatusHandler);
v2.get("/agent/:jobId/skill", extractStatusHandler);
v2.get("/agent/:jobId/snapshots/:snapshotId", extractStatusHandler);
v2.delete("/agent/:jobId", jobCancelHandler);

v2.get("/team/credit-usage", creditUsageHandler);
v2.get("/team/credit-usage/historical", creditUsageHistoricalHandler);
v2.get("/team/token-usage", tokenUsageHandler);
v2.get("/team/token-usage/historical", tokenUsageHistoricalHandler);
v2.get("/concurrency-check", concurrencyCheckHandler);
v2.get("/team/queue-status", queueStatusHandler);
v2.get("/team/activity", activityHandler);
v2.get("/team/threat-protection", getThreatHandler);
v2.put("/team/threat-protection", putThreatHandler);
v2.post("/team/threat-protection/zscaler/test-connection", c =>
  c.json({ success: true, connected: false, note: "Hosted-only." }),
);
v2.get("/team/threat-protection/zscaler/categories", c => c.json({ success: true, data: [] }));
v2.post("/team/threat-protection/zscaler/sync", c => c.json({ success: true }));
v2.get("/team/siem", getSiemHandler);
v2.put("/team/siem", putSiemHandler);
v2.post("/team/siem/test", testSiemHandler);

v2.post("/monitor", createMonitorHandler);
v2.get("/monitor", listMonitorsHandler);
v2.post("/monitor/email/confirm", confirmMonitorEmailHandler);
v2.post("/monitor/email/unsubscribe", unsubscribeMonitorEmailHandler);
v2.get("/monitor/:monitorId", getMonitorHandler);
v2.patch("/monitor/:monitorId", patchMonitorHandler);
v2.delete("/monitor/:monitorId", deleteMonitorHandler);
v2.post("/monitor/:monitorId/run", runMonitorHandler);
v2.get("/monitor/:monitorId/checks", listMonitorChecksHandler);
v2.get("/monitor/:monitorId/checks/:checkId", getMonitorCheckHandler);

v2.post("/slack/oauth/start", notSupported.slack);
v2.get("/slack/oauth/callback", notSupported.slack);
v2.get("/slack/status", notSupported.slack);
v2.get("/slack/channels", notSupported.slack);
v2.delete("/slack/installation", notSupported.slack);
v2.post("/slack/commands", notSupported.slack);
v2.post("/slack/events", notSupported.slack);

v2.post("/browser", notSupported.browser);
v2.get("/browser", notSupported.browser);
v2.post("/browser/:sessionId/execute", notSupported.browser);
v2.get("/browser/:sessionId/replay", notSupported.browser);
v2.get("/browser/:sessionId/replay/:pageId", notSupported.browser);
v2.delete("/browser/:sessionId", notSupported.browser);
v2.post("/interact", notSupported.browser);
v2.get("/interact", notSupported.browser);
v2.post("/interact/:sessionId/execute", notSupported.browser);
v2.get("/interact/:sessionId/replay", notSupported.browser);
v2.get("/interact/:sessionId/replay/:pageId", notSupported.browser);
v2.delete("/interact/:sessionId", notSupported.browser);
v2.post("/browser/webhook/destroyed", notSupported.browser);

v2.post("/support/ask", notSupported.support);
v2.post("/support/docs-search", notSupported.support);
v2.all("/search/research/*", notSupported.researchProxy);
v2.all("/research/*", notSupported.researchProxy);
v2.all("/search/developer/*", notSupported.researchProxy);
v2.all("/developer/*", notSupported.researchProxy);
v2.post("/llmstxt", llmsTxtHandler);
v2.post("/summarize", summarizeHandler);

app.route("/v2", v2);

// ---------- v1 (compat: same handlers) ----------
const v1 = new Hono<{ Bindings: Env }>();
v1.use("*", authMiddleware);
v1.post("/scrape", scrapeHandler);
v1.post("/crawl", crawlStartHandler);
v1.post("/batch/scrape", batchStartHandler);
v1.post("/search", searchHandler);
v1.post("/map", mapHandler);
v1.get("/crawl/ongoing", ongoingJobsHandler);
v1.get("/crawl/active", ongoingJobsHandler);
v1.get("/crawl/:jobId", c => jobStatusHandler(c, "crawl"));
v1.get("/batch/scrape/:jobId", c => jobStatusHandler(c, "batch"));
v1.get("/crawl/:jobId/errors", jobErrorsHandler);
v1.get("/batch/scrape/:jobId/errors", jobErrorsHandler);
v1.get("/scrape/:jobId", c => jobStatusHandler(c, "batch"));
v1.get("/concurrency-check", concurrencyCheckHandler);
v1.post("/extract", extractStartHandler);
v1.get("/extract/:jobId", extractStatusHandler);
v1.post("/llmstxt", llmsTxtHandler);
v1.get("/llmstxt/:jobId", c =>
  c.json({ success: false, code: "NOT_FOUND", error: "LLM-txt jobs are synchronous on Workers." }, 404),
);
v1.post("/deep-research", deepResearchStartHandler);
v1.get("/deep-research/:jobId", c =>
  c.json({ success: false, code: "NOT_FOUND", error: "Deep research is synchronous on Workers." }, 404),
);
v1.delete("/crawl/:jobId", jobCancelHandler);
v1.delete("/batch/scrape/:jobId", jobCancelHandler);
v1.post("/fireclaw", agentStartHandler);
v1.get("/team/credit-usage", creditUsageHandler);
v1.get("/team/credit-usage/historical", creditUsageHistoricalHandler);
v1.get("/team/token-usage", tokenUsageHandler);
v1.get("/team/token-usage/historical", tokenUsageHistoricalHandler);
v1.get("/team/queue-status", queueStatusHandler);
app.route("/v1", v1);

// ---------- v0 (deprecated shims) ----------
const deprecated = (c: { header: (k: string, v: string) => void }) =>
  c.header("X-Deprecated", "true");

app.post("/v0/scrape", authMiddleware, c => {
  deprecated(c);
  return scrapeHandler(c);
});
app.post("/v0/crawl", authMiddleware, c => {
  deprecated(c);
  return crawlStartHandler(c);
});
app.get("/v0/crawl/status/:jobId", authMiddleware, c => {
  deprecated(c);
  return jobStatusHandler(c, "crawl");
});
app.delete("/v0/crawl/cancel/:jobId", authMiddleware, c => {
  deprecated(c);
  return jobCancelHandler(c);
});
app.get("/v0/keyAuth", authMiddleware, c =>
  c.json({ success: true, message: "Key is valid." }),
);
app.post("/v0/search", authMiddleware, c => {
  deprecated(c);
  return searchHandler(c);
});

// ---------- dashboard (account: signup/login/keys/usage) ----------
const dash = new Hono<{ Bindings: Env }>();
dash.post("/auth/signup", signupHandler);
dash.post("/auth/login", loginHandler);
dash.post("/auth/logout", logoutHandler);
dash.post("/auth/accept-invite", acceptInviteHandler);
dash.use("*", requireSession as any);
dash.get("/auth/me", meHandler);
dash.get("/users", listUsersHandler);
dash.post("/users/invite", inviteUserHandler);
dash.post("/users/reset-password", resetPasswordHandler);
dash.get("/keys", listKeysHandler);
dash.post("/keys", createKeyHandler);
dash.patch("/keys/:id", updateKeyHandler);
dash.delete("/keys/:id", revokeKeyHandler);
dash.get("/usage", usageHandler);
dash.get("/jobs", recentJobsHandler);
app.route("/dashboard", dash);

// ---------- misc mounts ----------
app.all("/exchange/*", notSupported.exchange);
app.all("/labs/*", notSupported.labs);
app.get("/admin/status", authMiddleware, c =>
  c.json({
    success: true,
    runtime: "cloudflare-workers",
    bindings: {
      d1: !!c.env.DB,
      kv: !!c.env.CACHE,
      queue: !!c.env.WORK_QUEUE,
      r2: !!c.env.DOCS,
      ai: !!c.env.AI,
    },
  }),
);

app.notFound(c =>
  c.json({ success: false, code: "NOT_FOUND", error: `No route: ${c.req.path}` }, 404),
);

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<QueueMessage>, env: Env, ctx: ExecutionContext) {
    const { consumeJob } = await import("./routes/async-jobs");
    for (const msg of batch.messages) {
      try {
        await consumeJob(env, msg.body, ctx);
        msg.ack();
      } catch (e) {
        console.error("queue error", e);
        msg.retry();
      }
    }
  },
};
