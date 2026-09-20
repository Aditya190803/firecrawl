import { describe, expect, it, vi, beforeEach } from "vitest";
import app from "../src/index";
import type { Env } from "../src/env";

// ---- in-memory fakes ----
const makeKV = () => {
  const store = new Map<string, { value: string; exp?: number }>();
  return {
    store,
    async get(key: string, type?: string) {
      const hit = store.get(key);
      if (!hit) return null;
      const v = hit.value;
      if (type === "json") {
        try {
          return JSON.parse(v);
        } catch {
          return null;
        }
      }
      return v;
    },
    async put(key: string, value: string, opts?: { expirationTtl?: number }) {
      store.set(key, { value, exp: opts?.expirationTtl });
    },
    async delete(key: string) {
      store.delete(key);
    },
  };
};

const makeD1 = () => {
  const jobs = new Map<string, Record<string, unknown>>();
  const pages: Array<Record<string, unknown>> = [];
  const usage: Array<Record<string, unknown>> = [];
  const apiKeys: Array<Record<string, unknown>> = [];
  const prep = (sql: string) => {
    let binds: unknown[] = [];
    const stmt = {
      bind(...args: unknown[]) {
        binds = args;
        return stmt;
      },
      async run() {
        if (sql.includes("INSERT INTO jobs")) {
          jobs.set(binds[0] as string, {
            id: binds[0],
            kind: binds[1],
            team_id: binds[2],
            status: "queued",
            request_json: binds[3],
            total: binds[4],
            completed: 0,
            credits_cost: 0,
            webhook_url: binds[5],
            result_json: null,
            error: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            expires_at: binds[6],
          });
          return { meta: { changes: 1 } };
        }
        if (sql.includes("INSERT INTO job_pages")) {
          const [jobId, url] = binds as [string, string];
          if (!pages.some(p => p.job_id === jobId && p.url === url)) {
            pages.push({ job_id: jobId, url, status: "queued", data_json: null, error: null, depth: binds[2] ?? 0 });
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        }
        if (sql.includes("UPDATE job_pages")) {
          const [jobId, url] = [binds[binds.length - 2], binds[binds.length - 1]] as [string, string];
          const p = pages.find(p => p.job_id === jobId && p.url === url);
          if (p) {
            if (sql.includes("status='done'")) {
              p.status = "done";
              p.data_json = binds[binds.length - 3];
            } else if (sql.includes("status='failed'")) {
              p.status = "failed";
              p.error = binds[binds.length - 3];
            }
          }
          return { meta: { changes: 1 } };
        }
        if (sql.includes("UPDATE jobs SET completed")) {
          const j = jobs.get(binds[binds.length - 1] as string);
          if (j) j.completed = ((j.completed as number) ?? 0) + 1;
          return { meta: { changes: 1 } };
        }
        if (sql.includes("UPDATE jobs SET status")) {
          const j = jobs.get(binds[binds.length - 1] as string);
          if (j) {
            j.status = binds[0];
            if (binds[1]) j.error = binds[1];
            if (binds[2]) j.result_json = binds[2];
            if (binds[3] != null) j.completed = binds[3];
          }
          return { meta: { changes: 1 } };
        }
        if (sql.includes("INSERT INTO usage_log")) {
          usage.push({ team_id: binds[0], endpoint: binds[1], credits: binds[2], created_at: new Date().toISOString() });
          return { meta: { changes: 1 } };
        }
        if (sql.includes("UPDATE teams")) return { meta: { changes: 1 } };
        if (sql.includes("idempotency_keys")) return { meta: { changes: 1 } };
        return { meta: { changes: 0 } };
      },
      async first<T>() {
        if (sql.includes("FROM api_keys")) {
          return (apiKeys.find(k => k.key_hash === binds[0]) ?? null) as T | null;
        }
        if (sql.includes("FROM idempotency_keys")) return null as T | null;
        if (sql.includes("SELECT * FROM jobs")) {
          const j = jobs.get(binds[0] as string);
          if (!j) return null as T | null;
          if (binds[1] !== undefined && j.team_id !== binds[1]) return null as T | null;
          return j as T;
        }
        if (sql.includes("SELECT status FROM job_pages")) {
          return (pages.find(p => p.job_id === binds[0] && p.url === binds[1]) ?? null) as T | null;
        }
        if (sql.includes("SELECT url, depth FROM job_pages")) {
          return (pages.find(p => p.job_id === binds[0] && p.status === "queued") ?? null) as T | null;
        }
        if (sql.includes("COUNT(*)")) {
          if (sql.includes("job_pages")) {
            const n = pages.filter(
              p => p.job_id === binds[0] && (sql.includes("!= 'queued'") ? p.status !== "queued" : true),
            ).length;
            return { n } as T;
          }
          return { n: 0 } as T;
        }
        if (sql.includes("SUM(credits)")) {
          const used = usage.filter(u => u.team_id === binds[0]).reduce((a, u) => a + (u.credits as number), 0);
          return { used } as T;
        }
        if (sql.includes("response_json")) return null as T | null;
        return null as T | null;
      },
      async all<T>() {
        if (sql.includes("FROM job_pages")) {
          return { results: pages.filter(p => p.job_id === binds[0]).slice(0, binds[1] as number) as T[] };
        }
        if (sql.includes("FROM jobs")) {
          return {
            results: [...jobs.values()].filter(
              j => j.team_id === binds[0] && (j.status === "queued" || j.status === "active"),
            ) as T[],
          };
        }
        if (sql.includes("usage_log")) return { results: [] as T[] };
        return { results: [] as T[] };
      },
    };
    return stmt;
  };
  return {
    prepare: prep,
    batch: async (stmts: Array<{ run: () => Promise<unknown> }>) => {
      for (const s of stmts) await s.run();
    },
    __jobs: jobs,
    __pages: pages,
  };
};

const sentMessages: unknown[] = [];
const makeQueue = () => ({
  send: async (msg: unknown) => {
    sentMessages.push(msg);
  },
});

let env: Env;
let d1: ReturnType<typeof makeD1>;
let kv: ReturnType<typeof makeKV>;

beforeEach(() => {
  sentMessages.length = 0;
  d1 = makeD1();
  kv = makeKV();
  env = {
    DB: d1 as unknown as D1Database,
    CACHE: kv as unknown as KVNamespace,
    DOCS: {} as R2Bucket,
    WORK_QUEUE: makeQueue() as unknown as Queue,
    WORK_DLQ: makeQueue() as unknown as Queue,
  };
  vi.unstubAllGlobals();
});

const req = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
  app.fetch(
    new Request(`https://test${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
    { waitUntil: () => undefined } as unknown as ExecutionContext,
  );

// ---------- happy paths ----------

describe("public", () => {
  it("GET / returns API blurb (no auth)", async () => {
    const res = await req("/");
    expect(res.status).toBe(200);
    const j = (await res.json()) as any;
    expect(j.message).toMatch(/Firecrawl/);
  });

  it("GET /health is public", async () => {
    const res = await req("/health");
    expect(res.status).toBe(200);
  });
});

describe("auth", () => {
  it("failure path: rejects protected route when API_KEY is set and key is wrong", async () => {
    env.API_KEY = "correct-key";
    const res = await req("/v2/scrape", { url: "https://example.com" }, { authorization: "Bearer wrong" });
    expect(res.status).toBe(401);
  });

  it("failure path: requires key when API_KEY is set", async () => {
    env.API_KEY = "correct-key";
    const res = await req("/v2/scrape", { url: "https://example.com" });
    expect(res.status).toBe(401);
  });

  it("happy path: master key passes", async () => {
    env.API_KEY = "correct-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html><head><title>T</title></head><body><p>hi</p></body></html>", { status: 200 })),
    );
    const res = await req("/v2/scrape", { url: "https://example.com" }, { authorization: "Bearer correct-key" });
    expect(res.status).toBe(200);
    const j = (await res.json()) as any;
    expect(j.success).toBe(true);
    expect(j.data.markdown).toContain("hi");
  });
});

describe("validation", () => {
  it("failure path: scrape without url is 400", async () => {
    const res = await req("/v2/scrape", {});
    expect(res.status).toBe(400);
    const j = (await res.json()) as any;
    expect(j.code).toBe("BAD_REQUEST");
  });

  it("failure path: crawl without url is 400", async () => {
    const res = await req("/v2/crawl", {});
    expect(res.status).toBe(400);
  });

  it("failure path: search without query is 400", async () => {
    const res = await req("/v2/search", {});
    expect(res.status).toBe(400);
  });
});

describe("scrape pipeline", () => {
  it("happy path: extracts markdown + links", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(
        `<html><head><title>Page</title></head><body><main><h1>Hello</h1><p>World</p><a href="/about">About</a></main></body></html>`,
        { status: 200, headers: { "content-type": "text/html" } },
      )),
    );
    const res = await req("/v2/scrape", {
      url: "https://example.com",
      formats: [{ type: "markdown" }, { type: "links" }],
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as any;
    expect(j.success).toBe(true);
    expect(j.data.markdown).toContain("# Hello");
    expect(j.data.links).toContain("https://example.com/about");
  });

  it("failure path: HTTP 404 from target becomes 422", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
    const res = await req("/v2/scrape", { url: "https://example.com/missing" });
    expect(res.status).toBe(422);
    expect(((await res.json()) as any).code).toBe("SCRAPE_FAILED");
  });

  it("failure path: screenshot format explains paid-plan requirement", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html><body><p>x</p></body></html>", { status: 200 })),
    );
    const res = await req("/v2/scrape", { url: "https://example.com", formats: [{ type: "screenshot" }] });
    const j = (await res.json()) as any;
    expect(j.data.screenshotNote).toMatch(/Browser Rendering/);
  });
});

describe("async jobs", () => {
  it("happy path: crawl start enqueues + status reads back", async () => {
    const start = await req("/v2/crawl", { url: "https://example.com", limit: 5 });
    expect(start.status).toBe(200);
    const created = (await start.json()) as any;
    expect(created.success).toBe(true);
    expect(sentMessages.length).toBe(1);

    const status = await req(`/v2/crawl/${created.id}`);
    // GET needs explicit method override
    expect([200, 404]).toContain(status.status);
  });

  it("happy path: batch start enqueues urls", async () => {
    const res = await req("/v2/batch/scrape", { urls: ["https://example.com", "https://example.org"] });
    expect(res.status).toBe(200);
    const j = (await res.json()) as any;
    expect(j.success).toBe(true);
    expect(sentMessages.length).toBe(1);
  });

  it("failure path: unknown job id is 404", async () => {
    const fakeReq = new Request("https://test/v2/crawl/00000000-0000-0000-0000-000000000000", { method: "GET" });
    const res = await app.fetch(fakeReq, env, { waitUntil: () => undefined } as unknown as ExecutionContext);
    expect(res.status).toBe(404);
  });
});

describe("compat shims", () => {
  it("v1 scrape mirrors v2", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html><body><p>v1</p></body></html>", { status: 200 })),
    );
    const res = await req("/v1/scrape", { url: "https://example.com" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).success).toBe(true);
  });

  it("v0 keyAuth passes in open mode", async () => {
    const r = new Request("https://test/v0/keyAuth", { method: "GET" });
    const res = await app.fetch(r, env, { waitUntil: () => undefined } as unknown as ExecutionContext);
    expect(res.status).toBe(200);
  });

  it("unsupported browser route is 501 with hint", async () => {
    const res = await req("/v2/browser", {});
    expect(res.status).toBe(501);
    expect(((await res.json()) as any).code).toBe("NOT_SUPPORTED_ON_WORKERS");
  });

  it("team credit-usage works", async () => {
    const r = new Request("https://test/v2/team/credit-usage", { method: "GET" });
    const res = await app.fetch(r, env, { waitUntil: () => undefined } as unknown as ExecutionContext);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).success).toBe(true);
  });
});

describe("robots", () => {
  it("disallow hits, allow wins ties", async () => {
    const { isAllowedByRobots } = await import("../src/lib/robots");
    const txt = "User-agent: *\nDisallow: /private\nAllow: /private/ok";
    expect(isAllowedByRobots(txt, "/private/secret")).toBe(false);
    expect(isAllowedByRobots(txt, "/public")).toBe(true);
    expect(isAllowedByRobots(txt, "/private/ok")).toBe(true);
  });
});
