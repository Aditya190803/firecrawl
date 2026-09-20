import type { Env } from "../env";
import { newId, sha256Hex } from "../lib/utils";
import { hashPassword, isValidEmail, verifyPassword } from "../lib/password";

type C = any;

const SESSION_TTL_SECONDS = 30 * 24 * 3600; // 30 days

const cookieHeader = (token: string): string =>
  `fc_session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_SECONDS}`;

const clearCookieHeader = (): string =>
  "fc_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0";

const sessionTokenFrom = (c: C): string | null => {
  const auth = c.req.header("authorization") ?? "";
  if (auth.startsWith("Bearer ")) {
    const t = auth.slice(7).trim();
    if (t.startsWith("sess_")) return t;
  }
  const cookie = c.req.header("cookie") ?? "";
  const m = cookie.match(/(?:^|;\s*)fc_session=([^;]+)/);
  return m ? decodeURIComponent(m[1].trim()) : null;
};

async function setSession(
  env: Env,
  userId: string,
): Promise<{ token: string; expiresAt: string }> {
  const token = `sess_${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
  const tokenHash = await sha256Hex(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
  await (env as any).DB.prepare(
    "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?1, ?2, ?3)",
  )
    .bind(tokenHash, userId, expiresAt)
    .run();
  return { token, expiresAt };
}

export interface SessionUser {
  id: string;
  email: string;
  teamId: string;
  role: "admin" | "member";
}

/** Session auth for /dashboard/* account routes (cookie or sess_ Bearer). */
export async function dashboardAuth(c: C): Promise<SessionUser | null> {
  const token = sessionTokenFrom(c);
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const row = await (c.env as any).DB.prepare(
    `SELECT u.id AS id, u.email AS email, u.team_id AS team_id, u.role AS role
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ?1 AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  )
    .bind(tokenHash)
    .first();
  if (!row) return null;
  // D1 returns snake_case columns — map to the camelCase SessionUser shape.
  // (Passing row.team_id through as `teamId: undefined` caused D1_TYPE_ERROR
  // on every downstream bind, i.e. /me and /usage 500s.)
  return {
    id: row.id,
    email: row.email,
    teamId: row.team_id,
    role: row.role === "admin" ? "admin" : "member",
  };
}

export const requireSession = async (
  c: C,
  next: () => Promise<Response | void>,
): Promise<Response | void> => {
  const user = await dashboardAuth(c);
  if (!user) {
    return c.json(
      { success: false, code: "UNAUTHORIZED", error: "Login required." },
      401,
    );
  }
  c.set("sessionUser", user);
  return next();
};

const sessionUser = (c: C): SessionUser => c.get("sessionUser");

/** POST /dashboard/auth/signup — disabled. Accounts are invite-only. */
export async function signupHandler(c: C) {
  return c.json(
    {
      success: false,
      code: "SIGNUP_DISABLED",
      error: "Accounts are invite-only. Ask an admin to invite you.",
    },
    403,
  );
}

const newInviteToken = () =>
  `inv_${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;

const inviteExpiryIso = () => new Date(Date.now() + 7 * 86_400_000).toISOString();

const originOf = (c: C): string => new URL(c.req.url).origin;

const isSetPassword = (hash: unknown): boolean =>
  typeof hash === "string" && hash.startsWith("pbkdf2$");

/** POST /dashboard/auth/login { email, password } */
export async function loginHandler(c: C) {
  const body = await c.req.json().catch(() => ({}));
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  const row = await (c.env as any).DB.prepare(
    "SELECT id, password_hash, team_id, role FROM users WHERE email = ?1",
  )
    .bind(email)
    .first();
  if (!row) {
    return c.json(
      { success: false, code: "INVALID_CREDENTIALS", error: "Invalid email or password." },
      401,
    );
  }
  if (!isSetPassword(row.password_hash)) {
    return c.json(
      {
        success: false,
        code: "INVITE_PENDING",
        error: "This account still needs a password. Open the invite link you were sent.",
      },
      403,
    );
  }
  if (!(await verifyPassword(password, row.password_hash))) {
    return c.json(
      { success: false, code: "INVALID_CREDENTIALS", error: "Invalid email or password." },
      401,
    );
  }
  const { token } = await setSession(c.env, row.id);
  c.header("Set-Cookie", cookieHeader(token));
  return c.json({
    success: true,
    data: { email, teamId: row.team_id, role: row.role === "admin" ? "admin" : "member", token },
  });
}

/** POST /dashboard/auth/logout */
export async function logoutHandler(c: C) {
  const token = sessionTokenFrom(c);
  if (token) {
    await (c.env as any).DB.prepare("DELETE FROM sessions WHERE token_hash = ?1")
      .bind(await sha256Hex(token))
      .run();
  }
  c.header("Set-Cookie", clearCookieHeader());
  return c.json({ success: true });
}

/** GET /dashboard/auth/me */
export async function meHandler(c: C) {
  const user = sessionUser(c);
  const team = await (c.env as any).DB.prepare(
    "SELECT id, name, credits_used, credits_limit FROM teams WHERE id = ?1",
  )
    .bind(user.teamId)
    .first();
  const { monthlyUsage } = await import("../lib/credits");
  const used = await monthlyUsage(c.env, user.teamId);
  return c.json({
    success: true,
    data: {
      email: user.email,
      teamId: user.teamId,
      role: user.role,
      creditsUsed: team?.credits_used ?? 0,
      creditsUsedMonth: used,
      creditsLimit: team?.credits_limit ?? 0,
    },
  });
}

/** GET /dashboard/keys */
export async function listKeysHandler(c: C) {
  const user = sessionUser(c);
  const res = await (c.env as any).DB.prepare(
    `SELECT id, name, key_prefix, rate_limit_per_min, monthly_limit, is_active, last_used_at, created_at,
      (SELECT COALESCE(SUM(credits),0) FROM usage_log WHERE key_id = api_keys.id AND created_at >= strftime('%Y-%m-01T00:00:00.000Z','now')) AS used_month
     FROM api_keys WHERE team_id = ?1 ORDER BY created_at DESC`,
  )
    .bind(user.teamId)
    .all();
  return c.json({ success: true, data: res.results ?? [] });
}

/** POST /dashboard/keys { name?, rateLimitPerMin?, monthlyLimit? } */
export async function createKeyHandler(c: C) {
  const user = sessionUser(c);
  const body = await c.req.json().catch(() => ({}));
  const name = String(body.name ?? "default").slice(0, 80) || "default";
  const rateLimitPerMin = Math.min(
    Math.max(Number(body.rateLimitPerMin ?? 60) || 60, 1),
    1000,
  );
  const monthlyLimit = Math.max(Number(body.monthlyLimit ?? 0) || 0, 0);
  const raw = `fc-${[...crypto.getRandomValues(new Uint8Array(24))]
    .map(b => b.toString(16).padStart(2, "0"))
    .join("")}`;
  const keyHash = await sha256Hex(raw);
  const id = newId();
  await (c.env as any).DB.prepare(
    `INSERT INTO api_keys (id, key_prefix, key_hash, team_id, user_id, name, rate_limit_per_min, monthly_limit)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  )
    .bind(id, raw.slice(0, 10), keyHash, user.teamId, user.id, name, rateLimitPerMin, monthlyLimit)
    .run();
  return c.json({
    success: true,
    data: {
      id,
      name,
      key: raw,
      keyPrefix: raw.slice(0, 10),
      rateLimitPerMin,
      monthlyLimit,
      warning: "Copy this key now — it is never shown again.",
    },
  });
}

/** PATCH /dashboard/keys/:id { name?, rateLimitPerMin?, monthlyLimit? } */
export async function updateKeyHandler(c: C) {
  const user = sessionUser(c);
  const id = c.req.param("id") ?? "";
  const body = await c.req.json().catch(() => ({}));
  const existing = await (c.env as any).DB.prepare(
    "SELECT id FROM api_keys WHERE id = ?1 AND team_id = ?2",
  )
    .bind(id, user.teamId)
    .first();
  if (!existing) {
    return c.json({ success: false, code: "NOT_FOUND", error: "Key not found." }, 404);
  }
  const updates: string[] = [];
  const binds: unknown[] = [];
  if (body.name !== undefined) {
    updates.push("name = ?");
    binds.push(String(body.name).slice(0, 80));
  }
  if (body.rateLimitPerMin !== undefined) {
    updates.push("rate_limit_per_min = ?");
    binds.push(Math.min(Math.max(Number(body.rateLimitPerMin) || 60, 1), 1000));
  }
  if (body.monthlyLimit !== undefined) {
    updates.push("monthly_limit = ?");
    binds.push(Math.max(Number(body.monthlyLimit) || 0, 0));
  }
  if (updates.length > 0) {
    binds.push(id);
    await (c.env as any).DB.prepare(
      `UPDATE api_keys SET ${updates.join(", ")} WHERE id = ?${binds.length}`,
    )
      .bind(...binds)
      .run();
  }
  return c.json({ success: true });
}

/** DELETE /dashboard/keys/:id (revoke) */
export async function revokeKeyHandler(c: C) {
  const user = sessionUser(c);
  const id = c.req.param("id") ?? "";
  const res = await (c.env as any).DB.prepare(
    "UPDATE api_keys SET is_active = 0 WHERE id = ?1 AND team_id = ?2",
  )
    .bind(id, user.teamId)
    .run();
  if ((res.meta as { changes?: number })?.changes === 0) {
    return c.json({ success: false, code: "NOT_FOUND", error: "Key not found." }, 404);
  }
  return c.json({ success: true });
}

/** GET /dashboard/usage?days=30 — daily totals + per-endpoint + per-key */
export async function usageHandler(c: C) {
  const user = sessionUser(c);
  const days = Math.min(Math.max(Number(c.req.query("days") ?? 30) || 30, 1), 90);
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const db = (c.env as any).DB;
  const [daily, byEndpoint, byKey, total] = await Promise.all([
    db
      .prepare(
        `SELECT substr(created_at,1,10) AS day, SUM(credits) AS credits, COUNT(*) AS requests
         FROM usage_log WHERE team_id = ?1 AND created_at >= ?2 GROUP BY day ORDER BY day`,
      )
      .bind(user.teamId, since)
      .all(),
    db
      .prepare(
        `SELECT endpoint, SUM(credits) AS credits, COUNT(*) AS requests
         FROM usage_log WHERE team_id = ?1 AND created_at >= ?2 GROUP BY endpoint ORDER BY credits DESC`,
      )
      .bind(user.teamId, since)
      .all(),
    db
      .prepare(
        `SELECT COALESCE(k.name, '(master key)') AS name, COALESCE(k.key_prefix, 'master') AS prefix,
                SUM(u.credits) AS credits, COUNT(*) AS requests
         FROM usage_log u LEFT JOIN api_keys k ON k.id = u.key_id
         WHERE u.team_id = ?1 AND u.created_at >= ?2 GROUP BY u.key_id ORDER BY credits DESC`,
      )
      .bind(user.teamId, since)
      .all(),
    db
      .prepare(
        `SELECT COALESCE(SUM(credits),0) AS credits, COUNT(*) AS requests
         FROM usage_log WHERE team_id = ?1 AND created_at >= ?2`,
      )
      .bind(user.teamId, since)
      .first(),
  ]);
  return c.json({
    success: true,
    data: {
      days,
      total: { credits: total?.credits ?? 0, requests: total?.requests ?? 0 },
      daily: daily.results ?? [],
      byEndpoint: byEndpoint.results ?? [],
      byKey: byKey.results ?? [],
    },
  });
}

/** GET /dashboard/jobs?limit=25 — recent crawl/batch jobs */
export async function recentJobsHandler(c: C) {
  const user = sessionUser(c);
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 25) || 25, 1), 100);
  const res = await (c.env as any).DB.prepare(
    `SELECT id, kind, status, total, completed, credits_cost, created_at, updated_at
     FROM jobs WHERE team_id = ?1 ORDER BY created_at DESC LIMIT ?2`,
  )
    .bind(user.teamId, limit)
    .all();
  return c.json({ success: true, data: res.results ?? [] });
}

const requireAdmin = (c: C): Response | null => {
  if (sessionUser(c).role !== "admin") {
    return c.json({ success: false, code: "FORBIDDEN", error: "Admin only." }, 403);
  }
  return null;
};

/** POST /dashboard/auth/accept-invite { token, password } — public, first login. */
export async function acceptInviteHandler(c: C) {
  const body = await c.req.json().catch(() => ({}));
  const token = String(body.token ?? "").trim();
  const password = String(body.password ?? "");
  if (!token.startsWith("inv_")) {
    return c.json({ success: false, code: "BAD_REQUEST", error: "Invalid invite." }, 400);
  }
  if (password.length < 8) {
    return c.json(
      { success: false, code: "BAD_REQUEST", error: "Password must be at least 8 characters." },
      400,
    );
  }
  const tokenHash = await sha256Hex(token);
  const row = await (c.env as any).DB.prepare(
    "SELECT id, email, team_id, role, invite_expires_at FROM users WHERE invite_token_hash = ?1",
  )
    .bind(tokenHash)
    .first();
  if (!row) {
    return c.json(
      { success: false, code: "INVALID_INVITE", error: "Invite is invalid or already used." },
      400,
    );
  }
  if (row.invite_expires_at && Date.parse(row.invite_expires_at) < Date.now()) {
    return c.json(
      { success: false, code: "INVITE_EXPIRED", error: "Invite expired. Ask an admin to send a new one." },
      400,
    );
  }
  const passwordHash = await hashPassword(password);
  await (c.env as any).DB.prepare(
    "UPDATE users SET password_hash = ?1, invite_token_hash = ?2, invite_expires_at = ?3 WHERE id = ?4",
  )
    .bind(passwordHash, null, null, row.id)
    .run();
  const { token: session } = await setSession(c.env, row.id);
  c.header("Set-Cookie", cookieHeader(session));
  return c.json({
    success: true,
    data: {
      email: row.email,
      teamId: row.team_id,
      role: row.role === "admin" ? "admin" : "member",
      token: session,
    },
  });
}

/** GET /dashboard/users */
export async function listUsersHandler(c: C) {
  const user = sessionUser(c);
  const res = await (c.env as any).DB.prepare(
    `SELECT id, email, role, created_at, invite_expires_at,
            CASE WHEN password_hash LIKE 'pbkdf2$%' THEN 1 ELSE 0 END AS active
     FROM users WHERE team_id = ?1 ORDER BY created_at`,
  )
    .bind(user.teamId)
    .all();
  return c.json({
    success: true,
    data: (res.results ?? []).map((r: any) => ({
      id: r.id,
      email: r.email,
      role: r.role === "admin" ? "admin" : "member",
      active: r.active === 1,
      inviteExpiresAt: r.invite_expires_at ?? null,
      createdAt: r.created_at,
    })),
  });
}

/** POST /dashboard/users/invite { email } — admin only. Returns a one-time link. */
export async function inviteUserHandler(c: C) {
  const denied = requireAdmin(c);
  if (denied) return denied;
  const user = sessionUser(c);
  const body = await c.req.json().catch(() => ({}));
  const email = String(body.email ?? "").trim().toLowerCase();
  if (!isValidEmail(email)) {
    return c.json({ success: false, code: "BAD_REQUEST", error: "Valid email required." }, 400);
  }
  const existing = await (c.env as any).DB.prepare(
    "SELECT id, password_hash, team_id FROM users WHERE email = ?1",
  )
    .bind(email)
    .first();
  if (existing && isSetPassword(existing.password_hash)) {
    return c.json(
      { success: false, code: "EMAIL_TAKEN", error: "That email already has an account." },
      409,
    );
  }
  if (existing && existing.team_id !== user.teamId) {
    return c.json(
      { success: false, code: "EMAIL_TAKEN", error: "That email already has an account." },
      409,
    );
  }
  const token = newInviteToken();
  const tokenHash = await sha256Hex(token);
  const expiresAt = inviteExpiryIso();
  if (existing) {
    await (c.env as any).DB.prepare(
      "UPDATE users SET invite_token_hash = ?1, invite_expires_at = ?2 WHERE id = ?3",
    )
      .bind(tokenHash, expiresAt, existing.id)
      .run();
  } else {
    await (c.env as any).DB.prepare(
      `INSERT INTO users (id, email, password_hash, team_id, role, invite_token_hash, invite_expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
      .bind(newId(), email, "", user.teamId, "member", tokenHash, expiresAt)
      .run();
  }
  const inviteUrl = `${originOf(c)}/#/invite/${token}`;
  return c.json({
    success: true,
    data: {
      email,
      inviteUrl,
      expiresAt,
      warning: "Copy this link now. It is not stored in plain text.",
    },
  });
}

/** POST /dashboard/users/reset-password { email } — admin only. Clears the password and returns a new invite link. */
export async function resetPasswordHandler(c: C) {
  const denied = requireAdmin(c);
  if (denied) return denied;
  const user = sessionUser(c);
  const body = await c.req.json().catch(() => ({}));
  const email = String(body.email ?? "").trim().toLowerCase();
  if (!isValidEmail(email)) {
    return c.json({ success: false, code: "BAD_REQUEST", error: "Valid email required." }, 400);
  }
  const existing = await (c.env as any).DB.prepare(
    "SELECT id, team_id FROM users WHERE email = ?1",
  )
    .bind(email)
    .first();
  if (!existing || existing.team_id !== user.teamId) {
    return c.json({ success: false, code: "NOT_FOUND", error: "User not found." }, 404);
  }
  const token = newInviteToken();
  const tokenHash = await sha256Hex(token);
  const expiresAt = inviteExpiryIso();
  await (c.env as any).DB.batch([
    (c.env as any).DB.prepare(
      "UPDATE users SET password_hash = ?1, invite_token_hash = ?2, invite_expires_at = ?3 WHERE id = ?4",
    ).bind("", tokenHash, expiresAt, existing.id),
    (c.env as any).DB.prepare("DELETE FROM sessions WHERE user_id = ?1").bind(existing.id),
  ]);
  const inviteUrl = `${originOf(c)}/#/invite/${token}`;
  return c.json({
    success: true,
    data: {
      email,
      inviteUrl,
      expiresAt,
      warning: "Copy this link now. The old password no longer works.",
    },
  });
}
