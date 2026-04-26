const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const RSS = require("rss");

const app = express();

const PORT = Number(process.env.PORT) || 3000;
const HOST = "0.0.0.0";
const BASE_URL = "https://www.heise.de";
const CACHE_TTL_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15 * 1000;

const MAGAZINES = {
  ct: { title: "c't", path: "/select/ct/" },
  ix: { title: "iX", path: "/select/ix/" },
  tr: { title: "Technology Review", path: "/select/tr/" },
  make: { title: "Make", path: "/select/make/" },
  mac: { title: "Mac & i", path: "/select/mac-and-i/" },
  foto: { title: "c't Fotografie", path: "/select/ct-foto/" },
};

const http = axios.create({
  timeout: REQUEST_TIMEOUT_MS,
  headers: {
    "User-Agent": "Mozilla/5.0",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  },
  maxRedirects: 5,
});

const articleCache = new Map();
const feedCache = new Map();

function cleanText(value = "") {
  return value.replace(/\s+/g, " ").trim();
}

function timestamp() {
  return new Date().toISOString();
}

function logInfo(message) {
  console.log(`[${timestamp()}] ${message}`);
}

function logError(message) {
  console.error(`[${timestamp()}] ${message}`);
}

function selectUrl(magazine) {
  return new URL(magazine.path, BASE_URL).toString();
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

function getHrefPath(href) {
  try {
    return new URL(href, BASE_URL).pathname;
  } catch {
    return "";
  }
}

function isBlockedPath(pathname) {
  return /\/(archiv|abo|download|login|inhalt|newsletter|suche)(\/|$)/i.test(pathname);
}

function isArticleHref(href, magazine) {
  const pathname = getHrefPath(href);
  const normalizedPath = pathname.replace(/\/$/, "");
  const magazinePath = magazine.path.replace(/\/$/, "");
  const articlePattern = new RegExp(
    `^${escapeRegExp(magazinePath)}/\\d{4}/\\d{1,2}/(?:seite-\\d+|[^/]+)$`
  );

  if (!pathname.startsWith(magazine.path)) return false;
  if (isBlockedPath(normalizedPath)) return false;
  if (href.endsWith("/") || pathname.endsWith("/")) return false;

  return articlePattern.test(normalizedPath);
}

function isIssueHref(href, magazine) {
  const pathname = getHrefPath(href);
  const magazinePath = magazine.path.replace(/\/$/, "");

  if (!pathname.startsWith(magazine.path)) return false;
  return new RegExp(`^${escapeRegExp(magazinePath)}/\\d{4}/\\d{1,2}/?$`).test(pathname);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
  const candidates = [
    $anchor.find("h1,h2,h3,h4").first().text(),
    $anchor.attr("title") || "",
    $anchor.text(),
  ];

  return candidates.map(cleanText).find(isUsefulTitle) || "";
}

function findLatestIssueUrl($, magazine) {
  const issues = new Map();

  $(`a[href*='${magazine.path}']`).each((_, element) => {
    const href = $(element).attr("href");
    if (!href || !isIssueHref(href, magazine)) return;

    const url = normalizeUrl(href);
    const match = getHrefPath(href).match(/\/(\d{4})\/(\d{1,2})\/?$/);
    if (!url || !match) return;

    issues.set(url, {
      url,
      year: Number(match[1]),
      issue: Number(match[2]),
    });
  });

  return [...issues.values()].sort((a, b) => {
    if (b.year !== a.year) return b.year - a.year;
    return b.issue - a.issue;
  })[0]?.url;
}

function extractArticlesFromHtml(html, magazine) {
  const $ = cheerio.load(html);
  const articles = new Map();

  $(`a[href*='${magazine.path}']`).each((_, element) => {
    const href = $(element).attr("href");
    if (!href || !isArticleHref(href, magazine)) return;

    const url = normalizeUrl(href);
    if (!url || articles.has(url)) return;

    const title = extractTitle($, element);
    if (!title) return;

    articles.set(url, { title, url });
  });

  return [...articles.values()];
}

async function scrapeArticles(magKey) {
  const magazine = MAGAZINES[magKey];
  const startUrl = selectUrl(magazine);

  logInfo(`SCRAPE ${magKey}`);

  const startHtml = await fetchHtml(startUrl);
  let articles = extractArticlesFromHtml(startHtml, magazine);

  if (articles.length === 0) {
    const $ = cheerio.load(startHtml);
    const issueUrl = findLatestIssueUrl($, magazine);

    if (issueUrl) {
      const issueHtml = await fetchHtml(issueUrl);
      articles = extractArticlesFromHtml(issueHtml, magazine);
    }
  }

  logInfo(`${magKey}: ${articles.length} Artikel`);

  if (articles.length === 0) {
    throw new Error(
      `Keine Artikel fuer ${magKey} gefunden. Geprueft wurde ${startUrl}; erwartet werden Links wie ${magazine.path}YYYY/ISSUE/seite-N.`
    );
  }

  return articles;
}

async function getCachedArticles(magKey) {
  const now = Date.now();
  const cache = articleCache.get(magKey);

  if (cache?.data && now - cache.cachedAt < CACHE_TTL_MS) {
    return cache.data;
  }

  if (!cache?.promise) {
    const promise = scrapeArticles(magKey)
      .then((articles) => {
        articleCache.set(magKey, {
          data: articles,
          cachedAt: Date.now(),
          promise: null,
        });
        return articles;
      })
      .catch((error) => {
        const oldCache = articleCache.get(magKey);
        if (oldCache?.data) {
          logError(`[${magKey}] Scrape fehlgeschlagen, nutze Cache: ${error.message}`);
          return oldCache.data;
        }

        throw error;
      });

    articleCache.set(magKey, {
      data: cache?.data || null,
      cachedAt: cache?.cachedAt || 0,
      promise,
    });
  }

  return articleCache.get(magKey).promise;
}

function buildFeedXml({ key, title, siteUrl, articles }) {
  const feed = new RSS({
    title,
    description: title,
    feed_url: `/rss/${key}.xml`,
    site_url: siteUrl,
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

async function getMagazineFeed(magKey) {
  const magazine = MAGAZINES[magKey];
  const cacheKey = `mag:${magKey}`;
  const now = Date.now();
  const cache = feedCache.get(cacheKey);

  if (cache?.xml && now - cache.cachedAt < CACHE_TTL_MS) {
    return cache.xml;
  }

  if (!cache?.promise) {
    const promise = getCachedArticles(magKey)
      .then((articles) => {
        const xml = buildFeedXml({
          key: magKey,
          title: `heise Select ${magazine.title}`,
          siteUrl: selectUrl(magazine),
          articles,
        });

        feedCache.set(cacheKey, {
          xml,
          cachedAt: Date.now(),
          promise: null,
        });

        return xml;
      })
      .catch((error) => {
        const oldCache = feedCache.get(cacheKey);
        if (oldCache?.xml) {
          logError(`[${magKey}] Feed fehlgeschlagen, nutze Cache: ${error.message}`);
          return oldCache.xml;
        }

        throw error;
      });

    feedCache.set(cacheKey, {
      xml: cache?.xml || null,
      cachedAt: cache?.cachedAt || 0,
      promise,
    });
  }

  return feedCache.get(cacheKey).promise;
}

async function getAllFeed() {
  const cacheKey = "all";
  const now = Date.now();
  const cache = feedCache.get(cacheKey);

  if (cache?.xml && now - cache.cachedAt < CACHE_TTL_MS) {
    return cache.xml;
  }

  if (!cache?.promise) {
    const promise = Promise.allSettled(
      Object.keys(MAGAZINES).map(async (magKey) => {
        const articles = await getCachedArticles(magKey);
        return articles.map((article) => ({
          ...article,
          title: `[${MAGAZINES[magKey].title}] ${article.title}`,
        }));
      })
    )
      .then((results) => {
        const groups = [];

        results.forEach((result, index) => {
          const magKey = Object.keys(MAGAZINES)[index];

          if (result.status === "fulfilled") {
            groups.push(result.value);
            return;
          }

          logError(`[all] ${magKey} uebersprungen: ${result.reason.message}`);
        });

        const articlesByUrl = new Map();
        groups.flat().forEach((article) => {
          if (!articlesByUrl.has(article.url)) {
            articlesByUrl.set(article.url, article);
          }
        });

        if (articlesByUrl.size === 0) {
          throw new Error("Keine Artikel fuer den Kombi-Feed gefunden");
        }

        const xml = buildFeedXml({
          key: "all",
          title: "heise Select",
          siteUrl: `${BASE_URL}/select/`,
          articles: [...articlesByUrl.values()],
        });

        feedCache.set(cacheKey, {
          xml,
          cachedAt: Date.now(),
          promise: null,
        });

        return xml;
      })
      .catch((error) => {
        const oldCache = feedCache.get(cacheKey);
        if (oldCache?.xml) {
          logError(`[all] Feed fehlgeschlagen, nutze Cache: ${error.message}`);
          return oldCache.xml;
        }

        throw error;
      });

    feedCache.set(cacheKey, {
      xml: cache?.xml || null,
      cachedAt: cache?.cachedAt || 0,
      promise,
    });
  }

  return feedCache.get(cacheKey).promise;
}

app.set("trust proxy", true);
app.disable("x-powered-by");

app.get("/", (req, res) => {
  res.type("text/plain").send("RSS läuft");
});

app.get("/rss/all.xml", async (req, res) => {
  try {
    const xml = await getAllFeed();
    res
      .status(200)
      .set("Cache-Control", "public, max-age=600")
      .type("application/rss+xml")
      .send(xml);
  } catch (error) {
    logError(`[all] ${error.stack || error.message}`);
    res.status(502).type("text/plain").send("RSS-Feed konnte nicht erstellt werden");
  }
});

app.get("/rss/:mag.xml", async (req, res) => {
  const magKey = req.params.mag;

  if (!MAGAZINES[magKey]) {
    res.status(404).type("text/plain").send("Unbekanntes Magazin");
    return;
  }

  try {
    const xml = await getMagazineFeed(magKey);
    res
      .status(200)
      .set("Cache-Control", "public, max-age=600")
      .type("application/rss+xml")
      .send(xml);
  } catch (error) {
    logError(`[${magKey}] ${error.stack || error.message}`);
    res.status(502).type("text/plain").send("RSS-Feed konnte nicht erstellt werden");
  }
});

const server = app.listen(PORT, HOST, () => {
  logInfo(`[server] Läuft auf ${HOST}:${PORT}`);
});

server.on("error", (error) => {
  logError(`[server] Start fehlgeschlagen: ${error.message}`);
  process.exit(1);
});
