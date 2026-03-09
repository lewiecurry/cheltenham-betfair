const https = require("https");
const http = require("http");
const url = require("url");

// --- Config ---
const PORT = process.env.PORT || 3001;
const BETFAIR_USERNAME = process.env.BETFAIR_USERNAME;
const BETFAIR_PASSWORD = process.env.BETFAIR_PASSWORD;
const BETFAIR_APP_KEY = process.env.BETFAIR_APP_KEY;
const BETFAIR_CERT = Buffer.from(process.env.BETFAIR_CERT_B64 || "", "base64");
const BETFAIR_KEY = Buffer.from(process.env.BETFAIR_KEY_B64 || "", "base64");
const API_SECRET = process.env.API_SECRET || ""; // optional auth token

// --- Cache ---
let cache = { data: null, ts: 0 };
const CACHE_TTL = 60; // seconds

// --- Betfair cert login ---
function certLogin() {
  return new Promise((resolve, reject) => {
    const postData = `username=${encodeURIComponent(BETFAIR_USERNAME)}&password=${encodeURIComponent(BETFAIR_PASSWORD)}`;
    const agent = new https.Agent({ cert: BETFAIR_CERT, key: BETFAIR_KEY, keepAlive: false });

    const req = https.request(
      {
        hostname: "identitysso-cert.betfair.com",
        path: "/api/certlogin",
        method: "POST",
        agent,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Application": BETFAIR_APP_KEY,
          "Content-Length": Buffer.byteLength(postData),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          agent.destroy();
          try {
            const j = JSON.parse(body);
            j.loginStatus === "SUCCESS"
              ? resolve(j.sessionToken)
              : reject(new Error(`Login: ${j.loginStatus}`));
          } catch (e) {
            reject(new Error(`Parse: ${body}`));
          }
        });
      }
    );
    req.on("error", (e) => { agent.destroy(); reject(e); });
    req.write(postData);
    req.end();
  });
}

// --- Betfair API call ---
async function bfApi(path, body, token) {
  const res = await fetch(`https://api.betfair.com/exchange/betting/rest/v1.0${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Application": BETFAIR_APP_KEY,
      "X-Authentication": token,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`BF API ${res.status}`);
  return res.json();
}

// --- Fetch all Cheltenham prices ---
async function fetchPrices() {
  const token = await certLogin();

  const markets = await bfApi("/listMarketCatalogue/", {
    filter: {
      eventTypeIds: ["7"],
      venues: ["Cheltenham"],
      marketTypeCodes: ["WIN"],
      marketStartTime: { from: "2026-03-10T00:00:00Z", to: "2026-03-14T00:00:00Z" },
    },
    marketProjection: ["RUNNER_DESCRIPTION", "MARKET_START_TIME", "EVENT"],
    maxResults: 50,
    sort: "FIRST_TO_START",
  }, token);

  const allPrices = [];
  for (const mkt of markets) {
    const books = await bfApi("/listMarketBook/", {
      marketIds: [mkt.marketId],
      priceProjection: { priceData: ["EX_BEST_OFFERS", "EX_TRADED"] },
    }, token);

    if (books?.[0]) {
      allPrices.push({
        market_id: mkt.marketId,
        market_name: mkt.marketName,
        event_name: mkt.event?.name || "",
        market_start_time: mkt.marketStartTime,
        runners: books[0].runners.map((r) => {
          const cat = mkt.runners?.find((c) => c.selectionId === r.selectionId);
          return {
            selection_id: r.selectionId,
            name: cat?.runnerName || "Unknown",
            back: r.ex?.availableToBack?.[0]?.price || null,
            lay: r.ex?.availableToLay?.[0]?.price || null,
            ltp: r.lastPriceTraded || null,
            status: r.status,
          };
        }),
      });
    }
  }

  return { fetched_at: new Date().toISOString(), markets: allPrices, count: allPrices.length };
}

// --- HTTP Server ---
const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  const parsed = url.parse(req.url, true);

  // Health check
  if (parsed.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ status: "ok", cached: !!cache.data }));
  }

  // Prices endpoint
  if (parsed.pathname === "/api/prices") {
    // Optional auth check
    if (API_SECRET) {
      const auth = req.headers.authorization;
      if (auth !== `Bearer ${API_SECRET}`) {
        res.writeHead(401, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Unauthorized" }));
      }
    }

    const now = Date.now() / 1000;
    if (cache.data && now - cache.ts < CACHE_TTL) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(cache.data));
    }

    try {
      const result = await fetchPrices();
      cache = { data: result, ts: now };
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(result));
    } catch (e) {
      console.error("Price fetch error:", e.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, () => console.log(`Betfair proxy running on port ${PORT}`));
