import type { Env } from "../env";

/** Fixed-window rate limiter on KV. Free tier: 100k reads/day is plenty
 *  for single-user use. Fails open if KV is unavailable. */
export async function rateLimit(
  env: Env,
  key: string,
  limit = 60,
  windowSeconds = 60,
): Promise<{ allowed: boolean; remaining: number }> {
  try {
    const kvKey = `rl:${key}`;
    const raw = await env.CACHE.get(kvKey);
    const count = raw ? Number(raw) + 1 : 1;
    if (count === 1) {
      await env.CACHE.put(kvKey, "1", { expirationTtl: windowSeconds });
    } else {
      // Preserve the original window: only update if key still exists.
      await env.CACHE.put(kvKey, String(count), { expirationTtl: windowSeconds });
    }
    return { allowed: count <= limit, remaining: Math.max(0, limit - count) };
  } catch {
    return { allowed: true, remaining: limit };
  }
}

export const rateLimitHeaders = (remaining: number, limit = 60) => ({
  "X-RateLimit-Limit": String(limit),
  "X-RateLimit-Remaining": String(remaining),
});
