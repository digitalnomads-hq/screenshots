(() => {
  // State
  let discoveredPages = [];
  let screenshotResults = [];
  let activeTab = 'all';

  // Elements
  const urlInput       = document.getElementById('url-input');
  const btnDiscover    = document.getElementById('btn-discover');
  const discoverError  = document.getElementById('discover-error');
  const stepPages      = document.getElementById('step-pages');
  const stepOptions    = document.getElementById('step-options');
  const stepProgress   = document.getElementById('step-progress');
  const stepResults    = document.getElementById('step-results');
  const pagesList      = document.getElementById('pages-list');
  const pagesCount     = document.getElementById('pages-count');
  const btnRun         = document.getElementById('btn-run');
  const runSummary     = document.getElementById('run-summary');
  const progressBar    = document.getElementById('progress-bar');
  const progressLog    = document.getElementById('progress-log');
  const resultsTabs       = document.getElementById('results-tabs');
  const resultsGrid       = document.getElementById('results-grid');
  const sessionInput      = document.getElementById('session-input');
  const btnDownloadAll    = document.getElementById('btn-download-all');

  // --- Discover ---
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

  // --- Page List ---
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
    const total = discoveredPages.length;
    const sel = discoveredPages.filter(p => p._checked).length;
    pagesCount.textContent = `${total} pages found · ${sel} selected`;
  }

  function updateRunSummary() {
    const selectedPages = discoveredPages.filter(p => p._checked);
    const bps = getSelectedBreakpoints();
    const total = selectedPages.length * bps.length;
    updateCount();
    runSummary.textContent = total > 0
      ? `${selectedPages.length} page${selectedPages.length !== 1 ? 's' : ''} × ${bps.length} breakpoint${bps.length !== 1 ? 's' : ''} = ${total} screenshot${total !== 1 ? 's' : ''}`
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

  document.querySelectorAll('input[name=bp]').forEach(cb => {
    cb.addEventListener('change', updateRunSummary);
  });

  function getSelectedBreakpoints() {
    return [...document.querySelectorAll('input[name=bp]:checked')].map(cb => cb.value);
  }

  // --- Run Screenshots ---
  btnRun.addEventListener('click', () => runScreenshots());

  async function runScreenshots() {
    const pages = discoveredPages
      .filter(p => p._checked)
      .map(p => ({ url: p.url, label: p.label }));
    const breakpoints = getSelectedBreakpoints();
    if (!pages.length || !breakpoints.length) return;

    const total = pages.length * breakpoints.length;
    let done = 0;
    screenshotResults = [];
    activeTab = 'all';

    stepProgress.classList.remove('hidden');
    stepOptions.classList.add('hidden');
    stepPages.classList.add('hidden');
    progressBar.style.width = '0%';
    progressLog.innerHTML = '';
    stepProgress.scrollIntoView({ behavior: 'smooth' });

    try {
      const res = await fetch('/api/screenshot-stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pages,
          breakpoints,
          sessionName: sessionInput.value.trim() || undefined,
        }),
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

          if (event.type === 'progress') {
            addLog(`Capturing ${event.label} @ ${event.breakpoint}…`, 'pending');
          } else if (event.type === 'screenshot') {
            done++;
            progressBar.style.width = `${(done / total) * 100}%`;
            if (event.ok) {
              screenshotResults.push(event);
              addLog(`✓ ${event.label} @ ${event.breakpoint}`, 'ok');
            } else {
              addLog(`✗ ${event.label} @ ${event.breakpoint}: ${event.error}`, 'fail');
            }
          } else if (event.type === 'done') {
            progressBar.style.width = '100%';
            setTimeout(() => {
              stepProgress.classList.add('hidden');
              renderResults();
              stepResults.classList.remove('hidden');
              stepResults.scrollIntoView({ behavior: 'smooth' });
            }, 600);
          } else if (event.type === 'error') {
            addLog(`Error: ${event.message}`, 'fail');
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

  // --- Results ---
  function renderResults() {
    const bps = [...new Set(screenshotResults.map(r => r.breakpoint))];
    const session = screenshotResults[0]?.file?.split('/')[2];
    if (session) {
      btnDownloadAll.href = `/api/download/${session}`;
      btnDownloadAll.classList.remove('hidden');
    }

    // Build tabs
    resultsTabs.innerHTML = '';
    const allBtn = makeTab('all', 'All');
    resultsTabs.appendChild(allBtn);
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
    results.forEach(r => {
      const card = document.createElement('div');
      card.className = 'result-card';
      card.innerHTML = `
        <div class="result-thumb">
          <img src="${r.file}" alt="${escHtml(r.label)} @ ${r.breakpoint}" loading="lazy" />
          <div class="thumb-overlay">🔍 View full size</div>
        </div>
        <div class="result-info">
          <div class="result-title">${escHtml(r.label)}</div>
          <div class="result-meta">
            <span class="result-bp ${r.breakpoint}">${r.breakpoint} · ${r.width}px</span>
            <a class="dl-link" href="${r.file}" download="${r.filename}">Download</a>
          </div>
        </div>
      `;
      card.querySelector('.result-thumb').addEventListener('click', () => openLightbox(r.file));
      resultsGrid.appendChild(card);
    });
  }

  // --- Lightbox ---
  function openLightbox(src) {
    const lb = document.createElement('div');
    lb.className = 'lightbox';
    lb.innerHTML = `
      <button class="lightbox-close">✕</button>
      <img src="${src}" alt="Screenshot" />
    `;
    lb.addEventListener('click', e => { if (e.target === lb) lb.remove(); });
    lb.querySelector('.lightbox-close').addEventListener('click', () => lb.remove());
    document.body.appendChild(lb);
  }

  // --- Start over ---
  document.getElementById('btn-new').addEventListener('click', () => {
    stepResults.classList.add('hidden');
    stepProgress.classList.add('hidden');
    stepOptions.classList.remove('hidden');
    stepPages.classList.remove('hidden');
    btnDownloadAll.classList.add('hidden');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  // Util
  function escHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }
})();
