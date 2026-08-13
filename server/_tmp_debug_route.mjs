import { createServer } from "node:http";
import { chromium } from "playwright";

const server = createServer((req, res) => {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  if (pathname === "/redirect-a") {
    res.writeHead(302, { location: "/redirect-target" });
    res.end();
  } else if (pathname === "/redirect-target") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><head><title>Redirected</title></head><body>redirected body</body></html>");
  } else if (pathname === "/simple") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><body>hello</body></html>");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const url = (p) => `http://127.0.0.1:${port}${p}`;

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const seen = [];
let denyNext = false;
await context.route("**/*", async (route) => {
  const request = route.request();
  const isNav = request.isNavigationRequest();
  console.log("ROUTE HIT:", request.url(), "isNav:", isNav);
  seen.push(request.url());
  if (denyNext) {
    denyNext = false;
    console.log("ABORTING", request.url());
    await route.abort();
    return;
  }
  await route.fallback();
});
const page = await context.newPage();
const response = await page.goto(url("/redirect-a"), { waitUntil: "networkidle", timeout: 15000 });
console.log("FINAL URL:", page.url(), "status:", response?.status());
console.log("SEEN:", JSON.stringify(seen));

// deny redirect hop test
seen.length = 0;
denyNext = false;
let hop = 0;
await context.unroute("**/*");
await context.route("**/*", async (route) => {
  const request = route.request();
  console.log("ROUTE2 HIT:", request.url());
  seen.push(request.url());
  hop += 1;
  if (hop === 2) {
    console.log("ABORTING hop2", request.url());
    await route.abort();
    return;
  }
  await route.fallback();
});
try {
  await page.goto(url("/redirect-a"), { waitUntil: "networkidle", timeout: 15000 });
  console.log("SECOND GOTO RESOLVED (unexpected)");
} catch (error) {
  console.log("SECOND GOTO REJECTED:", error.constructor.name, String(error.message).slice(0, 120));
}
console.log("SEEN2:", JSON.stringify(seen));
await browser.close();
server.closeAllConnections();
server.close();
