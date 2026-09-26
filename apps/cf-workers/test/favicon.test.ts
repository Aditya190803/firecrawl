import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import app from "../src/index";
import type { Env } from "../src/env";

describe("public favicon assets", () => {
  for (const [name, mime] of [["favicon.png", "image/png"], ["favicon.ico", "image/x-icon"]]) {
    it(`serves ${name} without authentication`, async () => {
      const bytes = readFileSync(new URL(`../public/${name}`, import.meta.url));
      const env = { ASSETS: { fetch: async (request: Request) => {
        expect(new URL(request.url).pathname).toBe(`/${name}`);
        return new Response(bytes, { headers: { "content-type": mime } });
      } } } as unknown as Env;
      const response = await app.fetch(new Request(`https://example.test/${name}?v=2`), env);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(mime);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(bytes));
    });
    it(`returns 404 for ${name} when assets are unavailable`, async () => {
      const response = await app.fetch(new Request(`https://example.test/${name}`), {} as Env);
      expect(response.status).toBe(404);
    });
  }
});
