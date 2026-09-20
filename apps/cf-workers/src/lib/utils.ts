export const newId = (): string =>
  typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

export const sha256Hex = async (s: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(s),
  );
  return [...new Uint8Array(digest)]
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
};

export const err = (error: string, code = "INTERNAL_ERROR") => ({
  success: false as const,
  code,
  error,
});

export const ok = <T extends object>(data: T) =>
  ({ success: true as const, ...data }) as const;

export function safeJsonParse<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export const normalizeUrl = (raw: string): string => {
  let u = (raw ?? "").trim();
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  return u;
};

export const isValidHttpUrl = (raw: string): boolean => {
  try {
    const u = new URL(normalizeUrl(raw));
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
};

export const sameDomain = (a: string, b: string): boolean => {
  try {
    return (
      new URL(a).hostname.replace(/^www\./, "") ===
      new URL(b).hostname.replace(/^www\./, "")
    );
  } catch {
    return false;
  }
};
