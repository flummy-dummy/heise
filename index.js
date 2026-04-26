const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const RSS = require("rss");

const app = express();

const PORT = Number(process.env.PORT) || 3000;
const BASE_URL = "https://www.heise.de";
const SELECT_URL = `${BASE_URL}/select/ct/`;
const CACHE_TTL_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15 * 1000;
const USER_AGENT =
  "Mozilla/5.0 (compatible; heise-select-rss/1.0; +https://www.heise.de/select/ct/)";

const http = axios.create({
  timeout: REQUEST_TIMEOUT_MS,
  headers: {
    "User-Agent": USER_AGENT,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  },
  maxRedirects: 5,
});

let cachedFeed = null;
let cachedAt = 0;
let refreshPromise = null;

function cleanText(value = "") {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeUrl(href) {
  if (!href || href.startsWith("#") || href.startsWith("mailto:")) return null;

  try {
    const url = new URL(href, BASE_URL);
    if (url.hostname !== "www.heise.de") return null;

    url.hash = "";
    url.search = "";
    return url.toString();
  } catch {
    return null;
  }
}

function isArticleUrl(url) {
  const { pathname } = new URL(url);
  const normalizedPath = pathname.replace(/\/$/, "");

  if (!normalizedPath.startsWith("/select/ct/")) return false;
  if (/\/(archiv|abo|download|login|inhalt)(\/|$)/i.test(normalizedPath)) {
    return false;
  }

  return /^\/select\/ct\/\d{4}\/\d{1,2}\/(?:seite-\d+|[^/]+)$/.test(normalizedPath);
}

function isIssueUrl(url) {
  const { pathname } = new URL(url);
  return /^\/select\/ct\/\d{4}\/\d{1,2}\/?$/.test(pathname);
}

function isUsefulTitle(title) {
  if (!title || title.length < 8 || title.length > 180) return false;
  if (!/[A-Za-zÄÖÜäöüß0-9]/.test(title)) return false;

  const lower = title.toLowerCase();
  const blocked = [
    "abo",
    "archiv",
    "datenschutz",
    "heise select",
    "impressum",
    "inhaltsverzeichnis",
    "login",
    "mehr anzeigen",
    "newsletter",
    "nächster artikel",
    "vorheriger artikel",
    "weiterlesen",
  ];

  return !blocked.some((part) => lower === part || lower.includes(` ${part} `));
}

async function fetchHtml(url) {
  try {
    const response = await http.get(url, {
      responseType: "text",
      validateStatus: (status) => status >= 200 && status < 400,
    });

    if (typeof response.data !== "string" || response.data.trim().length < 500) {
      throw new Error("leere oder unerwartet kurze HTML-Antwort");
    }

    return response.data;
  } catch (error) {
    throw new Error(`Request fehlgeschlagen (${url}): ${error.message}`);
  }
}

function extractTitle($, anchor) {
  const $anchor = $(anchor);
  const title = cleanText($anchor.attr("title") || "");
  const heading = cleanText($anchor.find("h1,h2,h3,h4").first().text());
  const text = cleanText($anchor.text());

  return [heading, title, text].find(isUsefulTitle) || "";
}

async function getArticles() {
  const overviewHtml = await fetchHtml(SELECT_URL);
  const $overview = cheerio.load(overviewHtml);
  const issueUrls = new Map();

  $overview("a[href*='/select/ct/']").each((_, element) => {
    const url = normalizeUrl($overview(element).attr("href"));
    if (!url || !isIssueUrl(url)) return;

    const match = new URL(url).pathname.match(/\/select\/ct\/(\d{4})\/(\d{1,2})\/?$/);
    if (!match) return;

    issueUrls.set(url, {
      url,
      year: Number(match[1]),
      issue: Number(match[2]),
    });
  });

  const latestIssue = [...issueUrls.values()].sort((a, b) => {
    if (b.year !== a.year) return b.year - a.year;
    return b.issue - a.issue;
  })[0];

  if (!latestIssue) {
    throw new Error(`Keine Heft-Unterseite auf ${SELECT_URL} gefunden`);
  }

  const issueHtml = await fetchHtml(latestIssue.url);
  const $ = cheerio.load(issueHtml);
  const articles = new Map();

  $("a[href*='/select/ct/']").each((_, element) => {
    const url = normalizeUrl($(element).attr("href"));
    if (!url || !isArticleUrl(url) || articles.has(url)) return;

    const title = extractTitle($, element);
    if (!title) return;

    articles.set(url, { title, url });
  });

  const result = [...articles.values()];
  console.log("Gefundene Artikel:", result.length);

  if (result.length === 0) {
    throw new Error(
      `Keine Artikel auf ${latestIssue.url} gefunden. Erwartetes URL-Muster: /select/ct/YYYY/ISSUE/seite-N`
    );
  }

  return result;
}

async function buildFeed() {
  const articles = await getArticles();

  const feed = new RSS({
    title: "heise Select c't",
    description: "RSS-Feed der aktuellen c't-Artikel auf heise Select",
    feed_url: "/rss.xml",
    site_url: SELECT_URL,
    language: "de",
    ttl: Math.floor(CACHE_TTL_MS / 60_000),
  });

  articles.forEach((article) => {
    feed.item({
      title: article.title,
      url: article.url,
      guid: article.url,
    });
  });

  return feed.xml({ indent: true });
}

async function getCachedFeed() {
  const now = Date.now();
  if (cachedFeed && now - cachedAt < CACHE_TTL_MS) {
    return cachedFeed;
  }

  if (!refreshPromise) {
    refreshPromise = buildFeed()
      .then((xml) => {
        cachedFeed = xml;
        cachedAt = Date.now();
        return xml;
      })
      .finally(() => {
        refreshPromise = null;
      });
  }

  try {
    return await refreshPromise;
  } catch (error) {
    if (cachedFeed) {
      console.error(`[rss] Aktualisierung fehlgeschlagen, liefere Cache: ${error.message}`);
      return cachedFeed;
    }

    throw error;
  }
}

app.set("trust proxy", true);
app.disable("x-powered-by");

app.get("/", (req, res) => {
  res.type("text/plain").send("ok");
});

app.get("/rss.xml", async (req, res) => {
  try {
    const xml = await getCachedFeed();
    res
      .status(200)
      .set("Cache-Control", "public, max-age=600")
      .type("application/rss+xml")
      .send(xml);
  } catch (error) {
    console.error(`[rss] Fehler: ${error.stack || error.message}`);
    res.status(502).type("text/plain").send("RSS-Feed konnte nicht erstellt werden");
  }
});

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`[server] Läuft auf Port ${PORT}`);
});

server.on("error", (error) => {
  console.error(`[server] Start fehlgeschlagen: ${error.message}`);
  process.exit(1);
});
