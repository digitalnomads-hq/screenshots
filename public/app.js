(() => {
  // ── State ──────────────────────────────────────────────────────────────────
  let discoveredPages = [];
  let screenshotResults = [];
  let currentSession = null;
  let activeTab = 'all';

  // ── Elements ───────────────────────────────────────────────────────────────
  const urlInput        = document.getElementById('url-input');
  const btnDiscover     = document.getElementById('btn-discover');
  const discoverError   = document.getElementById('discover-error');
  const stepPages       = document.getElementById('step-pages');
  const stepOptions     = document.getElementById('step-options');
  const stepProgress    = document.getElementById('step-progress');
  const stepResults     = document.getElementById('step-results');
  const pagesList       = document.getElementById('pages-list');
  const pagesCount      = document.getElementById('pages-count');
  const btnRun          = document.getElementById('btn-run');
  const runSummary      = document.getElementById('run-summary');
  const progressBar     = document.getElementById('progress-bar');
  const progressLog     = document.getElementById('progress-log');
  const resultsTabs     = document.getElementById('results-tabs');
  const resultsGrid     = document.getElementById('results-grid');
  const sessionInput    = document.getElementById('session-input');
  const btnDownloadAll  = document.getElementById('btn-download-all');
  const btnShare        = document.getElementById('btn-share');
  const delayInput      = document.getElementById('delay-input');
  const delayValue      = document.getElementById('delay-value');
  const hideCookiesCb   = document.getElementById('hide-cookies');
  const toast           = document.getElementById('toast');
  const sectionHistory  = document.getElementById('section-history');
  const historyBody     = document.getElementById('history-body');
  const historyList     = document.getElementById('history-list');
  const historyCount    = document.getElementById('history-count');
  const historyChevron  = document.getElementById('history-chevron');
  const resultsSession  = document.getElementById('results-session-name');

  // ── On load ────────────────────────────────────────────────────────────────
  loadHistory();
  checkShareParam();

  // ── Delay slider ───────────────────────────────────────────────────────────
  delayInput.addEventListener('input', () => {
    delayValue.textContent = `${delayInput.value}s`;
  });

  // ── History toggle ─────────────────────────────────────────────────────────
  document.getElementById('btn-history-toggle').addEventListener('click', () => {
    const open = !historyBody.classList.contains('hidden');
    historyBody.classList.toggle('hidden', open);
    historyChevron.classList.toggle('open', !open);
  });

  async function loadHistory() {
    try {
      const res = await fetch('/api/sessions');
      const data = await res.json();
      if (!data.sessions?.length) return;

      historyCount.textContent = data.sessions.length;
      sectionHistory.style.display = '';

      historyList.innerHTML = '';
      data.sessions.forEach(s => {
        const date = s.createdAt ? new Date(s.createdAt).toLocaleString() : 'Unknown date';
        const count = s.results?.length || 0;
        const item = document.createElement('div');
        item.className = 'history-item';
        item.innerHTML = `
          <div class="history-info">
            <div class="history-name">${escHtml(s.session)}</div>
            <div class="history-meta">${date} · ${count} screenshot${count !== 1 ? 's' : ''}</div>
          </div>
          <div class="history-actions">
            <button class="btn btn-ghost btn-sm" data-load="${escHtml(s.session)}">Load</button>
            <a class="btn btn-ghost btn-sm" href="/api/download/${escHtml(s.session)}" download>ZIP</a>
          </div>
        `;
        item.querySelector('[data-load]').addEventListener('click', () => loadSession(s.session));
        historyList.appendChild(item);
      });
    } catch {}
  }

  async function loadSession(session) {
    try {
      const res = await fetch(`/api/sessions/${session}`);
      const data = await res.json();
      if (!data.results?.length) return showToast('No screenshots in this session');

      screenshotResults = data.results.filter(r => r.ok);
      currentSession = session;
      renderResults();
      stepResults.classList.remove('hidden');
      stepResults.scrollIntoView({ behavior: 'smooth' });
    } catch {
      showToast('Failed to load session');
    }
  }

  // ── Share param on load ────────────────────────────────────────────────────
  function checkShareParam() {
    const s = new URLSearchParams(location.search).get('s');
    if (s) loadSession(s);
  }

  // ── Discover ───────────────────────────────────────────────────────────────
  btnDiscover.addEventListener('click', () => discover());
  urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') discover(); });

  async function discover() {
    const url = urlInput.value.trim();
    if (!url) { showError('Please enter a URL'); return; }

    discoverError.classList.add('hidden');
    btnDiscover.disabled = true;
    btnDiscover.innerHTML = '<span class="spinner"></span>Scanning…';

    try {
      const res = await fetch('/api/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to discover pages');

      discoveredPages = data.pages;
      renderPagesList();
      stepPages.classList.remove('hidden');
      stepOptions.classList.remove('hidden');
      stepPages.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      showError(err.message);
    } finally {
      btnDiscover.disabled = false;
      btnDiscover.textContent = 'Discover';
    }
  }

  function showError(msg) {
    discoverError.textContent = msg;
    discoverError.classList.remove('hidden');
  }

  // ── Page list ──────────────────────────────────────────────────────────────
  function renderPagesList() {
    pagesList.innerHTML = '';
    discoveredPages.forEach((page, i) => {
      const item = document.createElement('label');
      item.className = 'page-item' + (page.suggested ? ' selected' : '');
      item.innerHTML = `
        <input type="checkbox" data-index="${i}" ${page.suggested ? 'checked' : ''} />
        <div class="page-label">
          <div class="title">${escHtml(page.label || page.url)}</div>
          <div class="url">${escHtml(page.url)}</div>
        </div>
        ${page.suggested ? '<span class="suggested-badge">Suggested</span>' : ''}
      `;
      const cb = item.querySelector('input');
      cb.addEventListener('change', () => {
        page._checked = cb.checked;
        item.classList.toggle('selected', cb.checked);
        updateRunSummary();
      });
      page._checked = page.suggested;
      pagesList.appendChild(item);
    });
    updateCount();
    updateRunSummary();
  }

  function updateCount() {
    const sel = discoveredPages.filter(p => p._checked).length;
    pagesCount.textContent = `${discoveredPages.length} pages found · ${sel} selected`;
  }

  function updateRunSummary() {
    const sel = discoveredPages.filter(p => p._checked);
    const bps = getSelectedBreakpoints();
    const fmt = getFormat();
    const multiplier = fmt === 'both' ? 2 : 1;
    const total = sel.length * bps.length * multiplier;
    updateCount();
    runSummary.textContent = total > 0
      ? `${sel.length} page${sel.length !== 1 ? 's' : ''} × ${bps.length} breakpoint${bps.length !== 1 ? 's' : ''}${fmt === 'both' ? ' × 2 formats' : ''} = ${total} file${total !== 1 ? 's' : ''}`
      : 'Select at least one page and one breakpoint';
    btnRun.disabled = total === 0;
  }

  document.getElementById('btn-select-suggested').addEventListener('click', () => {
    discoveredPages.forEach((p, i) => {
      p._checked = p.suggested;
      const cb = pagesList.querySelectorAll('input')[i];
      if (cb) { cb.checked = p.suggested; cb.closest('.page-item').classList.toggle('selected', p.suggested); }
    });
    updateRunSummary();
  });
  document.getElementById('btn-select-all').addEventListener('click', () => {
    discoveredPages.forEach((p, i) => {
      p._checked = true;
      const cb = pagesList.querySelectorAll('input')[i];
      if (cb) { cb.checked = true; cb.closest('.page-item').classList.add('selected'); }
    });
    updateRunSummary();
  });
  document.getElementById('btn-select-none').addEventListener('click', () => {
    discoveredPages.forEach((p, i) => {
      p._checked = false;
      const cb = pagesList.querySelectorAll('input')[i];
      if (cb) { cb.checked = false; cb.closest('.page-item').classList.remove('selected'); }
    });
    updateRunSummary();
  });

  document.querySelectorAll('input[name=bp]').forEach(cb => cb.addEventListener('change', updateRunSummary));
  document.querySelectorAll('input[name=format]').forEach(r => r.addEventListener('change', updateRunSummary));

  function getSelectedBreakpoints() {
    return [...document.querySelectorAll('input[name=bp]:checked')].map(cb => cb.value);
  }
  function getFormat() {
    return document.querySelector('input[name=format]:checked')?.value || 'png';
  }

  // ── Run screenshots ────────────────────────────────────────────────────────
  btnRun.addEventListener('click', () => runScreenshots());

  async function runScreenshots() {
    const pages = discoveredPages.filter(p => p._checked).map(p => ({ url: p.url, label: p.label }));
    const breakpoints = getSelectedBreakpoints();
    const format = getFormat();
    if (!pages.length || !breakpoints.length) return;

    // For 'both', we run two passes
    const formats = format === 'both' ? ['png', 'pdf'] : [format];
    const total = pages.length * breakpoints.length * formats.length;
    let done = 0;
    screenshotResults = [];
    currentSession = null;
    activeTab = 'all';

    stepProgress.classList.remove('hidden');
    stepOptions.classList.add('hidden');
    stepPages.classList.add('hidden');
    progressBar.style.width = '0%';
    progressLog.innerHTML = '';
    stepProgress.scrollIntoView({ behavior: 'smooth' });

    const opts = {
      pages,
      breakpoints,
      sessionName: sessionInput.value.trim() || undefined,
      delay: parseInt(delayInput.value, 10),
      hideCookies: hideCookiesCb.checked,
    };

    try {
      for (const fmt of formats) {
        // For 'both', reuse same session name on second pass
        const sName = formats.length > 1 && fmt === 'pdf' && currentSession
          ? currentSession
          : opts.sessionName;

        const res = await fetch('/api/screenshot-stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...opts, sessionName: sName, format: fmt }),
        });

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done: streamDone, value } = await reader.read();
          if (streamDone) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split('\n\n');
          buffer = parts.pop();

          for (const part of parts) {
            if (!part.startsWith('data: ')) continue;
            let event;
            try { event = JSON.parse(part.slice(6)); } catch { continue; }

            if (event.type === 'start') {
              currentSession = event.session;
            } else if (event.type === 'progress') {
              addLog(`Capturing ${event.label} @ ${event.breakpoint}${formats.length > 1 ? ` (${fmt.toUpperCase()})` : ''}…`, 'pending');
            } else if (event.type === 'screenshot') {
              done++;
              progressBar.style.width = `${(done / total) * 100}%`;
              if (event.ok) {
                screenshotResults.push(event);
                addLog(`✓ ${event.label} @ ${event.breakpoint}${formats.length > 1 ? ` (${fmt.toUpperCase()})` : ''}`, 'ok');
              } else {
                addLog(`✗ ${event.label} @ ${event.breakpoint}: ${event.error}`, 'fail');
              }
            } else if (event.type === 'done') {
              if (fmt === formats[formats.length - 1]) {
                progressBar.style.width = '100%';
                setTimeout(() => {
                  stepProgress.classList.add('hidden');
                  renderResults();
                  stepResults.classList.remove('hidden');
                  stepResults.scrollIntoView({ behavior: 'smooth' });
                  loadHistory();
                }, 600);
              }
            } else if (event.type === 'error') {
              addLog(`Error: ${event.message}`, 'fail');
            }
          }
        }
      }
    } catch (err) {
      addLog(`Fatal error: ${err.message}`, 'fail');
    }
  }

  function addLog(msg, state = 'pending') {
    const line = document.createElement('div');
    line.className = 'log-line ' + state;
    line.innerHTML = `<span class="dot"></span><span>${escHtml(msg)}</span>`;
    progressLog.appendChild(line);
    progressLog.scrollTop = progressLog.scrollHeight;
  }

  // ── Results ────────────────────────────────────────────────────────────────
  function renderResults() {
    if (currentSession) {
      btnDownloadAll.href = `/api/download/${currentSession}`;
      btnDownloadAll.classList.remove('hidden');
      resultsSession.textContent = currentSession;
    }

    const bps = [...new Set(screenshotResults.map(r => r.breakpoint))];
    resultsTabs.innerHTML = '';
    resultsTabs.appendChild(makeTab('all', 'All'));
    bps.forEach(bp => resultsTabs.appendChild(makeTab(bp, bp.charAt(0).toUpperCase() + bp.slice(1))));
    setActiveTab('all');
  }

  function makeTab(bp, label) {
    const btn = document.createElement('button');
    btn.className = 'tab-btn';
    btn.dataset.bp = bp;
    btn.innerHTML = `<span class="tab-dot"></span>${label}`;
    btn.addEventListener('click', () => setActiveTab(bp));
    return btn;
  }

  function setActiveTab(bp) {
    activeTab = bp;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.bp === bp));
    const filtered = bp === 'all' ? screenshotResults : screenshotResults.filter(r => r.breakpoint === bp);
    renderGrid(filtered);
  }

  function renderGrid(results) {
    resultsGrid.innerHTML = '';
    results.forEach(r => renderCard(r, resultsGrid));
  }

  function renderCard(r, container, existingCard = null) {
    const isPdf = r.format === 'pdf' || r.filename?.endsWith('.pdf');
    const card = existingCard || document.createElement('div');
    card.className = 'result-card';
    card.innerHTML = `
      <div class="result-thumb">
        ${isPdf
          ? `<div class="pdf-placeholder">📄<span>${escHtml(r.label)}</span></div>`
          : `<img src="${r.file}" alt="${escHtml(r.label)} @ ${r.breakpoint}" loading="lazy" />`
        }
        <div class="thumb-overlay">${isPdf ? '📄 Open PDF' : '🔍 View full size'}</div>
      </div>
      <div class="result-info">
        <div class="result-title">${escHtml(r.label)}</div>
        <div class="result-meta">
          <span class="result-bp ${r.breakpoint}">${r.breakpoint} · ${r.width}px</span>
          <div class="card-actions">
            <button class="btn-reshoot" data-url="${escHtml(r.url)}" data-label="${escHtml(r.label)}" data-bp="${r.breakpoint}">Re-shoot</button>
            <a class="dl-link" href="${r.file}" download="${r.filename}">↓</a>
          </div>
        </div>
      </div>
    `;

    card.querySelector('.result-thumb').addEventListener('click', () => {
      if (isPdf) window.open(r.file, '_blank');
      else openLightbox(r.file);
    });

    card.querySelector('.btn-reshoot').addEventListener('click', async (e) => {
      await reshoot(r, card);
    });

    if (!existingCard) container.appendChild(card);
  }

  // ── Re-shoot ───────────────────────────────────────────────────────────────
  async function reshoot(r, card) {
    const btn = card.querySelector('.btn-reshoot');
    btn.classList.add('loading');
    btn.textContent = '…';

    try {
      const res = await fetch('/api/reshoot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: r.url,
          label: r.label,
          breakpoint: r.breakpoint,
          session: currentSession,
          delay: parseInt(delayInput.value, 10),
          hideCookies: hideCookiesCb.checked,
          format: r.format || 'png',
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      // Update state
      const idx = screenshotResults.findIndex(x => x.url === r.url && x.breakpoint === r.breakpoint && x.format === r.format);
      if (idx >= 0) screenshotResults[idx] = data;

      // Re-render card in place
      renderCard(data, null, card);
      showToast('Re-shot successfully');
    } catch (err) {
      btn.classList.remove('loading');
      btn.textContent = 'Re-shoot';
      showToast(`Failed: ${err.message}`);
    }
  }

  // ── Share ──────────────────────────────────────────────────────────────────
  btnShare.addEventListener('click', () => {
    if (!currentSession) return;
    const url = `${location.origin}${location.pathname}?s=${currentSession}`;
    navigator.clipboard.writeText(url).then(() => showToast('Link copied to clipboard'));
  });

  // ── Start over ─────────────────────────────────────────────────────────────
  document.getElementById('btn-new').addEventListener('click', () => {
    stepResults.classList.add('hidden');
    stepProgress.classList.add('hidden');
    stepOptions.classList.remove('hidden');
    stepPages.classList.remove('hidden');
    btnDownloadAll.classList.add('hidden');
    resultsSession.textContent = '';
    // Remove ?s= param from URL without reload
    history.replaceState({}, '', location.pathname);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  // ── Lightbox ───────────────────────────────────────────────────────────────
  function openLightbox(src) {
    const lb = document.createElement('div');
    lb.className = 'lightbox';
    lb.innerHTML = `<button class="lightbox-close">✕</button><img src="${src}" alt="Screenshot" />`;
    lb.addEventListener('click', e => { if (e.target === lb) lb.remove(); });
    lb.querySelector('.lightbox-close').addEventListener('click', () => lb.remove());
    document.body.appendChild(lb);
  }

  // ── Toast ──────────────────────────────────────────────────────────────────
  let toastTimer;
  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add('show');
    toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.classList.add('hidden'), 250);
    }, 2500);
  }

  // ── Util ───────────────────────────────────────────────────────────────────
  function escHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }
})();
