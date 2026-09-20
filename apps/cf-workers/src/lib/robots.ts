import type { Env } from "../env";
import { sha256Hex } from "./utils";

/** Robots.txt check + sitemap discovery, cached in KV (24h). */
export async function robotsAllowed(
  env: Env,
  url: string,
  ignoreRobotsTxt: boolean,
): Promise<boolean> {
  if (ignoreRobotsTxt) return true;
  try {
    const u = new URL(url);
    const cacheKey = `robots:${u.origin}`;
    let txt = await env.CACHE.get(cacheKey);
    if (txt === null) {
      const res = await fetch(`${u.origin}/robots.txt`, {
        headers: { "user-agent": "Firecrawl-CF/1.0" },
      });
      txt = res.ok ? await res.text() : "";
      await env.CACHE.put(cacheKey, txt, { expirationTtl: 86_400 });
    }
    return isAllowedByRobots(txt, u.pathname, "Firecrawl");
  } catch {
    return true; // fail open: site unreachable for robots fetch
  }
}

export function isAllowedByRobots(
  robotsTxt: string,
  path: string,
  ua = "Firecrawl",
): boolean {
  let applies = false;
  let disallows: string[] = [];
  let allows: string[] = [];
  const flush = () => {
    disallows = [];
    allows = [];
    applies = false;
  };
  const lines = robotsTxt.split("\n");
  let inGroup = false;
  for (const raw of lines) {
    const line = raw.split("#")[0].trim();
    if (!line) continue;
    const [field, ...rest] = line.split(":");
    const value = rest.join(":").trim();
    const f = field.trim().toLowerCase();
    if (f === "user-agent") {
      if (inGroup && (disallows.length || allows.length)) {
        // group continues only if previous group didn't apply; simplified
      }
      const v = value.toLowerCase();
      if (v === "*" || ua.toLowerCase().includes(v) || v.includes("firecrawl")) {
        applies = true;
        inGroup = true;
        disallows = [];
        allows = [];
      } else if (inGroup && applies) {
        // keep
      } else {
        inGroup = true;
        applies = false;
      }
      void flush;
    } else if (f === "disallow" && applies) {
      if (value) disallows.push(value);
    } else if (f === "allow" && applies) {
      if (value) allows.push(value);
    }
  }
  // Longest-match wins; Allow beats Disallow on ties.
  let best = -1;
  let allowed = true;
  for (const d of disallows) {
    if (path.startsWith(d) && d.length > best) {
      best = d.length;
      allowed = false;
    }
  }
  for (const a of allows) {
    if (path.startsWith(a) && a.length >= best) {
      best = a.length;
      allowed = true;
    }
  }
  return allowed;
}

export async function discoverSitemaps(
  env: Env,
  origin: string,
): Promise<string[]> {
  const cacheKey = `sitemaps:${origin}`;
  const cached = await env.CACHE.get<string[]>(cacheKey, "json");
  if (cached) return cached;
  try {
    const res = await fetch(`${origin}/sitemap.xml`, {
      headers: { "user-agent": "Firecrawl-CF/1.0" },
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)]
      .map(m => m[1].trim())
      .slice(0, 5000);
    await env.CACHE.put(cacheKey, JSON.stringify(locs), {
      expirationTtl: 86_400,
    });
    return locs;
  } catch {
    return [];
  }
}

export const cacheKeyFor = async (url: string): Promise<string> =>
  `page:${await sha256Hex(url)}`;
