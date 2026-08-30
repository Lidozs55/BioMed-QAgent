/**
 * P5-01 network policy tests: SSRF guards, DNS pinning, redirect policies.
 * Mirror of backend/tests/test_network_safety.py plus the completion-plan
 * P5-01 regression list.
 */

import { describe, expect, it } from "vitest";

import {
  defaultExecutor,
  PublicHttpClient,
  UnsafeUrlError,
  resolvePublicHttpTarget,
  validateCredentialedPublicUrl,
  validateHttpsSourceUrl,
  validatePublicHttpUrl,
} from "../../src/external/network/index.js";
import { fakeResolver, localExecutor, PUBLIC_IP, SECOND_PUBLIC_IP, startFixtureServer } from "./helpers.js";

const PUBLIC_HOST = { "example.com": [PUBLIC_IP] };

async function expectUnsafe(promise: Promise<unknown>, message: string): Promise<void> {
  await expect(promise).rejects.toThrow(new UnsafeUrlError(message));
}

describe("defaultExecutor connection timeout", () => {
  it("does not treat a slow response on an established socket as a connect timeout", async () => {
    const fixture = await startFixtureServer(async (_request, response) => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok");
    });
    try {
      const response = await defaultExecutor({
        url: new URL(`http://127.0.0.1:${fixture.port}/slow-response`),
        method: "GET",
        headers: {},
        body: null,
        connectTimeoutMs: 30,
        pinned: null,
      });
      expect(response.status).toBe(200);
    } finally {
      await fixture.close();
    }
  });
});

describe("resolvePublicHttpTarget (SSRF guards)", () => {
  it("rejects localhost", async () => {
    await expectUnsafe(resolvePublicHttpTarget("http://localhost/x", { resolve: fakeResolver(PUBLIC_HOST) }), "URL must have a public hostname");
  });

  it("rejects loopback 127.0.0.1 via DNS classification", async () => {
    await expectUnsafe(
      resolvePublicHttpTarget("http://127.0.0.1/x", { resolve: fakeResolver({ "127.0.0.1": [{ address: "127.0.0.1", family: 4 }] }) }),
      "URL resolved to a non-public address: 127.0.0.1",
    );
  });

  it.each([
    ["10.0.0.1", "RFC1918 10/8"],
    ["172.16.0.1", "RFC1918 172.16/12"],
    ["172.31.255.255", "RFC1918 172.16/12 upper"],
    ["192.168.0.1", "RFC1918 192.168/16"],
    ["169.254.1.1", "link-local"],
    ["100.64.0.1", "CGNAT 100.64/10"],
    ["198.18.0.1", "benchmark 198.18/15"],
    ["0.0.0.0", "unspecified"],
    ["224.0.0.1", "multicast"],
    ["255.255.255.255", "broadcast"],
  ])("rejects non-public IPv4 %s (%s)", async (ip) => {
    await expectUnsafe(
      resolvePublicHttpTarget(`http://${ip}/x`, { resolve: fakeResolver({ [ip]: [{ address: ip, family: 4 }] }) }),
      `URL resolved to a non-public address: ${ip}`,
    );
  });

  it.each([
    ["::1", "loopback"],
    ["fe80::1", "link-local"],
    ["fc00::1", "ULA"],
    ["ff02::1", "multicast"],
    ["2001:db8::1", "documentation"],
  ])("rejects non-public IPv6 %s (%s)", async (ip) => {
    await expectUnsafe(
      resolvePublicHttpTarget(`http://[${ip}]/x`, { resolve: fakeResolver({ [ip]: [{ address: ip, family: 6 }] }) }),
      `URL resolved to a non-public address: ${ip}`,
    );
  });

  it("rejects a mixed public+private DNS answer", async () => {
    await expectUnsafe(
      resolvePublicHttpTarget("http://example.com/x", {
        resolve: fakeResolver({ "example.com": [PUBLIC_IP, { address: "10.0.0.1", family: 4 }] }),
      }),
      "URL resolved to a non-public address: 10.0.0.1",
    );
  });

  it("rejects malformed URLs", async () => {
    await expectUnsafe(resolvePublicHttpTarget("not a url", { resolve: fakeResolver({}) }), "URL is malformed");
  });

  it("rejects non-HTTP schemes", async () => {
    await expectUnsafe(resolvePublicHttpTarget("ftp://example.com/x", { resolve: fakeResolver(PUBLIC_HOST) }), "only HTTP(S) URLs are allowed");
  });

  it("rejects URL credentials", async () => {
    await expectUnsafe(
      resolvePublicHttpTarget("http://user:secret@example.com/x", { resolve: fakeResolver(PUBLIC_HOST) }),
      "URL credentials are not allowed",
    );
  });

  it("rejects invalid ports", async () => {
    await expectUnsafe(resolvePublicHttpTarget("http://example.com:99999/x", { resolve: fakeResolver(PUBLIC_HOST) }), "URL contains an invalid port");
  });

  it("rejects unresolvable hostnames", async () => {
    await expectUnsafe(
      resolvePublicHttpTarget("http://missing.example.com/x", { resolve: fakeResolver(PUBLIC_HOST) }),
      "URL hostname could not be resolved: missing.example.com",
    );
  });

  it("returns an address-pinned target with Host header + SNI hostname", async () => {
    const target = await resolvePublicHttpTarget("https://example.com/a?b=1", { resolve: fakeResolver(PUBLIC_HOST) });
    expect(target.connectUrl).toBe(`https://${PUBLIC_IP.address}/a?b=1`);
    expect(target.hostHeader).toBe("example.com");
    expect(target.sniHostname).toBe("example.com");
    expect(target.port).toBe(443);
  });

  it("prefers IPv4 for the pinned connect address", async () => {
    const target = await resolvePublicHttpTarget("https://example.com/x", {
      resolve: fakeResolver({
        "example.com": [
          { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
          PUBLIC_IP,
        ],
      }),
    });
    expect(target.connectAddress).toEqual(PUBLIC_IP);
    expect(target.resolvedAddresses).toHaveLength(2);
  });
});

describe("credentialed URL policy", () => {
  it("forces HTTPS", async () => {
    await expectUnsafe(validateCredentialedPublicUrl("http://example.com/x", { resolve: fakeResolver(PUBLIC_HOST) }), "credentialed requests require HTTPS");
  });

  it("accepts a public HTTPS URL", async () => {
    await expect(validateCredentialedPublicUrl("https://example.com/x", { resolve: fakeResolver(PUBLIC_HOST) })).resolves.toBe("https://example.com/x");
  });

  it("public HTTP policy accepts http for non-credentialed use", async () => {
    await expect(validatePublicHttpUrl("http://example.com/x", { resolve: fakeResolver(PUBLIC_HOST) })).resolves.toBe("http://example.com/x");
  });
});

describe("validateHttpsSourceUrl (curated source policy)", () => {
  const ALLOWED = new Set(["source.example.com"]);

  it("requires HTTPS", async () => {
    await expectUnsafe(validateHttpsSourceUrl("http://source.example.com/x", ALLOWED), "source URL must use HTTPS");
  });

  it("rejects non-allowlisted hosts", async () => {
    await expectUnsafe(validateHttpsSourceUrl("https://evil.example.com/x", ALLOWED), "source URL host is not allowed");
  });

  it("rejects non-443 ports", async () => {
    await expectUnsafe(validateHttpsSourceUrl("https://source.example.com:8443/x", ALLOWED), "source URL port is not allowed");
  });

  it("rejects URL credentials", async () => {
    await expectUnsafe(validateHttpsSourceUrl("https://u:p@source.example.com/x", ALLOWED), "source URL credentials are forbidden");
  });

  it("rejects IP literals even when allowlisted", async () => {
    const hosts = new Set(["1.2.3.4"]);
    await expectUnsafe(validateHttpsSourceUrl("https://1.2.3.4/x", hosts), "source URL IP literals are forbidden");
  });

  it("normalizes hostname case and trailing dot", async () => {
    await expect(validateHttpsSourceUrl("https://SOURCE.example.com./x", ALLOWED, { resolvePublic: false })).resolves.toBe("source.example.com");
  });

  it("rejects private DNS answers when resolvePublic is set", async () => {
    await expectUnsafe(
      validateHttpsSourceUrl("https://source.example.com/x", ALLOWED, {
        resolvePublic: true,
        resolve: fakeResolver({ "source.example.com": [{ address: "10.0.0.9", family: 4 }] }),
      }),
      "URL resolved to a non-public address: 10.0.0.9",
    );
  });
});

describe("PublicHttpClient redirect policy", () => {
  it("rejects a redirect hop resolving to a private address", async () => {
    const fixture = await startFixtureServer((_req, res) => {
      res.writeHead(302, { Location: "/loop" });
      res.end();
    });
    try {
      // First resolution public, second resolution private (DNS rebinding).
      const answers = [PUBLIC_IP, { address: "192.168.1.1", family: 4 as const }];
      let calls = 0;
      const client = new PublicHttpClient({
        resolve: async (hostname) => {
          expect(hostname).toBe("a.example.com");
          return [answers[calls++ % answers.length] ?? PUBLIC_IP];
        },
        executor: localExecutor(fixture.port),
      });
      await expectUnsafe(client.request("http://a.example.com/start"), "URL resolved to a non-public address: 192.168.1.1");
    } finally {
      await fixture.close();
    }
  });

  it("rejects cross-host redirects by default", async () => {
    const fixture = await startFixtureServer((req, res) => {
      if (req.url === "/start") {
        res.writeHead(302, { Location: "http://b.example.com/x" });
        res.end();
      } else {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
      }
    });
    try {
      const client = new PublicHttpClient({
        resolve: fakeResolver({
          "a.example.com": [PUBLIC_IP],
          "b.example.com": [SECOND_PUBLIC_IP],
        }),
        executor: localExecutor(fixture.port),
      });
      await expectUnsafe(client.request("http://a.example.com/start"), "download redirect changed host");
    } finally {
      await fixture.close();
    }
  });

  it("follows same-host redirects with per-hop revalidation", async () => {
    const fixture = await startFixtureServer((req, res) => {
      if (req.url === "/start") {
        res.writeHead(302, { Location: "/final" });
        res.end();
      } else if (req.url === "/final") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("done");
      }
    });
    try {
      const client = new PublicHttpClient({
        resolve: fakeResolver({ "a.example.com": [PUBLIC_IP] }),
        executor: localExecutor(fixture.port),
      });
      const response = await client.request("http://a.example.com/start");
      expect(response.status).toBe(200);
      expect(response.url).toBe("http://a.example.com/final");
      const chunks: Buffer[] = [];
      for await (const chunk of response.body) chunks.push(chunk);
      expect(Buffer.concat(chunks).toString()).toBe("done");
      expect(fixture.requests.map((request) => request.url)).toEqual(["/start", "/final"]);
    } finally {
      await fixture.close();
    }
  });

  it("rejects redirect loops at the limit", async () => {
    const fixture = await startFixtureServer((_req, res) => {
      res.writeHead(302, { Location: "/loop" });
      res.end();
    });
    try {
      const client = new PublicHttpClient({
        resolve: fakeResolver({ "a.example.com": [PUBLIC_IP] }),
        executor: localExecutor(fixture.port),
      });
      await expectUnsafe(client.request("http://a.example.com/loop"), "download exceeded redirect limit");
      // Initial request + 5 redirect hops.
      expect(fixture.requests).toHaveLength(6);
    } finally {
      await fixture.close();
    }
  });

  it("rejects redirect chains longer than five hops", async () => {
    const fixture = await startFixtureServer((req, res) => {
      const current = Number.parseInt((req.url ?? "/r0").replace("/r", ""), 10);
      if (current >= 6) {
        res.writeHead(200);
        res.end("arrived");
      } else {
        res.writeHead(302, { Location: `/r${current + 1}` });
        res.end();
      }
    });
    try {
      const client = new PublicHttpClient({
        resolve: fakeResolver({ "a.example.com": [PUBLIC_IP] }),
        executor: localExecutor(fixture.port),
      });
      await expectUnsafe(client.request("http://a.example.com/r0"), "download exceeded redirect limit");
    } finally {
      await fixture.close();
    }
  });

  it("rejects a redirect without a Location header", async () => {
    const fixture = await startFixtureServer((_req, res) => {
      res.writeHead(302, {});
      res.end();
    });
    try {
      const client = new PublicHttpClient({
        resolve: fakeResolver({ "a.example.com": [PUBLIC_IP] }),
        executor: localExecutor(fixture.port),
      });
      await expectUnsafe(client.request("http://a.example.com/x"), "download redirect omitted Location");
    } finally {
      await fixture.close();
    }
  });

  it("accepts exactly five redirects then a 200", async () => {
    const fixture = await startFixtureServer((req, res) => {
      const current = Number.parseInt((req.url ?? "/r0").replace("/r", ""), 10);
      if (current >= 5) {
        res.writeHead(200);
        res.end("ok");
      } else {
        res.writeHead(302, { Location: `/r${current + 1}` });
        res.end();
      }
    });
    try {
      const client = new PublicHttpClient({
        resolve: fakeResolver({ "a.example.com": [PUBLIC_IP] }),
        executor: localExecutor(fixture.port),
      });
      const response = await client.request("http://a.example.com/r0");
      expect(response.status).toBe(200);
      expect(fixture.requests).toHaveLength(6);
    } finally {
      await fixture.close();
    }
  });

  it("enforces one total deadline across redirects and body consumption", async () => {
    let calls = 0;
    const client = new PublicHttpClient({
      resolve: fakeResolver(PUBLIC_HOST),
      executor: async (request): Promise<{
        status: number;
        headers: Record<string, string>;
        body: AsyncIterable<Buffer>;
      }> => {
        calls += 1;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 20);
          request.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(request.signal?.reason);
          }, { once: true });
        });
        return calls === 1
          ? { status: 302, headers: { location: "https://example.com/final" }, body: (async function* () {})() }
          : {
              status: 200,
              headers: {},
              body: (async function* () {
                await new Promise<void>((resolve, reject) => {
                  const timer = setTimeout(resolve, 20);
                  request.signal?.addEventListener("abort", () => {
                    clearTimeout(timer);
                    reject(request.signal?.reason);
                  }, { once: true });
                });
                yield Buffer.from("late");
              })(),
            };
      },
    });
    await expect((async () => {
      const response = await client.request("https://example.com/start", { timeoutMs: 30 });
      for await (const chunk of response.body) void chunk;
    })()).rejects.toMatchObject({ name: "TimeoutError" });
    expect(calls).toBe(2);
  });

  it("explicitly discards an unused response body", async () => {
    let finalized = false;
    const client = new PublicHttpClient({
      resolve: fakeResolver(PUBLIC_HOST),
      executor: async () => ({
        status: 503,
        headers: {},
        body: (async function* () {
          yield Buffer.from("error");
        })(),
        dispose: () => {
          finalized = true;
        },
      }),
    });
    const response = await client.request("https://example.com/error", { timeoutMs: 60_000 });
    await response.discard();
    await response.discard();
    expect(finalized).toBe(true);
  });

  it("honours a custom validateRedirect that allows cross-host hops", async () => {
    const fixture = await startFixtureServer((req, res) => {
      if (req.url === "/start") {
        res.writeHead(302, { Location: "https://b.example.com/final" });
        res.end();
      } else {
        res.writeHead(200);
        res.end("crossed");
      }
    });
    try {
      const client = new PublicHttpClient({
        resolve: fakeResolver({
          "a.example.com": [PUBLIC_IP],
          "b.example.com": [SECOND_PUBLIC_IP],
        }),
        executor: localExecutor(fixture.port),
      });
      const response = await client.request("http://a.example.com/start", {
        validateRedirect: async () => {
          /* allow */
        },
      });
      expect(response.status).toBe(200);
    } finally {
      await fixture.close();
    }
  });
});
