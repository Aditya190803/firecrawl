import * as cheerio from "cheerio";
import { cfg, type Env } from "../env";

/**
 * Free-tier scrape pipeline (no Browser Rendering — paid plan required).
 * 1. Optional REMOTE_RENDER_URL passthrough for JS-heavy pages (self-hosted).
 * 2. Direct fetch with a real browser UA.
 * 3. HTML -> markdown/links/text via cheerio (readability-style main-content).
 */

export interface ScrapedDoc {
  url: string;
  statusCode: number;
  html?: string;
  markdown?: string;
  text?: string;
  title?: string;
  description?: string;
  links?: string[];
  error?: string;
}

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export async function fetchPageHtml(
  env: Env,
  url: string,
  timeoutMs: number,
): Promise<{ html: string; status: number; finalUrl: string }> {
  // Optional escape hatch: forward to a self-hosted renderer/fire-engine.
  if (env.REMOTE_RENDER_URL) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(env.REMOTE_RENDER_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(env.REMOTE_RENDER_SECRET
            ? { authorization: `Bearer ${env.REMOTE_RENDER_SECRET}` }
            : {}),
        },
        body: JSON.stringify({ url }),
        signal: ctrl.signal,
      });
      const data = (await res.json()) as {
        html?: string;
        status?: number;
        url?: string;
      };
      if (data.html) {
        return {
          html: data.html,
          status: data.status ?? 200,
          finalUrl: data.url ?? url,
        };
      }
    } catch {
      // fall through to direct fetch
    } finally {
      clearTimeout(t);
    }
  }

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        "user-agent": BROWSER_UA,
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
      },
      redirect: "follow",
      signal: ctrl.signal,
    });
    const html = await res.text();
    return { html, status: res.status, finalUrl: res.url || url };
  } finally {
    clearTimeout(t);
  }
}

export function htmlToMarkdown(html: string, baseUrl: string): {
  markdown: string;
  text: string;
  title?: string;
  description?: string;
  links: string[];
} {
  const $: any = cheerio.load(html);
  $("script, style, noscript, template, svg, canvas").remove();
  const title = $("title").first().text().trim() || undefined;
  const description =
    $("meta[name=\"description\"]").attr("content")?.trim() || undefined;

  const links: string[] = [];
  $("a[href]").each((_: any, el: any) => {
    try {
      const abs = new URL($(el).attr("href")!, baseUrl).toString();
      if (abs.startsWith("http")) links.push(abs);
    } catch {
      /* skip */
    }
  });

  const scope: any = $("main").first().length
    ? $("main").first()
    : $("article").first().length
      ? $("article").first()
      : $("body").length
        ? $("body").first()
        : $.root();

  const lines: string[] = [];
  const items: any[] = scope.find("h1, h2, h3, h4, p, li, pre, blockquote, td, th").toArray();
  for (const el of items) {
    const tag = (el as unknown as { tagName?: string }).tagName?.toLowerCase() ?? "";
    const text = $(el).text().replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (tag === "h1") lines.push(`# ${text}`);
    else if (tag === "h2") lines.push(`## ${text}`);
    else if (tag === "h3") lines.push(`### ${text}`);
    else if (tag === "h4") lines.push(`#### ${text}`);
    else if (tag === "li") lines.push(`- ${text}`);
    else if (tag === "blockquote") lines.push(`> ${text}`);
    else lines.push(text);
  }

  const markdown = lines.join("\n\n").slice(0, 200_000);
  const scopeText: string = scope.text().replace(/\s+/g, " ").trim();
  const text = scopeText.slice(0, 200_000);
  return { markdown, text, title, description, links: [...new Set(links)] };
}

export async function scrapeUrl(
  env: Env,
  url: string,
  opts?: { timeoutMs?: number },
): Promise<ScrapedDoc> {
  const timeoutMs = Math.min(
    opts?.timeoutMs ?? cfg(env).scrapeTimeoutMs,
    60_000, // Workers subrequest discipline: never hang a request
  );
  try {
    const { html, status, finalUrl } = await fetchPageHtml(env, url, timeoutMs);
    if (status >= 400) {
      return { url: finalUrl, statusCode: status, error: `HTTP ${status}` };
    }
    const parsed = htmlToMarkdown(html, finalUrl);
    return { url: finalUrl, statusCode: status, html, ...parsed };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      url,
      statusCode: 0,
      error: msg.includes("abort") ? "Fetch timeout" : msg,
    };
  }
}
