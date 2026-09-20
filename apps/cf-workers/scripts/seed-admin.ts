/** Print a PBKDF2 hash for seeding the admin user. Usage: npx tsx scripts/seed-admin.ts */
import { hashPassword } from "../src/lib/password";

const email = "adityamer.work@gmail.com";
const password =
  process.env.ADMIN_PASSWORD ??
  `Hearth-${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;

const hash = await hashPassword(password);
console.log(JSON.stringify({ email, password, hash }, null, 2));
