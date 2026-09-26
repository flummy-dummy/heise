const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const path = require('node:path');

function appContext() {
  const filename = path.resolve(__dirname, '../index.js');
  const context = vm.createContext({
    require: createRequire(filename), URL, process,
    console: { log() {}, error() {} }, assert,
  });
  // Exercise the actual application functions without opening a server port.
  const source = fs.readFileSync(filename, 'utf8').split('const server = app.listen')[0];
  vm.runInContext(source, context);
  return context;
}

for (const [name, first, second] of [
  ['older special issue has a higher number', '2026/20', '2026/99'],
  ['new special issue remains eligible', '2026/99', '2026/20'],
  ['year boundary follows editorial order', '2027/1', '2026/99'],
]) {
  test(name, () => {
    const ctx = appContext();
    ctx.html = `<a href="/select/ct/2026/98">Navigation</a>
      <section class="magazines--issues">
      <a class="magazine__cover-link" href="/select/ct/${first}">First</a>
      <a class="magazine__cover-link" href="/select/ct/${second}">Second</a></section>`;
    assert.equal(vm.runInContext('findLatestIssueUrl(cheerio.load(html), MAGAZINES.ct)', ctx),
      `https://www.heise.de/select/ct/${first}`);
  });
}

test('fallback preserves link order and ignores foreign hosts and magazines', () => {
  const ctx = appContext();
  ctx.html = `<main><a href="https://example.org/select/ct/2026/99">Foreign</a>
    <a href="/select/ix/2026/99">Other magazine</a>
    <a href="/select/ct/2026/2">First</a><a href="/select/ct/2026/99">Second</a></main>`;
  assert.equal(vm.runInContext('findLatestIssueUrl(cheerio.load(html), MAGAZINES.ct)', ctx),
    'https://www.heise.de/select/ct/2026/2');
});

test('issue overview takes precedence over start-page article teasers', async () => {
  await vm.runInContext(`(async () => {
    const requested = [];
    fetchHtml = async url => {
      requested.push(url);
      if (url.endsWith('/ct/')) return '<main><a href="/select/ct/2026/20">Current</a><a href="/select/ct/2026/99/seite-1">Older special article</a></main>';
      return '<a href="/select/ct/2026/20/seite-8">Current issue article</a>';
    };
    const articles = await scrapeArticles('ct');
    assert.equal(requested[1], 'https://www.heise.de/select/ct/2026/20');
    assert.equal(articles.length, 1);
    assert.equal(articles[0].title, 'Current issue article');
  })()`, appContext());
});

test('article-only start page still works', async () => {
  await vm.runInContext(`(async () => {
    fetchHtml = async () => '<a href="/select/ct/2026/20/seite-8">Current issue article</a>';
    assert.equal((await scrapeArticles('ct')).length, 1);
  })()`, appContext());
});

for (const feed of ["getMagazineFeed('ct')", 'getAllFeed()']) {
  test(`${feed} retries after initial failure`, async () => {
    await vm.runInContext(`(async () => {
      let failing = true;
      scrapeArticles = async key => {
        if (failing) throw new Error('Temporary outage');
        return [{ title: 'Recovered article', url: 'https://www.heise.de/' + key }];
      };
      await assert.rejects(() => ${feed});
      failing = false;
      assert.match(await ${feed}, /Recovered article/);
    })()`, appContext());
  });
}

test('stale article fallback does not prevent recovery', async () => {
  await vm.runInContext(`(async () => {
    articleCache.set('ct', { data: [{title:'Old article'}], cachedAt:0, promise:null });
    let attempts = 0;
    scrapeArticles = async () => {
      if (++attempts === 1) throw new Error('Temporary outage');
      return [{title:'New article'}];
    };
    assert.equal((await getCachedArticles('ct'))[0].title, 'Old article');
    assert.equal((await getCachedArticles('ct'))[0].title, 'New article');
  })()`, appContext());
});
