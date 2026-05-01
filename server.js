const express = require('express');
const puppeteer = require('puppeteer');
const cheerio = require('cheerio');
const archiver = require('archiver');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.static('public'));
app.use('/screenshots', express.static('screenshots'));

const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots');
if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

const PUPPETEER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
];

const BREAKPOINTS = {
  desktop: { width: 1440, height: 900 },
  tablet:  { width: 768,  height: 1024 },
  mobile:  { width: 375,  height: 812 },
};

const PRIMARY_PAGE_KEYWORDS = [
  'about', 'services', 'service', 'contact', 'work', 'portfolio',
  'team', 'blog', 'news', 'pricing', 'products', 'product', 'case-studies',
  'case-study', 'clients', 'careers', 'jobs', 'faq', 'solutions',
];

function scoreLink(href, text) {
  const combined = (href + ' ' + text).toLowerCase();
  let score = 0;
  for (const kw of PRIMARY_PAGE_KEYWORDS) {
    if (combined.includes(kw)) score += kw.length; // longer match = more specific
  }
  return score;
}

function slugify(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '').replace(/[^a-z0-9]/gi, '-');
    const pathPart = (u.pathname + u.search)
      .replace(/^\//, '')
      .replace(/\/$/, '')
      .replace(/[^a-z0-9]/gi, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    const slug = pathPart ? `${host}_${pathPart}` : `${host}_home`;
    return slug.replace(/-+/g, '-').slice(0, 100);
  } catch {
    return 'page';
  }
}

// Discover pages from a URL
app.post('/api/discover', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });

  let browser;
  try {
    const base = new URL(url);
    browser = await puppeteer.launch({ headless: true, args: PUPPETEER_ARGS });
    const page = await browser.newPage();
    await page.setViewport(BREAKPOINTS.desktop);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    const html = await page.content();
    const $ = cheerio.load(html);

    const seen = new Set();
    const links = [];

    // Always add the homepage
    links.push({ url: base.origin + '/', label: 'Home', score: 999, suggested: true });
    seen.add(base.origin + '/');

    // Gather all anchor tags
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      const text = $(el).text().trim().replace(/\s+/g, ' ');
      if (!href) return;

      let resolved;
      try {
        resolved = new URL(href, base.origin).href;
      } catch {
        return;
      }

      // Same domain only, no anchors/query strings that look like tracking
      const resolvedUrl = new URL(resolved);
      if (resolvedUrl.hostname !== base.hostname) return;
      if (resolvedUrl.hash && resolvedUrl.pathname === base.pathname) return;

      // Exclude obvious non-pages
      const skip = /\.(pdf|zip|jpg|jpeg|png|gif|svg|webp|mp4|mp3|css|js|xml|json)(\?|$)/i;
      if (skip.test(resolvedUrl.pathname)) return;
      if (resolvedUrl.pathname.includes('/wp-json/')) return;
      if (resolvedUrl.pathname.includes('/wp-content/')) return;

      const clean = resolvedUrl.origin + resolvedUrl.pathname;
      if (seen.has(clean)) return;
      seen.add(clean);

      const score = scoreLink(resolvedUrl.pathname, text);
      links.push({
        url: clean,
        label: text || resolvedUrl.pathname,
        score,
        suggested: score > 0,
      });
    });

    // Sort: suggested first (by score desc), then alphabetical
    links.sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));

    await browser.close();
    res.json({ pages: links.slice(0, 50) });
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

// Take screenshots
app.post('/api/screenshot', async (req, res) => {
  const { pages, breakpoints, sessionName } = req.body;
  if (!pages?.length) return res.status(400).json({ error: 'No pages provided' });
  if (!breakpoints?.length) return res.status(400).json({ error: 'No breakpoints provided' });

  const session = sessionName
    ? sessionName.replace(/[^a-z0-9]/gi, '-').toLowerCase()
    : `session-${Date.now()}`;
  const sessionDir = path.join(SCREENSHOTS_DIR, session);
  fs.mkdirSync(sessionDir, { recursive: true });

  const results = [];
  let browser;

  // Stream progress via SSE — but since we're REST here, collect and return
  try {
    browser = await puppeteer.launch({ headless: true, args: PUPPETEER_ARGS });

    for (const { url, label } of pages) {
      for (const bp of breakpoints) {
        const dims = BREAKPOINTS[bp];
        if (!dims) continue;

        const page = await browser.newPage();
        await page.setViewport(dims);

        try {
          await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
          // Let lazy-loaded content settle
          await new Promise(r => setTimeout(r, 800));

          const filename = `${slugify(url)}_${bp}.png`;
          const filepath = path.join(sessionDir, filename);
          await page.screenshot({ path: filepath, fullPage: true });

          results.push({
            url,
            label,
            breakpoint: bp,
            width: dims.width,
            file: `/screenshots/${session}/${filename}`,
            filename,
            ok: true,
          });
        } catch (err) {
          results.push({ url, label, breakpoint: bp, ok: false, error: err.message });
        } finally {
          await page.close();
        }
      }
    }

    await browser.close();
    res.json({ session, results });
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

// Progress endpoint — stream screenshot progress via SSE
app.post('/api/screenshot-stream', async (req, res) => {
  const { pages, breakpoints, sessionName } = req.body;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  if (!pages?.length || !breakpoints?.length) {
    send({ type: 'error', message: 'Invalid request' });
    return res.end();
  }

  const session = sessionName
    ? sessionName.replace(/[^a-z0-9]/gi, '-').toLowerCase()
    : `session-${Date.now()}`;
  const sessionDir = path.join(SCREENSHOTS_DIR, session);
  fs.mkdirSync(sessionDir, { recursive: true });

  send({ type: 'start', session, total: pages.length * breakpoints.length });

  let browser;
  let done = 0;
  try {
    browser = await puppeteer.launch({ headless: true, args: PUPPETEER_ARGS });

    for (const { url, label } of pages) {
      for (const bp of breakpoints) {
        const dims = BREAKPOINTS[bp];
        if (!dims) { done++; continue; }

        const page = await browser.newPage();
        await page.setViewport(dims);
        send({ type: 'progress', url, label, breakpoint: bp, done, message: `Capturing ${label} @ ${bp}…` });

        try {
          await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
          await new Promise(r => setTimeout(r, 800));

          const filename = `${slugify(url)}_${bp}.png`;
          const filepath = path.join(sessionDir, filename);
          await page.screenshot({ path: filepath, fullPage: true });

          done++;
          send({
            type: 'screenshot',
            url, label, breakpoint: bp,
            width: dims.width,
            file: `/screenshots/${session}/${filename}`,
            filename,
            done,
            ok: true,
          });
        } catch (err) {
          done++;
          send({ type: 'screenshot', url, label, breakpoint: bp, ok: false, error: err.message, done });
        } finally {
          await page.close();
        }
      }
    }

    await browser.close();
    send({ type: 'done', session });
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    send({ type: 'error', message: err.message });
  } finally {
    res.end();
  }
});

// Download all screenshots for a session as a zip
app.get('/api/download/:session', (req, res) => {
  const session = req.params.session.replace(/[^a-z0-9-_]/gi, '');
  const sessionDir = path.join(SCREENSHOTS_DIR, session);

  if (!fs.existsSync(sessionDir)) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const zipName = `${session}-screenshots.zip`;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', err => { res.status(500).end(); });
  archive.pipe(res);
  archive.directory(sessionDir, session);
  archive.finalize();
});

const PORT = process.env.PORT || 3131;
app.listen(PORT, () => console.log(`Screenshot tool running at http://localhost:${PORT}`));
