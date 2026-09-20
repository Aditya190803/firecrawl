import type { Context, Next } from "hono";
import type { Env } from "../env";
import { sha256Hex } from "./utils";

export interface AuthInfo {
  teamId: string;
  keyPrefix: string | null;
}

export type AuthCtx = any;

/** Single-user free mode: one master key via `wrangler secret put API_KEY`.
 *  Falls back to D1-backed keys (fc-xxx, sha256-hashed). If neither is
 *  configured, requests are allowed as team "default" (local dev only). */
export async function authMiddleware(c: any, next: Next) {
  const header =
    c.req.header("authorization") ?? c.req.header("x-api-key") ?? "";
  const presented = header.startsWith("Bearer ")
    ? header.slice(7).trim()
    : header.trim();

  const master = c.env.API_KEY;
  if (master && presented && constantTimeEqual(presented, master)) {
    c.set("auth", { teamId: "default", keyPrefix: "master" } satisfies AuthInfo);
    return next();
  }

  if (presented) {
    const hash = await sha256Hex(presented);
    const row = await (c.env as any).DB.prepare(
      "SELECT team_id, key_prefix FROM api_keys WHERE key_hash = ?1",
    )
      .bind(hash)
      .first();
    if (row) {
      c.set("auth", { teamId: row.team_id, keyPrefix: row.key_prefix } satisfies AuthInfo);
      return next();
    }
    if (master) {
      return c.json(
        { success: false, code: "UNAUTHORIZED", error: "Invalid API key." },
        401,
      );
    }
  }

  if (!master) {
    // No keys configured at all: local dev open mode.
    c.set("auth", { teamId: "default", keyPrefix: null } satisfies AuthInfo);
    return next();
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
  (c.get("auth") as AuthInfo | undefined) ?? { teamId: "default", keyPrefix: null };
