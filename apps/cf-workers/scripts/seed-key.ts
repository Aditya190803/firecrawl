/**
 * Seeds one API key into D1. Usage:
 *   API_KEY=fc-... npx wrangler d1 execute firecrawl-db --remote --command "..."
 * Or run directly with tsx against a local wrangler dump — simplest is the
 * SQL printed below, executed via `wrangler d1 execute`.
 */
export {};
declare const process: { env: Record<string, string | undefined>; exit: (code: number) => void };
const seedKey = process.env.API_KEY;
if (!seedKey) {
  console.error("Set API_KEY=fc-... env var first (generate with: pnpm keygen).");
  process.exit(1);
}
const seedHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seedKey as string)))]
  .map(b => b.toString(16).padStart(2, "0"))
  .join("");
const seedId = crypto.randomUUID();
console.log("Run this:\n");
console.log(
  `npx wrangler d1 execute firecrawl-db --remote --command "INSERT INTO api_keys (id, key_prefix, key_hash, team_id, name) VALUES ('${seedId}', '${(seedKey as string).slice(0, 8)}', '${seedHash}', 'default', 'default key');"`,
);
