import type { Env } from "../env";

/**
 * Free search providers, in order of preference:
 * 1. DuckDuckGo HTML (no key, no quota) — default
 * 2. Serper / Tavily / Brave — only if user provides their own API key
 */
export interface SearchHit {
  url: string;
  title: string;
  description?: string;
}

export async function runSearch(
  env: Env,
  query: string,
  limit: number,
  opts?: { lang?: string },
): Promise<SearchHit[]> {
  const provider = (env.SEARCH_PROVIDER ?? "duckduckgo").toLowerCase();
  if (provider === "serper" && env.SERPER_API_KEY) {
    return searchSerper(env.SERPER_API_KEY, query, limit);
  }
  if (provider === "tavily" && env.TAVILY_API_KEY) {
    return searchTavily(env.TAVILY_API_KEY, query, limit);
  }
  if (provider === "brave" && env.BRAVE_API_KEY) {
    return searchBrave(env.BRAVE_API_KEY, query, limit);
  }
  const keyed =
    (provider === "serper" && !env.SERPER_API_KEY) ||
    (provider === "tavily" && !env.TAVILY_API_KEY) ||
    (provider === "brave" && !env.BRAVE_API_KEY);
  if (keyed) {
    throw new Error(
      `SEARCH_PROVIDER=${provider} needs its API key secret (see wrangler secret put). Falling back is disabled to avoid surprise results.`,
    );
  }
  return searchDuckDuckGo(query, limit, opts?.lang);
}

async function searchDuckDuckGo(
  query: string,
  limit: number,
  lang = "en",
): Promise<SearchHit[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=${lang}-en`;
  const res = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    },
  });
  if (!res.ok) throw new Error(`Search provider error: HTTP ${res.status}`);
  const html = await res.text();
  const hits: SearchHit[] = [];
  // DDG html endpoint: <a class="result__a" href="//duckduckgo.com/l/?uddg=<target>">
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gs;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && hits.length < limit) {
    const rawHref = m[1];
    const title = m[2].replace(/<[^>]+>/g, "").trim();
    const target = extractDdgTarget(rawHref);
    if (target && target.startsWith("http")) {
      hits.push({ url: target, title: title || target });
    }
  }
  return hits;
}

function extractDdgTarget(href: string): string | null {
  try {
    const m = href.match(/[?&]uddg=([^&]+)/);
    if (m) return decodeURIComponent(m[1]);
    if (href.startsWith("//")) return `https:${href}`;
    if (href.startsWith("http")) return href;
    return null;
  } catch {
    return null;
  }
}

async function searchSerper(key: string, query: string, limit: number) {
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "X-API-KEY": key, "content-type": "application/json" },
    body: JSON.stringify({ q: query, num: Math.min(limit, 100) }),
  });
  if (!res.ok) throw new Error(`Serper error: HTTP ${res.status}`);
  const data = (await res.json()) as {
    organic?: Array<{ link: string; title: string; snippet?: string }>;
  };
  return (data.organic ?? []).slice(0, limit).map(o => ({
    url: o.link,
    title: o.title,
    description: o.snippet,
  }));
}

async function searchTavily(key: string, query: string, limit: number) {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      api_key: key,
      query,
      max_results: Math.min(limit, 20),
    }),
  });
  if (!res.ok) throw new Error(`Tavily error: HTTP ${res.status}`);
  const data = (await res.json()) as {
    results?: Array<{ url: string; title: string; content?: string }>;
  };
  return (data.results ?? []).slice(0, limit).map(r => ({
    url: r.url,
    title: r.title,
    description: r.content?.slice(0, 500),
  }));
}

async function searchBrave(key: string, query: string, limit: number) {
  const res = await fetch(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.min(limit, 20)}`,
    { headers: { "X-Subscription-Token": key } },
  );
  if (!res.ok) throw new Error(`Brave error: HTTP ${res.status}`);
  const data = (await res.json()) as {
    web?: { results?: Array<{ url: string; title: string; description?: string }> };
  };
  return (data.web?.results ?? []).slice(0, limit).map(r => ({
    url: r.url,
    title: r.title,
    description: r.description,
  }));
}
