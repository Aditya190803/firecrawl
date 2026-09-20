import { z } from "zod";

// Mirrors apps/api zod shapes, trimmed to what runs on Workers.
// Unknown keys are stripped (not rejected) so existing SDKs keep working.

const urlSchema = z
  .string()
  .min(1, "url is required")
  .transform(v => {
    const t = v.trim();
    return /^https?:\/\//i.test(t) ? t : `https://${t}`;
  })
  .refine(v => {
    try {
      const u = new URL(v);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch {
      return false;
    }
  }, "Invalid URL");

const formatSchema = z.object({
  type: z.enum([
    "markdown",
    "html",
    "rawHtml",
    "text",
    "links",
    "screenshot",
    "summary",
    "json",
    "attributes",
  ]),
}).passthrough();

const scrapeOptionsSchema = z
  .object({
    formats: z.array(formatSchema).default([{ type: "markdown" }]),
    onlyMainContent: z.boolean().default(true),
    includeTags: z.array(z.string()).optional(),
    excludeTags: z.array(z.string()).optional(),
    timeout: z.number().int().positive().max(120_000).optional(),
    waitFor: z.number().int().min(0).max(30_000).optional(),
    mobile: z.boolean().optional(),
    skipTlsVerification: z.boolean().optional(),
    removeBase64Images: z.boolean().optional(),
    fastMode: z.boolean().optional(),
    useCache: z.boolean().optional(),
    maxAge: z.number().int().min(0).optional(),
  })
  .passthrough();

export const scrapeRequestSchema = z
  .object({ url: urlSchema })
  .merge(scrapeOptionsSchema)
  .passthrough();
export type ScrapeRequest = z.infer<typeof scrapeRequestSchema>;

export const batchScrapeRequestSchema = z
  .object({
    urls: z.array(urlSchema).min(1).max(1000),
    webhook: z
      .object({ url: z.string().optional(), events: z.array(z.string()).optional() })
      .passthrough()
      .optional(),
    appendToId: z.string().uuid().optional(),
    ignoreInvalidURLs: z.boolean().default(true),
    maxConcurrency: z.number().int().positive().max(10).optional(),
  })
  .merge(scrapeOptionsSchema)
  .passthrough();
export type BatchScrapeRequest = z.infer<typeof batchScrapeRequestSchema>;

export const crawlRequestSchema = z
  .object({
    url: urlSchema,
    limit: z.number().int().min(1).max(1000).default(100),
    maxDepth: z.number().int().min(0).max(10).default(5),
    includePaths: z.array(z.string()).default([]),
    excludePaths: z.array(z.string()).default([]),
    includeSubdomains: z.boolean().default(false),
    ignoreRobotsTxt: z.boolean().default(false),
    deduplicateSimilarURLs: z.boolean().default(true),
    allowExternalLinks: z.boolean().default(false),
    webhook: z
      .object({ url: z.string().optional(), events: z.array(z.string()).optional() })
      .passthrough()
      .optional(),
    scrapeOptions: scrapeOptionsSchema.optional(),
  })
  .passthrough();
export type CrawlRequest = z.infer<typeof crawlRequestSchema>;

export const mapRequestSchema = z
  .object({
    url: urlSchema,
    limit: z.number().int().min(1).max(5000).default(5000),
    includeSubdomains: z.boolean().default(true),
    search: z.string().optional(),
    ignoreRobotsTxt: z.boolean().default(false),
    useIndex: z.boolean().default(false),
  })
  .passthrough();
export type MapRequest = z.infer<typeof mapRequestSchema>;

export const searchRequestSchema = z
  .object({
    query: z.string().min(1, "query is required"),
    limit: z.number().int().min(1).max(100).default(10),
    lang: z.string().default("en"),
    country: z.string().default("us"),
    includeDomains: z.array(z.string()).default([]),
    excludeDomains: z.array(z.string()).default([]),
    scrapeOptions: scrapeOptionsSchema.optional(),
  })
  .passthrough();
export type SearchRequest = z.infer<typeof searchRequestSchema>;

export const extractRequestSchema = z
  .object({
    urls: z.array(urlSchema).min(1).max(100).optional(),
    url: urlSchema.optional(),
    prompt: z.string().max(10_000).optional(),
    schema: z.record(z.string(), z.unknown()).optional(),
    webhook: z
      .object({ url: z.string().optional(), events: z.array(z.string()).optional() })
      .passthrough()
      .optional(),
  })
  .passthrough()
  .refine(v => v.urls || v.url, "Provide urls[] or url");
export type ExtractRequest = z.infer<typeof extractRequestSchema>;

export const agentRequestSchema = z
  .object({
    urls: z.array(urlSchema).optional(),
    prompt: z.string().max(10_000),
    schema: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export type AgentRequest = z.infer<typeof agentRequestSchema>;

export const llmsTxtRequestSchema = z
  .object({
    url: urlSchema,
    limit: z.number().int().min(1).max(500).default(100),
    maxDepth: z.number().int().min(0).max(10).default(5),
    showFullText: z.boolean().default(false),
  })
  .passthrough();

export const deepResearchRequestSchema = z
  .object({
    query: z.string().min(1),
    limit: z.number().int().min(1).max(50).default(10),
    maxDepth: z.number().int().min(1).max(5).default(2),
  })
  .passthrough();

export const monitorRequestSchema = z
  .object({
    url: urlSchema,
    schedule: z.enum(["hourly", "daily", "weekly"]).default("daily"),
  })
  .passthrough();

// Template for new endpoints: copy this block, rename, adjust fields.
// 1. add schema here, 2. add handler in src/routes/<name>.ts,
// 3. mount with v2.post("/<name>", handler) in src/index.ts.
export const summarizeRequestSchema = z
  .object({
    url: urlSchema,
    sentences: z.number().int().min(1).max(10).default(3),
  })
  .passthrough();
export type SummarizeRequest = z.infer<typeof summarizeRequestSchema>;

export const parseZodError = (e: z.ZodError) => ({
  success: false as const,
  code: "BAD_REQUEST" as const,
  error: e.issues.map(i => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
});
