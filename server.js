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

// ─── Helpers ────────────────────────────────────────────────────────────────

function scoreLink(href, text) {
  const combined = (href + ' ' + text).toLowerCase();
  let score = 0;
  for (const kw of PRIMARY_PAGE_KEYWORDS) {
    if (combined.includes(kw)) score += kw.length;
  }
  return score;
}

function slugify(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '').replace(/[^a-z0-9]/gi, '-');
    const pathPart = (u.pathname + u.search)
      .replace(/^\//, '').replace(/\/$/, '')
      .replace(/[^a-z0-9]/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    const slug = pathPart ? `${host}_${pathPart}` : `${host}_home`;
    return slug.replace(/-+/g, '-').slice(0, 100);
  } catch {
    return 'page';
  }
}

async function dismissCookieBanners(page) {
  try {
    await page.evaluate(() => {
      const selectors = [
        '#onetrust-accept-btn-handler', '.onetrust-accept-btn-handler',
        '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
        '#CybotCookiebotDialogBodyButtonAccept',
        '[data-testid="cookie-policy-dialog-accept-button"]',
        '.cc-btn.cc-allow', '.cc-accept', '#accept-cookies', '.accept-cookies',
        '[class*="cookie-accept"]', '[id*="cookie-accept"]',
        '[class*="accept-cookie"]', '[class*="consent-accept"]',
        '[data-cy="accept-cookies"]', '[aria-label*="Accept cookies" i]',
      ];
      for (const sel of selectors) {
        try {
          const el = document.querySelector(sel);
          if (el && el.offsetParent !== null) { el.click(); return; }
        } catch {}
      }
      const phrases = [
        'accept all', 'accept cookies', 'allow all', 'allow cookies',
        'i agree', 'got it', 'ok, got it', 'agree & proceed',
        'accept & continue', 'accept and continue', 'agree and proceed',
      ];
      for (const el of document.querySelectorAll('button, a[role="button"], [role="button"]')) {
        const text = el.textContent.trim().toLowerCase();
        if (phrases.some(p => text.includes(p))) { el.click(); return; }
      }
    });
    await new Promise(r => setTimeout(r, 700));
  } catch {}
}

async function capturePage(page, filepath, format) {
  if (format === 'pdf') {
    await page.pdf({ path: filepath, printBackground: true, format: 'A4' });
  } else {
    await page.screenshot({ path: filepath, fullPage: true });
  }
}

function saveSessionMeta(sessionDir, meta) {
  try {
    fs.writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify(meta, null, 2));
  } catch {}
}

function loadSessionMeta(session) {
  try {
    const p = path.join(SCREENSHOTS_DIR, session, 'session.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

// ─── Discover ───────────────────────────────────────────────────────────────

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

    links.push({ url: base.origin + '/', label: 'Home', score: 999, suggested: true });
    seen.add(base.origin + '/');

    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      const text = $(el).text().trim().replace(/\s+/g, ' ');
      if (!href) return;

      let resolved;
      try { resolved = new URL(href, base.origin).href; } catch { return; }

      const resolvedUrl = new URL(resolved);
      if (resolvedUrl.hostname !== base.hostname) return;
      if (resolvedUrl.hash && resolvedUrl.pathname === base.pathname) return;

      const skip = /\.(pdf|zip|jpg|jpeg|png|gif|svg|webp|mp4|mp3|css|js|xml|json)(\?|$)/i;
      if (skip.test(resolvedUrl.pathname)) return;
      if (/\/(wp-json|wp-content|wp-admin)\//.test(resolvedUrl.pathname)) return;

      const clean = resolvedUrl.origin + resolvedUrl.pathname;
      if (seen.has(clean)) return;
      seen.add(clean);

      const score = scoreLink(resolvedUrl.pathname, text);
      links.push({ url: clean, label: text || resolvedUrl.pathname, score, suggested: score > 0 });
    });

    links.sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
    await browser.close();
    res.json({ pages: links.slice(0, 50) });
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

// ─── Screenshot stream ───────────────────────────────────────────────────────

app.post('/api/screenshot-stream', async (req, res) => {
  const {
    pages, breakpoints, sessionName,
    delay = 0, hideCookies = false, format = 'png',
  } = req.body;

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

  const ext = format === 'pdf' ? 'pdf' : 'png';
  const total = pages.length * breakpoints.length;
  send({ type: 'start', session, total });

  const sessionMeta = {
    session,
    createdAt: new Date().toISOString(),
    delay, hideCookies, format,
    results: [],
  };

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
        send({ type: 'progress', url, label, breakpoint: bp, done });

        try {
          await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
          if (hideCookies) await dismissCookieBanners(page);
          await new Promise(r => setTimeout(r, delay > 0 ? delay * 1000 : 500));

          const filename = `${slugify(url)}_${bp}.${ext}`;
          const filepath = path.join(sessionDir, filename);
          await capturePage(page, filepath, format);

          done++;
          const result = {
            url, label, breakpoint: bp,
            width: dims.width,
            file: `/screenshots/${session}/${filename}`,
            filename, format, ok: true,
          };
          sessionMeta.results.push(result);
          send({ type: 'screenshot', ...result, done });
        } catch (err) {
          done++;
          send({ type: 'screenshot', url, label, breakpoint: bp, ok: false, error: err.message, done });
        } finally {
          await page.close();
        }
      }
    }

    await browser.close();
    saveSessionMeta(sessionDir, sessionMeta);
    send({ type: 'done', session });
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    send({ type: 'error', message: err.message });
  } finally {
    res.end();
  }
});

// ─── Re-shoot single page ────────────────────────────────────────────────────

app.post('/api/reshoot', async (req, res) => {
  const { url, label, breakpoint, session, delay = 0, hideCookies = false, format = 'png' } = req.body;
  if (!url || !breakpoint || !session) return res.status(400).json({ error: 'Missing required fields' });

  const dims = BREAKPOINTS[breakpoint];
  if (!dims) return res.status(400).json({ error: 'Invalid breakpoint' });

  const sessionDir = path.join(SCREENSHOTS_DIR, session);
  if (!fs.existsSync(sessionDir)) return res.status(404).json({ error: 'Session not found' });

  const ext = format === 'pdf' ? 'pdf' : 'png';
  const filename = `${slugify(url)}_${breakpoint}.${ext}`;
  const filepath = path.join(sessionDir, filename);

  let browser;
  try {
    browser = await puppeteer.launch({ headless: true, args: PUPPETEER_ARGS });
    const page = await browser.newPage();
    await page.setViewport(dims);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    if (hideCookies) await dismissCookieBanners(page);
    await new Promise(r => setTimeout(r, delay > 0 ? delay * 1000 : 500));
    await capturePage(page, filepath, format);
    await browser.close();

    // Update session.json
    const meta = loadSessionMeta(session);
    if (meta) {
      const idx = meta.results.findIndex(r => r.url === url && r.breakpoint === breakpoint);
      const updated = { url, label, breakpoint, width: dims.width,
        file: `/screenshots/${session}/${filename}`, filename, format, ok: true };
      if (idx >= 0) meta.results[idx] = updated;
      else meta.results.push(updated);
      saveSessionMeta(sessionDir, meta);
    }

    res.json({
      url, label, breakpoint, width: dims.width,
      // Cache-bust so the browser reloads the new image
      file: `/screenshots/${session}/${filename}?t=${Date.now()}`,
      filename, format, ok: true,
    });
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

// ─── Session history ─────────────────────────────────────────────────────────

app.get('/api/sessions', (req, res) => {
  try {
    if (!fs.existsSync(SCREENSHOTS_DIR)) return res.json({ sessions: [] });
    const sessions = fs.readdirSync(SCREENSHOTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => loadSessionMeta(d.name))
      .filter(m => m && m.results?.length > 0)
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    res.json({ sessions });
  } catch {
    res.json({ sessions: [] });
  }
});

app.get('/api/sessions/:session', (req, res) => {
  const session = req.params.session.replace(/[^a-z0-9-_]/gi, '');
  const meta = loadSessionMeta(session);
  if (!meta) return res.status(404).json({ error: 'Session not found' });
  res.json(meta);
});

// ─── Download zip ────────────────────────────────────────────────────────────

app.get('/api/download/:session', (req, res) => {
  const session = req.params.session.replace(/[^a-z0-9-_]/gi, '');
  const sessionDir = path.join(SCREENSHOTS_DIR, session);
  if (!fs.existsSync(sessionDir)) return res.status(404).json({ error: 'Session not found' });

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${session}-screenshots.zip"`);

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', () => res.status(500).end());
  archive.pipe(res);
  archive.glob('*.{png,pdf}', { cwd: sessionDir }, { prefix: session });
  archive.finalize();
});

// ─── Start ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3131;
app.listen(PORT, () => console.log(`Screenshot tool running at http://localhost:${PORT}`));
