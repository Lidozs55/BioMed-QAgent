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
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const url = (p) => `http://127.0.0.1:${port}${p}`;

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();

async function follow(route, authorize, maxHops = 20) {
  let current = route.request().url();
  let method = route.request().method();
  let postData = route.request().postDataBuffer() ?? null;
  for (let hop = 0; hop < maxHops; hop += 1) {
    await authorize(current);
    const headers = { ...route.request().headers() };
    delete headers["host"];
    delete headers["connection"];
    delete headers["accept-encoding"];
    const response = await route.fetch({
      url: current,
      method,
      headers,
      postData: postData ?? undefined,
      maxRedirects: 0,
      timeout: 0,
    });
    const status = response.status();
    if (status >= 300 && status < 400) {
      const location = response.headers()["location"] ?? "";
      if (location === "") throw new Error("redirect missing Location");
      current = new URL(location, current).toString();
      if (status !== 307 && status !== 308) {
        method = "GET";
        postData = null;
      }
      continue;
    }
    await route.fulfill({ response });
    return;
  }
  throw new Error("too many redirects");
}

// Case 1: record each hop + fulfill
{
  const seen = [];
  const page = await context.newPage();
  await context.route("**/*", async (route) => {
    const request = route.request();
    const isMain = request.isNavigationRequest() && request.frame() !== null && request.frame() === page.mainFrame();
    console.log("HIT:", request.url(), "main:", isMain);
    if (!isMain) {
      await route.continue();
      return;
    }
    try {
      await follow(route, async (value) => { seen.push(value); });
    } catch (error) {
      console.log("MAIN REJECTED:", String(error));
      await route.abort();
      throw error;
    }
  });
  const response = await page.goto(url("/redirect-a"), { waitUntil: "networkidle", timeout: 15000 });
  console.log("FINAL URL:", page.url(), "status:", response?.status());
  console.log("SEEN:", JSON.stringify(seen));
  const body = await page.evaluate(() => document.documentElement.outerHTML);
  console.log("BODY OK:", body.includes("redirected body"));
  await page.close();
}

// Case 2: deny hop 2 -> goto must reject
{
  const page = await context.newPage();
  let hop = 0;
  await context.route("**/*", async (route) => {
    const request = route.request();
    const isMain = request.isNavigationRequest() && request.frame() !== null && request.frame() === page.mainFrame();
    if (!isMain) {
      await route.continue();
      return;
    }
    try {
      await follow(route, async (value) => {
        hop += 1;
        console.log("DENY-FLOW authorize:", value, "hop:", hop);
        if (hop === 2) throw new Error("fixture policy denied URL: " + value);
      });
    } catch (error) {
      console.log("MAIN DENIED, aborting:", String(error));
      await route.abort();
      throw error;
    }
  });
  try {
    await page.goto(url("/redirect-a"), { waitUntil: "networkidle", timeout: 15000 });
    console.log("CASE2 GOTO RESOLVED (unexpected)");
  } catch (error) {
    console.log("CASE2 GOTO REJECTED:", error.constructor.name, String(error.message).slice(0, 100));
  }
  await page.close();
}
await browser.close();
server.closeAllConnections();
server.close();
