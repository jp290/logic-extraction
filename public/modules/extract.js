import { renderMarkdown } from '../shared/markdown.js';
import { store, emit, selectLens } from '../store.js';

const MAX_WORDS = 400_000;
const MAX_POLL_MS = 15 * 60 * 1000;
const POLL_INTERVAL = 2000;

const PHASES_FULL = [
  { id: 'phase1', title: 'Three Agents Extract', detail: 'Reasoning patterns, deep commitments, dialectical tensions' },
  { id: 'phase2', title: 'Verifier Challenges', detail: 'Tests every finding across 11 dimensions' },
  { id: 'phase3', title: 'Synthesis + Profiling', detail: 'Crystallizes findings into a Logic Document' },
  { id: 'phase4', title: 'Knowledge Agents', detail: 'Extracts concrete domain knowledge' },
  { id: 'phase5', title: 'Connection Mapping', detail: 'Maps links between reasoning and knowledge' },
  { id: 'phase6', title: 'Understanding Synthesis', detail: 'Integrates into a verified Understanding Document' },
];

const PHASES_LOGIC = PHASES_FULL.slice(0, 3);

export function renderExtract(root) {
  let pollTimer = null;
  let pollStart = 0;
  let currentText = '';
  let currentMode = 'understanding';
  let view = 'upload'; // 'upload' | 'processing' | 'result'
  let resultData = null;
  let activeLayer = 'understanding';

  const el = document.createElement('div');
  el.className = 'c-extract';
  root.appendChild(el);

  renderUpload();

  function renderUpload() {
    view = 'upload';
    el.innerHTML = `
      <div class="c-extract__wrap">
        <div class="c-extract__hero">
          <h1 class="c-extract__hero-title">Extract a Lens</h1>
          <p class="c-extract__hero-subtitle">Upload a manual, protocol, or framework — we'll extract the reasoning it contains into a lens any AI can use.</p>
        </div>

        <div class="c-extract__card">
          <div class="c-extract__dropzone" tabindex="0" role="button" aria-label="Upload PDF or text file">
            <div class="c-extract__dropzone-ring">
              <svg class="c-extract__dropzone-icon" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                <polyline points="14 2 14 8 20 8"></polyline>
                <line x1="12" y1="18" x2="12" y2="12"></line>
                <line x1="9" y1="15" x2="12" y2="12"></line>
                <line x1="15" y1="15" x2="12" y2="12"></line>
              </svg>
            </div>
            <p class="c-extract__dropzone-text">Drop a PDF here or <span class="c-extract__browse">browse</span></p>
            <p class="c-extract__dropzone-hint">PDF converted in your browser — the file never leaves your device. The extracted text is then sent to the server for processing, and the resulting lens stays unlisted unless you choose to list it in the public library.</p>
            <input type="file" class="c-extract__file-input" accept=".pdf,.txt" hidden>
          </div>

          <div class="c-extract__divider"><span>or paste text directly</span></div>

          <textarea class="c-extract__textarea textarea" placeholder="Paste your document text here..." rows="6"></textarea>

          <input type="text" class="c-extract__title input" placeholder="Document title (optional)">

          <div class="c-extract__stats" hidden>
            <span class="c-extract__word-count"></span>
            <span class="c-extract__char-count"></span>
          </div>
        </div>

        <div class="c-extract__options">
          <label class="c-extract__mode-toggle">
            <input type="checkbox" class="c-extract__mode-check">
            <span>Quick mode — logic only (3 phases instead of 6)</span>
          </label>
          <label class="c-extract__mode-toggle">
            <input type="checkbox" class="c-extract__public-check">
            <span>List in public library</span>
          </label>
        </div>

        <button class="c-extract__submit btn btn-primary" disabled>
          <span class="c-extract__submit-text">Start Extraction</span>
          <span class="c-extract__submit-spinner spinner" hidden></span>
        </button>

        <div class="c-extract__error" hidden></div>
      </div>
    `;

    const dropzone = el.querySelector('.c-extract__dropzone');
    const fileInput = el.querySelector('.c-extract__file-input');
    const textarea = el.querySelector('.c-extract__textarea');
    const titleInput = el.querySelector('.c-extract__title');
    const stats = el.querySelector('.c-extract__stats');
    const wordCount = el.querySelector('.c-extract__word-count');
    const charCount = el.querySelector('.c-extract__char-count');
    const modeCheck = el.querySelector('.c-extract__mode-check');
    const publicCheck = el.querySelector('.c-extract__public-check');
    const submitBtn = el.querySelector('.c-extract__submit');
    const submitText = el.querySelector('.c-extract__submit-text');
    const submitSpinner = el.querySelector('.c-extract__submit-spinner');

    dropzone.addEventListener('click', () => fileInput.click());
    dropzone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
    });
    dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('c-extract__dropzone--dragover'); });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('c-extract__dropzone--dragover'));
    dropzone.addEventListener('drop', async (e) => {
      e.preventDefault();
      dropzone.classList.remove('c-extract__dropzone--dragover');
      if (e.dataTransfer.files[0]) await handleFile(e.dataTransfer.files[0]);
    });
    fileInput.addEventListener('change', async () => {
      if (fileInput.files[0]) await handleFile(fileInput.files[0]);
    });

    async function handleFile(file) {
      const dropText = el.querySelector('.c-extract__dropzone-text');
      if (file.type === 'application/pdf') {
        dropText.textContent = 'Extracting text from PDF...';
        try {
          const text = await extractPDF(file);
          textarea.value = text;
          updateStats();
          dropText.textContent = `Loaded: ${file.name}`;
          if (!titleInput.value) titleInput.value = file.name.replace(/\.pdf$/i, '');
        } catch (err) {
          showError('Failed to extract PDF text: ' + err.message);
          dropText.innerHTML = 'Drop a PDF here or <span class="c-extract__browse">browse</span>';
        }
      } else if (file.type === 'text/plain' || file.name.endsWith('.txt')) {
        textarea.value = await file.text();
        updateStats();
        dropText.textContent = `Loaded: ${file.name}`;
        if (!titleInput.value) titleInput.value = file.name.replace(/\.txt$/i, '');
      } else {
        showError('Please upload a PDF or text file');
      }
    }

    textarea.addEventListener('input', updateStats);
    modeCheck.addEventListener('change', () => {
      currentMode = modeCheck.checked ? 'logic' : 'understanding';
    });

    function updateStats() {
      const text = textarea.value.trim();
      currentText = text;
      const words = text ? text.split(/\s+/).filter(Boolean).length : 0;
      const chars = text.length;
      const over = words > MAX_WORDS;

      wordCount.textContent = `${words.toLocaleString()} / ${MAX_WORDS.toLocaleString()} words`;
      wordCount.style.color = over ? 'var(--danger)' : '';
      charCount.textContent = `${chars.toLocaleString()} characters`;
      stats.hidden = !text;
      submitBtn.disabled = words < 20 || over;
    }

    submitBtn.addEventListener('click', async () => {
      if (!currentText || submitBtn.disabled) return;
      submitBtn.disabled = true;
      submitText.textContent = 'Submitting...';
      submitSpinner.hidden = false;
      hideError();

      try {
        const res = await fetch('/api/extract', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: currentText,
            title: titleInput.value.trim() || undefined,
            mode: currentMode,
            is_public: publicCheck.checked,
          }),
        });
        const data = await res.json();
        if (!res.ok) { showError(data.error || 'Extraction failed'); return; }
        renderProcessing(data.id, currentMode);
      } catch (err) {
        showError('Network error: ' + err.message);
      } finally {
        submitText.textContent = 'Start Analysis';
        submitSpinner.hidden = true;
        submitBtn.disabled = false;
      }
    });
  }

  function renderProcessing(id, mode) {
    view = 'processing';
    const phases = mode === 'logic' ? PHASES_LOGIC : PHASES_FULL;

    el.innerHTML = `
      <div class="c-extract__wrap">
        <div class="c-extract__hero">
          <h1 class="c-extract__hero-title">Extracting Lens</h1>
          <p class="c-extract__hero-subtitle">Multiple agents are analyzing your document in parallel.</p>
        </div>
        <div class="c-extract__card">
          <div class="c-extract__phases">
            ${phases.map((p, i) => `
              <div class="c-extract__phase ${i === 0 ? 'c-extract__phase--active' : ''}" data-phase="${p.id}">
                <div class="c-extract__phase-dot"></div>
                <div class="c-extract__phase-body">
                  <div class="c-extract__phase-title">${p.title}</div>
                  <div class="c-extract__phase-detail">${p.detail}</div>
                  <div class="c-extract__phase-status">${i === 0 ? 'In progress' : ''}</div>
                </div>
              </div>
            `).join('')}
          </div>
          <p class="c-extract__estimate"></p>
        </div>
        <div class="c-extract__error" hidden></div>
      </div>
    `;

    const words = currentText.split(/\s+/).filter(Boolean).length;
    const estMin = words < 10000 ? 2 : words < 50000 ? 3 : 4;
    el.querySelector('.c-extract__estimate').textContent = `Estimated time: ${estMin}-${estMin + 2} minutes`;

    startPolling(id, phases);
  }

  function startPolling(id, phases) {
    stopPolling();
    pollStart = Date.now();
    const phaseIds = phases.map(p => p.id);

    pollTimer = setInterval(async () => {
      if (Date.now() - pollStart > MAX_POLL_MS) {
        stopPolling();
        showError('Extraction timed out — please try again');
        return;
      }

      try {
        const res = await fetch(`/api/extractions/${id}`);
        const data = await res.json();
        updatePhases(data.status, phaseIds);

        if (data.status === 'complete') {
          stopPolling();
          emit('lens-created', { id });
          renderResult(data);
        } else if (data.status === 'failed') {
          stopPolling();
          showError('Extraction failed. Please try again.');
        }
      } catch {
        // network hiccup, keep polling
      }
    }, POLL_INTERVAL);
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function updatePhases(status, phaseIds) {
    const currentIdx = phaseIds.indexOf(status);
    el.querySelectorAll('.c-extract__phase').forEach(phaseEl => {
      const pid = phaseEl.dataset.phase;
      const idx = phaseIds.indexOf(pid);
      const statusEl = phaseEl.querySelector('.c-extract__phase-status');

      phaseEl.classList.remove('c-extract__phase--active', 'c-extract__phase--done');
      if (idx < currentIdx) {
        phaseEl.classList.add('c-extract__phase--done');
        statusEl.textContent = 'Complete';
      } else if (idx === currentIdx) {
        phaseEl.classList.add('c-extract__phase--active');
        statusEl.textContent = 'In progress';
      } else {
        statusEl.textContent = '';
      }
    });
  }

  function renderResult(data) {
    view = 'result';
    resultData = data;
    activeLayer = data.understanding_document ? 'understanding' : 'logic';

    const layers = [
      { id: 'logic', label: 'Logic Document', hint: 'HOW it thinks' },
      { id: 'knowledge', label: 'Knowledge Extract', hint: 'WHAT it knows' },
      { id: 'understanding', label: 'Understanding Document', hint: 'WHY it matters' },
    ];

    el.innerHTML = `
      <div class="c-extract__wrap">
        <div class="c-extract__result-header">
          <h2 class="c-extract__result-title">${escapeHTML(data.title || 'Untitled')}</h2>
          <div class="c-extract__result-meta">
            <span>${new Date(data.created_at.endsWith('Z') ? data.created_at : data.created_at + 'Z').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}</span>
            <span>${(data.word_count || 0).toLocaleString()} words</span>
          </div>
        </div>

        <div class="c-extract__tabs" role="tablist">
          ${layers.map(l => `
            <button class="c-extract__tab ${l.id === activeLayer ? 'c-extract__tab--active' : ''}"
                    role="tab" aria-selected="${l.id === activeLayer}" data-layer="${l.id}">
              ${l.label}
              <span class="c-extract__tab-hint">${l.hint}</span>
            </button>
          `).join('')}
        </div>

        <div class="c-extract__panels">
          ${layers.map(l => `
            <div class="c-extract__panel ${l.id === activeLayer ? '' : 'c-extract__panel--hidden'}" data-layer="${l.id}">
              <div class="c-extract__panel-actions">
                <button class="c-extract__download btn btn-ghost" data-layer="${l.id}">↓ Download</button>
              </div>
              <div class="c-extract__content md-body"></div>
            </div>
          `).join('')}
        </div>

        <div class="c-extract__result-actions">
          <button class="c-extract__consult btn btn-primary">Consult this lens →</button>
          <button class="c-extract__back btn btn-ghost">New Extraction</button>
        </div>
      </div>
    `;

    populatePanel('logic', data.logic_document);
    populatePanel('knowledge', data.knowledge_extract);
    populatePanel('understanding', data.understanding_document);

    el.querySelectorAll('.c-extract__tab').forEach(tab => {
      tab.addEventListener('click', () => switchLayer(tab.dataset.layer));
    });

    el.querySelectorAll('.c-extract__download').forEach(btn => {
      btn.addEventListener('click', () => downloadLayer(btn.dataset.layer));
    });

    el.querySelector('.c-extract__consult').addEventListener('click', () => {
      selectLens(data.id);
      window.navigate('consult');
    });
    el.querySelector('.c-extract__back').addEventListener('click', () => renderUpload());
  }

  function populatePanel(layer, content) {
    const panel = el.querySelector(`.c-extract__panel[data-layer="${layer}"]`);
    const contentEl = panel.querySelector('.c-extract__content');
    if (content) {
      contentEl.innerHTML = renderMarkdown(content);
    } else {
      const names = { logic: 'Logic Document', knowledge: 'Knowledge Extract', understanding: 'Understanding Document' };
      contentEl.innerHTML = `<p class="c-extract__empty">No ${names[layer]} — this extraction used logic-only mode.</p>`;
    }
  }

  function switchLayer(layer) {
    activeLayer = layer;
    el.querySelectorAll('.c-extract__tab').forEach(t => {
      const active = t.dataset.layer === layer;
      t.classList.toggle('c-extract__tab--active', active);
      t.setAttribute('aria-selected', active);
    });
    el.querySelectorAll('.c-extract__panel').forEach(p => {
      p.classList.toggle('c-extract__panel--hidden', p.dataset.layer !== layer);
    });
  }

  function downloadLayer(layer) {
    if (!resultData) return;
    const map = { logic: 'logic_document', knowledge: 'knowledge_extract', understanding: 'understanding_document' };
    const content = resultData[map[layer]];
    if (!content) return;

    const blob = new Blob([content], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${resultData.title || 'extraction'}-${layer}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function showError(msg) {
    const errEl = el.querySelector('.c-extract__error');
    if (errEl) { errEl.textContent = msg; errEl.hidden = false; }
  }

  function hideError() {
    const errEl = el.querySelector('.c-extract__error');
    if (errEl) errEl.hidden = true;
  }

  return function teardown() {
    stopPolling();
  };
}

async function extractPDF(file) {
  const arrayBuffer = await file.arrayBuffer();
  const pdfjsLib = globalThis.pdfjsLib;
  if (!pdfjsLib) throw new Error('pdf.js not loaded yet — please wait a moment and try again');
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs';

  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    pages.push(content.items.map(item => item.str).join(' '));
  }
  return pages.join('\n\n');
}

function escapeHTML(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}
