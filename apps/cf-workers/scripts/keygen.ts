export {};
/** Generates a free-tier API key: fc-<32 hex chars>. Prints it + its sha256. */
const apiKey = `fc-${[...crypto.getRandomValues(new Uint8Array(16))]
  .map(b => b.toString(16).padStart(2, "0"))
  .join("")}`;
const keyHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(apiKey)))]
  .map(b => b.toString(16).padStart(2, "0"))
  .join("");
console.log(`API_KEY (wrangler secret put API_KEY):\n${apiKey}\n`);
console.log(`D1 seed values (scripts/seed-key.ts does this for you):`);
console.log(`  key_prefix: ${apiKey.slice(0, 8)}`);
console.log(`  key_hash:   ${keyHash}`);
