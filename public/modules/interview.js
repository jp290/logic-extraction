import { renderMarkdown } from '../shared/markdown.js';

function getClientKey() {
  let key = localStorage.getItem('le-client-key');
  if (!key) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    key = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 8);
    localStorage.setItem('le-client-key', key);
  }
  return key;
}

function setClientKey(key) {
  localStorage.setItem('le-client-key', key);
}

function authHeaders() {
  return { 'Content-Type': 'application/json', 'X-Client-Key': getClientKey() };
}

const COV_LABELS = [
  { key: 'core_logic', label: 'Core' },
  { key: 'commitments', label: 'Commitments' },
  { key: 'evaluation', label: 'Evaluation' },
  { key: 'tensions', label: 'Tensions' },
];

function covLevel(score) {
  if (score >= 80) return 'ready';
  if (score >= 60) return 'high';
  if (score >= 30) return 'mid';
  return 'low';
}

export function renderInterview(root) {
  let interviewId = null;
  let enrichId = null;
  let sending = false;
  let coverage = { core_logic: 0, commitments: 0, evaluation: 0, tensions: 0 };
  let turn = 0;
  let pollTimer = null;

  const el = document.createElement('div');
  el.className = 'c-interview';
  root.appendChild(el);

  el.innerHTML = `
    <div class="c-interview__wrap">
      <div class="c-interview__header">
        <span class="c-interview__title">Interview</span>
        <div class="c-interview__actions">
          <div class="c-interview__coverage">
            ${COV_LABELS.map(c => `
              <div class="c-interview__cov-item" title="${c.label}">
                <span class="c-interview__cov-dot c-interview__cov-dot--low" data-cov="${c.key}"></span>
                <span>${c.label}</span>
              </div>
            `).join('')}
          </div>
        </div>
      </div>

      <div class="c-interview__log">
        <div class="c-interview__welcome">
          <div class="c-interview__welcome-icon">
            <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
              <circle cx="24" cy="24" r="20" stroke="var(--accent, #a78bfa)" stroke-width="1" opacity="0.25"/>
              <path d="M16 20c0-4.4 3.6-8 8-8s8 3.6 8 8" stroke="var(--accent, #a78bfa)" stroke-width="1.5" opacity="0.4" fill="none"/>
              <circle cx="24" cy="32" r="3" stroke="var(--accent, #a78bfa)" stroke-width="1.5" opacity="0.6" fill="none"/>
            </svg>
          </div>
          <h2 class="c-interview__welcome-title">Build a lens from conversation</h2>
          <p class="c-interview__welcome-text">
            No document needed. Share what you know deeply — how you cook, how you debug, how you make decisions — and we'll extract the reasoning DNA through conversation.
          </p>
          <button class="c-interview__start btn btn-primary">Start new lens</button>
          <div class="c-interview__grow" hidden>
            <span class="c-interview__grow-label">Or continue growing an existing lens</span>
            <select class="c-interview__grow-select"></select>
            <button class="c-interview__grow-btn btn btn-ghost">Continue</button>
          </div>
          <div class="c-interview__restore">
            <button class="c-interview__restore-toggle" style="background:none;border:none;color:var(--text-3);font-size:var(--fs-xs);cursor:pointer;text-decoration:underline">Have an existing key?</button>
            <div class="c-interview__restore-form" hidden style="display:flex;gap:var(--space-2);margin-top:var(--space-2)">
              <input class="c-interview__restore-input textarea" type="text" maxlength="8" placeholder="e.g. a7f3b2c1" style="width:120px;font-family:var(--font);font-size:var(--fs-sm);text-align:center">
              <button class="c-interview__restore-btn btn btn-ghost">Load</button>
            </div>
          </div>
        </div>
      </div>

      <div class="c-interview__synth-banner" hidden>
        <span class="c-interview__synth-text">Enough signal to generate a Logic Document.</span>
        <label class="c-interview__synth-public"><input type="checkbox" class="c-interview__public-check"> List in public library</label>
        <button class="c-interview__synth-btn btn btn-primary">Generate lens</button>
      </div>

      <div class="c-interview__synth-progress" hidden>
        <div class="c-interview__synth-spinner"></div>
        <span class="c-interview__synth-label">Synthesizing your Logic Document...</span>
      </div>

      <div class="c-interview__result" hidden>
        <h3 class="c-interview__result-title"></h3>
        <p class="c-interview__result-text">Your lens is ready. You can consult it from the Consult tab.</p>
        <div class="c-interview__result-key">
          <span class="c-interview__result-key-label">Your lens key</span>
          <code class="c-interview__result-key-value"></code>
          <button class="c-interview__result-key-copy btn btn-ghost" style="font-size:var(--fs-xs);padding:2px 8px">Copy</button>
        </div>
        <p class="c-interview__result-key-hint">Save this key to access or grow your lens from another device.</p>
        <div class="c-interview__result-actions" style="display:flex;gap:var(--space-2)">
          <button class="c-interview__result-consult btn btn-primary">Consult this lens</button>
          <button class="c-interview__result-new btn btn-ghost">Start another</button>
        </div>
      </div>

      <div class="c-interview__input-area" hidden>
        <textarea
          class="c-interview__textarea textarea"
          placeholder="Share your thinking..."
          rows="2"
        ></textarea>
        <button class="c-interview__send btn btn-primary" disabled>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="22" y1="2" x2="11" y2="13"></line>
            <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
          </svg>
          Send
        </button>
      </div>
    </div>
  `;

  const log = el.querySelector('.c-interview__log');
  const textarea = el.querySelector('.c-interview__textarea');
  const sendBtn = el.querySelector('.c-interview__send');
  const inputArea = el.querySelector('.c-interview__input-area');
  const startBtn = el.querySelector('.c-interview__start');
  const synthBanner = el.querySelector('.c-interview__synth-banner');
  const synthBtn = el.querySelector('.c-interview__synth-btn');
  const synthProgress = el.querySelector('.c-interview__synth-progress');
  const resultEl = el.querySelector('.c-interview__result');
  const growSection = el.querySelector('.c-interview__grow');
  const growSelect = el.querySelector('.c-interview__grow-select');
  const growBtn = el.querySelector('.c-interview__grow-btn');

  // Load user's own completed interviews for "continue growing"
  (async () => {
    try {
      const res = await fetch('/api/interviews', { headers: { 'X-Client-Key': getClientKey() } });
      const data = await res.json();
      const completed = (data.interviews || []).filter(i => i.status === 'complete' && i.extraction_id);
      if (completed.length > 0) {
        growSelect.innerHTML = completed.map(i =>
          `<option value="${i.extraction_id}">${i.extraction_title || i.extraction_id}</option>`
        ).join('');
        growSection.hidden = false;
      }
    } catch { /* non-critical */ }
  })();

  growBtn.addEventListener('click', () => {
    enrichId = growSelect.value;
    if (enrichId) startInterview();
  });

  const restoreToggle = el.querySelector('.c-interview__restore-toggle');
  const restoreForm = el.querySelector('.c-interview__restore-form');
  const restoreInput = el.querySelector('.c-interview__restore-input');
  const restoreBtn = el.querySelector('.c-interview__restore-btn');

  restoreToggle.addEventListener('click', () => {
    restoreForm.hidden = !restoreForm.hidden;
    if (!restoreForm.hidden) restoreInput.focus();
  });

  restoreBtn.addEventListener('click', async () => {
    const key = restoreInput.value.trim().toLowerCase();
    if (!/^[a-f0-9]{8}$/.test(key)) return;
    setClientKey(key);
    // Reload the grow section with the new key's lenses
    try {
      const res = await fetch('/api/interviews', { headers: { 'X-Client-Key': key } });
      const data = await res.json();
      const completed = (data.interviews || []).filter(i => i.status === 'complete' && i.extraction_id);
      if (completed.length > 0) {
        growSelect.innerHTML = completed.map(i =>
          `<option value="${i.extraction_id}">${i.extraction_title || i.extraction_id}</option>`
        ).join('');
        growSection.hidden = false;
        restoreForm.hidden = true;
        restoreToggle.textContent = 'Key loaded: ' + key;
      } else {
        restoreToggle.textContent = 'No lenses found for this key';
        setTimeout(() => { restoreToggle.textContent = 'Have an existing key?'; }, 3000);
      }
    } catch {
      restoreToggle.textContent = 'Failed to load';
      setTimeout(() => { restoreToggle.textContent = 'Have an existing key?'; }, 3000);
    }
  });

  function updateCoverage(cov) {
    coverage = cov;
    for (const c of COV_LABELS) {
      const dot = el.querySelector(`.c-interview__cov-dot[data-cov="${c.key}"]`);
      if (!dot) continue;
      const val = cov[c.key] || 0;
      dot.className = `c-interview__cov-dot c-interview__cov-dot--${covLevel(val)}`;
      dot.title = `${c.label}: ${val}%`;
    }
    const allReady = COV_LABELS.every(c => (cov[c.key] || 0) >= 60);
    const anySignal = turn >= 3;
    synthBanner.hidden = !(allReady || anySignal);
    const synthText = el.querySelector('.c-interview__synth-text');
    const synthBtnEl = el.querySelector('.c-interview__synth-btn');
    const synthPublic = el.querySelector('.c-interview__synth-public');
    if (synthPublic) synthPublic.hidden = !!enrichId;
    if (enrichId) {
      synthText.textContent = 'Ready to add this to your existing lens.';
      synthBtnEl.textContent = 'Update lens';
    } else {
      synthText.textContent = 'Enough signal to generate a Logic Document.';
      synthBtnEl.textContent = 'Generate lens';
    }
  }

  function appendMessage(role, content) {
    const msg = document.createElement('div');
    msg.className = `c-interview__msg c-interview__msg--${role}`;

    if (role === 'assistant') {
      const body = document.createElement('div');
      body.className = 'md-body';
      body.innerHTML = renderMarkdown(content);
      msg.appendChild(body);
    } else {
      msg.textContent = content;
    }

    const welcome = log.querySelector('.c-interview__welcome');
    if (welcome) welcome.remove();
    log.appendChild(msg);
    log.scrollTop = log.scrollHeight;
    return msg;
  }

  function updateSendState() {
    sendBtn.disabled = sending || !textarea.value.trim();
  }

  textarea.addEventListener('input', updateSendState);

  async function startInterview() {
    startBtn.disabled = true;
    startBtn.textContent = 'Starting...';

    try {
      const res = await fetch('/api/interview/start', {
        method: 'POST',
        headers: authHeaders(),
        body: '{}',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to start');

      interviewId = data.id;
      turn = 1;
      const welcome = log.querySelector('.c-interview__welcome');
      if (welcome) welcome.remove();
      appendMessage('assistant', data.message);
      updateCoverage(data.coverage || {});
      inputArea.hidden = false;
      textarea.focus();
    } catch (err) {
      startBtn.disabled = false;
      startBtn.textContent = 'Start new lens';
      appendMessage('error', err.message || 'Failed to start interview.');
    }
  }

  startBtn.addEventListener('click', startInterview);

  async function send() {
    const message = textarea.value.trim();
    if (!message || !interviewId || sending) return;

    sending = true;
    textarea.value = '';
    updateSendState();
    textarea.disabled = true;

    appendMessage('user', message);
    const thinkingEl = appendMessage('thinking', 'Thinking...');

    try {
      const res = await fetch('/api/interview/message', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ id: interviewId, message }),
      });
      const data = await res.json();
      thinkingEl.remove();

      if (!res.ok) {
        appendMessage('error', data.error || 'Failed to get response.');
      } else {
        appendMessage('assistant', data.message);
        turn = data.turn || turn + 1;
        updateCoverage(data.coverage || coverage);
      }
    } catch {
      thinkingEl.remove();
      appendMessage('error', 'Network error — please try again.');
    } finally {
      sending = false;
      textarea.disabled = false;
      updateSendState();
      textarea.focus();
    }
  }

  sendBtn.addEventListener('click', send);
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      send();
    }
  });

  async function synthesize() {
    synthBanner.hidden = true;
    inputArea.hidden = true;
    synthProgress.hidden = false;

    try {
      const synthBody = { id: interviewId };
      if (enrichId) {
        synthBody.enrich_id = enrichId;
      } else {
        const publicCheck = el.querySelector('.c-interview__public-check');
        synthBody.is_public = !!(publicCheck && publicCheck.checked);
      }
      const res = await fetch('/api/interview/synthesize', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(synthBody),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to start synthesis');

      pollForCompletion();
    } catch (err) {
      synthProgress.hidden = true;
      inputArea.hidden = false;
      synthBanner.hidden = false;
      appendMessage('error', err.message || 'Synthesis failed.');
    }
  }

  const PHASE_LABELS = {
    'phase4': 'Extracting domain knowledge...',
    'phase5': 'Verifying knowledge against conversation...',
    'phase6': 'Synthesizing understanding...',
  };

  function pollForCompletion() {
    const synthLabel = el.querySelector('.c-interview__synth-label');
    let resultWired = false;

    pollTimer = setInterval(async () => {
      try {
        const res = await fetch(`/api/interview/status/${interviewId}`, { headers: { 'X-Client-Key': getClientKey() } });
        const data = await res.json();

        if (data.phase && PHASE_LABELS[data.phase]) {
          synthLabel.textContent = PHASE_LABELS[data.phase];
        }

        if (data.status === 'complete') {
          clearInterval(pollTimer);
          synthProgress.hidden = true;
          log.hidden = true;
          resultEl.hidden = false;

          if (data.extraction_id && !resultWired) {
            resultWired = true;
            const titleRes = await fetch('/api/extractions/titles');
            const titleData = await titleRes.json();
            const lens = (titleData.extractions || titleData).find(l => l.id === data.extraction_id);
            el.querySelector('.c-interview__result-title').textContent = lens?.title || 'Your Logic Document';
            const keyVal = el.querySelector('.c-interview__result-key-value');
            keyVal.textContent = getClientKey();
            el.querySelector('.c-interview__result-key-copy').addEventListener('click', () => {
              navigator.clipboard.writeText(getClientKey());
              el.querySelector('.c-interview__result-key-copy').textContent = 'Copied';
              setTimeout(() => { el.querySelector('.c-interview__result-key-copy').textContent = 'Copy'; }, 2000);
            });

            el.querySelector('.c-interview__result-consult').addEventListener('click', () => {
              const { selectLens } = window.__interviewStore || {};
              if (selectLens) selectLens(data.extraction_id);
              location.hash = 'consult';
            });
          }
        } else if (data.status === 'failed') {
          clearInterval(pollTimer);
          synthProgress.hidden = true;
          inputArea.hidden = false;
          appendMessage('error', `Synthesis failed: ${data.error || 'Unknown error'}`);
        }
      } catch { /* retry on next tick */ }
    }, 3000);
  }

  synthBtn.addEventListener('click', synthesize);

  el.querySelector('.c-interview__result-new').addEventListener('click', () => {
    interviewId = null;
    enrichId = null;
    turn = 0;
    coverage = { core_logic: 0, commitments: 0, evaluation: 0, tensions: 0 };
    log.innerHTML = '';
    log.hidden = false;
    resultEl.hidden = true;
    synthBanner.hidden = true;
    inputArea.hidden = true;
    updateCoverage(coverage);

    const welcome = document.createElement('div');
    welcome.className = 'c-interview__welcome';
    welcome.innerHTML = `
      <div class="c-interview__welcome-icon">
        <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
          <circle cx="24" cy="24" r="20" stroke="var(--accent, #a78bfa)" stroke-width="1" opacity="0.25"/>
          <path d="M16 20c0-4.4 3.6-8 8-8s8 3.6 8 8" stroke="var(--accent, #a78bfa)" stroke-width="1.5" opacity="0.4" fill="none"/>
          <circle cx="24" cy="32" r="3" stroke="var(--accent, #a78bfa)" stroke-width="1.5" opacity="0.6" fill="none"/>
        </svg>
      </div>
      <h2 class="c-interview__welcome-title">Build a lens from conversation</h2>
      <p class="c-interview__welcome-text">
        No document needed. Share what you know deeply — how you cook, how you debug, how you make decisions — and we'll extract the reasoning DNA through conversation.
      </p>
      <button class="c-interview__start btn btn-primary">Start new lens</button>
    `;
    log.appendChild(welcome);
    welcome.querySelector('.c-interview__start').addEventListener('click', startInterview);
  });

  return function teardown() {
    if (pollTimer) clearInterval(pollTimer);
    el.remove();
  };
}
