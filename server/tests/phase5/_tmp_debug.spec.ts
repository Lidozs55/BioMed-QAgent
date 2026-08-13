import { describe, expect, it } from "vitest";
import { NodeBrowserPool } from "../../src/external/browser/index.js";
import { fixtureEgressPolicy } from "./fixtures/browser/policy.js";
import { startFixtureServer } from "./helpers.js";

describe("debug route", () => {
  it("logs the redirect hop flow", async () => {
    const server = await startFixtureServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      if (pathname === "/redirect-a") {
        res.writeHead(302, { location: "/redirect-target" });
        res.end();
      } else {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html><head><title>Redirected</title></head><body>redirected body</body></html>");
      }
    });
    const validations: string[] = [];
    const pool = new NodeBrowserPool({
      policy: fixtureEgressPolicy({ onValidate: (value) => { validations.push(value); console.log("VALIDATE:", value); } }),
    });
    await pool.start();
    try {
      const result = await pool.fetch(`http://127.0.0.1:${server.port}/redirect-a`);
      console.log("RESULT:", result.status_code, result.content.slice(0, 60));
      console.log("VALIDATIONS:", JSON.stringify(validations));
      expect(validations).toEqual([
        `http://127.0.0.1:${server.port}/redirect-a`,
        `http://127.0.0.1:${server.port}/redirect-target`,
      ]);
    } finally {
      await pool.close();
      await server.close();
    }
  }, 60000);
});
