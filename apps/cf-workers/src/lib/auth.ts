import type { Context, Next } from "hono";
import type { Env } from "../env";
import { sha256Hex } from "./utils";
import { rateLimit } from "./ratelimit";

export interface AuthInfo {
  teamId: string;
  keyId: string | null;
  keyPrefix: string | null;
  rateLimitPerMin: number;
  keyMonthlyLimit: number; // 0 = unlimited
}

export type AuthCtx = any;

/** Single-user free mode: one master key via `wrangler secret put API_KEY`.
 *  Falls back to D1-backed keys (fc-xxx, sha256-hashed). Application routes
 *  always require a key; the bounded website playground has its own session. */
export async function authMiddleware(c: any, next: Next) {
  const header =
    c.req.header("authorization") ?? c.req.header("x-api-key") ?? "";
  const presented = header.startsWith("Bearer ")
    ? header.slice(7).trim()
    : header.trim();

  const master = c.env.API_KEY;
  if (master && presented && constantTimeEqual(presented, master)) {
    c.set("auth", {
      teamId: "default",
      keyId: null,
      keyPrefix: "master",
      rateLimitPerMin: 120,
      keyMonthlyLimit: 0,
    } satisfies AuthInfo);
    return next();
  }

  if (presented) {
    const hash = await sha256Hex(presented);
    const row = await (c.env as any).DB.prepare(
      "SELECT id, team_id, key_prefix, rate_limit_per_min, monthly_limit, is_active FROM api_keys WHERE key_hash = ?1",
    )
      .bind(hash)
      .first();
    if (row) {
      if (!row.is_active) {
        return c.json(
          { success: false, code: "KEY_REVOKED", error: "This API key has been revoked." },
          403,
        );
      }
      const limit = row.rate_limit_per_min ?? 60;
      const rl = await rateLimit(c.env, `key:${row.id}`, limit, 60);
      if (!rl.allowed) {
        return c.json(
          {
            success: false,
            code: "RATE_LIMIT",
            error: `Rate limit exceeded (${limit} requests/min for this key).`,
          },
          429,
        );
      }
      c.set("auth", {
        teamId: row.team_id,
        keyId: row.id,
        keyPrefix: row.key_prefix,
        rateLimitPerMin: limit,
        keyMonthlyLimit: row.monthly_limit ?? 0,
      } satisfies AuthInfo);
      try {
        c.executionCtx?.waitUntil?.(
          (c.env as any).DB.prepare(
            "UPDATE api_keys SET last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1",
          )
            .bind(row.id)
            .run(),
        );
      } catch {
        /* non-fatal */
      }
      return next();
    }
    if (master) {
      return c.json(
        { success: false, code: "UNAUTHORIZED", error: "Invalid API key." },
        401,
      );
    }
  }

  return c.json(
    {
      success: false,
      code: "UNAUTHORIZED",
      error: "Missing API key. Pass Authorization: Bearer <key>.",
    },
    401,
  );
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

export const getAuth = (c: any): AuthInfo =>
  (c.get("auth") as AuthInfo | undefined) ?? {
    teamId: "default",
    keyId: null,
    keyPrefix: null,
    rateLimitPerMin: 60,
    keyMonthlyLimit: 0,
  };
