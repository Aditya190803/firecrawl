import type { Env } from "../env";
import { parseZodError, summarizeRequestSchema } from "../schemas";
import { getAuth } from "../lib/auth";
import { checkCredits, spendCredits } from "../lib/credits";
import { scrapeUrl } from "../lib/scrape";

type C = any;

/**
 * TEMPLATE endpoint — copy this file to build new APIs:
 * 1. Copy to src/routes/<name>.ts, rename handler + schema import.
 * 2. Add schema to src/schemas.ts.
 * 3. Mount in src/index.ts: v2.post("/<name>", <name>Handler).
 *
 * Available building blocks (src/lib/):
 * - scrapeUrl(env, url, { timeoutMs }) -> { markdown, text, links, ... }
 * - runSearch(env, query, limit) -> [{ url, title, description }]
 * - createJob/getJob/setJobStatus + WORK_QUEUE.send -> async jobs
 * - checkCredits/spendCredits, rateLimit, robotsAllowed, fireWebhook
 */
export async function summarizeHandler(c: C) {
  const auth = getAuth(c);
  const parsed = summarizeRequestSchema.safeParse(
    await c.req.json().catch(() => ({})),
  );
  if (!parsed.success) return c.json(parseZodError(parsed.error), 400);
  const body = parsed.data;

  const credits = await checkCredits((c.env as Env), auth.teamId);
  if (!credits.ok) {
    return c.json(
      {
        success: false,
        code: "INSUFFICIENT_CREDITS",
        error: "Monthly credit limit reached.",
      },
      402,
    );
  }

  const doc = await scrapeUrl(c.env as Env, body.url, { timeoutMs: 25_000 });
  if ("error" in doc && doc.error) {
    return c.json(
      { success: false, code: "SCRAPE_FAILED", error: doc.error },
      422,
    );
  }
  const text = ("text" in doc && doc.text) || "";

  // Free extractive summary (no AI needed): first N sentences.
  const sentences = text.match(/[^.!?]+[.!?]+/g) ?? [text];
  const summary = sentences
    .slice(0, body.sentences)
    .join(" ")
    .trim()
    .slice(0, 5000);

  // If Workers AI is bound, upgrade to an abstractive summary.
  let abstractive: string | undefined;
  if ((c.env as Env).AI && text.length > 200) {
    try {
      const ai = await (c.env as Env).AI!.run(
        "@cf/meta/llama-3.2-1b-instruct",
        {
          messages: [
            {
              role: "user",
              content: `Summarize this page in ${body.sentences} sentences:\n\n${text.slice(0, 8000)}`,
            },
          ],
        },
      );
      abstractive = (ai as { response?: string }).response;
    } catch {
      /* fall back to extractive */
    }
  }

  await spendCredits(c.env as Env, auth.teamId, "summarize", 1);
  return c.json({
    success: true,
    data: {
      url: ("url" in doc && doc.url) || body.url,
      title: ("title" in doc && doc.title) || undefined,
      summary: abstractive ?? summary,
      method: abstractive ? "ai" : "extractive",
    },
  });
}
