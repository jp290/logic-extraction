import { renderMarkdown } from '../shared/markdown.js';
import { store, on, loadLenses, selectLens, loadPacks, selectPack } from '../store.js';

function domainOf(lensId) {
  const lens = store.lenses.find(l => l.id === lensId);
  if (!lens) return '';
  const tags = lens.domain_tags;
  const parsed = typeof tags === 'string' ? (function() { try { return JSON.parse(tags); } catch { return []; } })() : (Array.isArray(tags) ? tags : []);
  return parsed[0] || '';
}

const DEPTH_OPTIONS = [
  { label: 'Logic', value: 'ld', warn: 'Logic only: sharp reasoning, but without the knowledge layer it can state facts the lens doesn\'t carry. Use Full when factual accuracy matters.' },
  { label: 'Understanding', value: 'ud' },
  { label: 'Logic + Understanding', value: 'ld+ud' },
  { label: 'Full', value: 'ld+ke+ud' },
];

const STYLE_OPTIONS = [
  { label: 'Natural', value: 'v3', desc: 'Reasons like an expert who has deeply internalized the framework' },
  { label: 'Analytical', value: 'v1', desc: 'Explores the framework methodically, showing its reasoning step by step' },
  { label: 'Structured', value: 'v2', desc: 'Minimal, clinical responses organized by the framework\'s layers' },
];

const DEFAULT_DEPTH = 'ld+ke+ud';
const DEFAULT_STYLE = 'v3';

export function renderConsult(root, deepLink) {
  let depth = DEFAULT_DEPTH;
  let style = DEFAULT_STYLE;
  let sending = false;
  let history = [];
  const unsubs = [];

  const el = document.createElement('div');
  el.className = 'c-consult';
  root.appendChild(el);

  el.innerHTML = `
    <div class="c-consult__wrap">
      <div class="c-consult__header">
        <select id="consult-lens" class="c-consult__select"></select>
        <select id="consult-pack" class="c-consult__select" title="Grounding pack — measured process data injected into the consult"></select>
        <label class="c-consult__reasoning" title="Pro reasoning model: solves pack equations correctly. Slower and costlier than the default.">
          <input type="checkbox" id="consult-reasoning"> Reasoning consult
        </label>
        <button class="c-consult__new btn btn-ghost" type="button">New conversation</button>
        <div class="c-consult__settings">
          <div class="c-consult__pills" role="radiogroup" aria-label="Context depth">
            ${DEPTH_OPTIONS.map(o => `
              <button
                class="c-consult__pill${o.value === DEFAULT_DEPTH ? ' c-consult__pill--active' : ''}"
                data-depth="${o.value}"
                role="radio"
                aria-checked="${o.value === DEFAULT_DEPTH}"
              >${o.label}</button>
            `).join('')}
          </div>
          <div class="c-consult__pills c-consult__style-pills" role="radiogroup" aria-label="Response style">
            ${STYLE_OPTIONS.map(o => `
              <button
                class="c-consult__pill${o.value === DEFAULT_STYLE ? ' c-consult__pill--active' : ''}"
                data-style="${o.value}"
                role="radio"
                aria-checked="${o.value === DEFAULT_STYLE}"
              >${o.label}</button>
            `).join('')}
          </div>
        </div>
        <div class="c-consult__style-desc">${STYLE_OPTIONS.find(o => o.value === DEFAULT_STYLE).desc}</div>
        <div class="c-consult__depth-warn" hidden></div>
      </div>

      <div class="c-consult__log" aria-live="polite" aria-label="Conversation">
        <div class="c-consult__welcome">
          <div class="c-consult__welcome-icon">
            <svg width="48" height="48" viewBox="0 0 48 48" fill="none"><circle cx="24" cy="24" r="20" stroke="var(--domain)" stroke-width="1" opacity="0.25"/><circle cx="24" cy="24" r="12" stroke="var(--domain)" stroke-width="1" opacity="0.4"/><circle cx="24" cy="24" r="4" stroke="var(--domain)" stroke-width="1.5" opacity="0.6"/></svg>
          </div>
          <p class="c-consult__welcome-text">Select a lens to begin.<br>The AI will reason through that lens's framework.</p>
        </div>
      </div>

      <div class="c-consult__input-area">
        <textarea
          class="c-consult__textarea textarea"
          placeholder="Ask this lens a question..."
          rows="2"
        ></textarea>
        <button class="c-consult__send btn btn-primary" disabled>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="22" y1="2" x2="11" y2="13"></line>
            <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
          </svg>
          Send
        </button>
      </div>
    </div>
  `;

  const select = el.querySelector('#consult-lens');
  const packSelect = el.querySelector('#consult-pack');
  const reasoningCheck = el.querySelector('#consult-reasoning');
  const newBtn = el.querySelector('.c-consult__new');
  const pills = el.querySelector('.c-consult__pills');
  const log = el.querySelector('.c-consult__log');
  const textarea = el.querySelector('.c-consult__textarea');
  const sendBtn = el.querySelector('.c-consult__send');

  // --- Lens dropdown ---

  function populateSelect() {
    const packOnly = !!packSelect.value;
    select.innerHTML = store.lenses.length === 0
      ? '<option value="">Loading lenses...</option>'
      : (packOnly ? '<option value="">No lens — pack only</option>' : '') + store.lenses.map(l =>
          `<option value="${escapeHtml(l.id)}"${l.id === store.currentLensId ? ' selected' : ''}>${escapeHtml(l.title || l.id)}</option>`
        ).join('');
    updateSendState();
  }

  function populatePackSelect() {
    packSelect.innerHTML = '<option value="">No grounding pack</option>' + store.packs.map(p =>
      `<option value="${escapeHtml(p.id)}"${p.id === store.currentPackId ? ' selected' : ''}>📊 ${escapeHtml(p.title)}</option>`
    ).join('');
    if (store.currentPackId && packSelect.value === store.currentPackId) {
      reasoningCheck.checked = true;
    }
    updateSendState();
  }

  if (store.lenses.length === 0) loadLenses();
  loadPacks();
  populateSelect();
  populatePackSelect();

  unsubs.push(on('packs-loaded', () => {
    populatePackSelect();
    populateSelect();
  }));

  packSelect.addEventListener('change', () => {
    selectPack(packSelect.value);
    // Pro reasoning defaults ON with a pack: the default model is the measured
    // fabricated-arithmetic failure mode on pack equations. User can still untick.
    reasoningCheck.checked = !!packSelect.value;
    populateSelect();
    updateSendState();
  });

  function updateDomain(id) {
    el.dataset.domain = domainOf(id);
  }

  function showLensHero(id) {
    const lens = store.lenses.find(l => l.id === id);
    if (!lens) return;
    const welcome = log.querySelector('.c-consult__welcome');
    if (welcome) welcome.remove();

    if (log.querySelector('.c-consult__msg')) return;

    const tags = (function() { try { return JSON.parse(lens.domain_tags); } catch { return []; } })();
    const summary = lens.topic_summary || '';
    const suggestions = [
      `What are the key principles in this framework?`,
      `How would this lens approach a problem I'm facing?`,
      `What makes this reasoning different from generic advice?`,
    ];

    const hero = document.createElement('div');
    hero.className = 'c-consult__lens-hero';
    hero.innerHTML = `
      <h2 class="c-consult__hero-title">${escapeHtml(lens.title || 'Untitled')}</h2>
      ${summary ? `<p class="c-consult__hero-summary">${escapeHtml(summary.length > 200 ? summary.slice(0, 200) + '…' : summary)}</p>` : ''}
      ${tags.length ? `<div class="c-consult__hero-tags">${tags.slice(0, 4).map(t => `<span class="c-consult__hero-tag">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
      <div class="c-consult__suggestions">
        <span class="c-consult__suggestions-label">Try asking</span>
        ${suggestions.map(s => `<button class="c-consult__suggestion">${escapeHtml(s)}</button>`).join('')}
      </div>
    `;
    log.appendChild(hero);

    hero.querySelectorAll('.c-consult__suggestion').forEach(btn => {
      btn.addEventListener('click', () => {
        textarea.value = btn.textContent;
        updateSendState();
        textarea.focus();
      });
    });
  }

  if (store.lenses.length) {
    const activeId = store.currentLensId || select.value;
    if (activeId) {
      if (!store.currentLensId) selectLens(activeId);
      updateDomain(activeId);
      const welcome = log.querySelector('.c-consult__welcome');
      if (welcome) welcome.remove();
      showLensHero(activeId);
    }
  } else if (store.currentLensId) {
    updateDomain(store.currentLensId);
  }

  unsubs.push(on('lenses-loaded', () => {
    populateSelect();
    const activeId = store.currentLensId || select.value;
    if (activeId) {
      if (!store.currentLensId) selectLens(activeId);
      updateDomain(activeId);
      const welcome = log.querySelector('.c-consult__welcome');
      if (welcome) welcome.remove();
      if (!log.querySelector('.c-consult__msg') && !log.querySelector('.c-consult__lens-hero')) {
        showLensHero(activeId);
      }
    }
  }));

  select.addEventListener('change', () => {
    selectLens(select.value);
  });

  unsubs.push(on('lens-selected', (id) => {
    if (select.value !== id) select.value = id;
    history = [];
    log.querySelectorAll('.c-consult__msg').forEach(m => m.remove());
    const welcome = log.querySelector('.c-consult__welcome');
    if (welcome) welcome.remove();
    const oldHero = log.querySelector('.c-consult__lens-hero');
    if (oldHero) oldHero.remove();
    updateDomain(id);
    if (id && store.lenses.length) showLensHero(id);
  }));

  newBtn.addEventListener('click', () => {
    history = [];
    log.querySelectorAll('.c-consult__msg').forEach(m => m.remove());
    const oldHero = log.querySelector('.c-consult__lens-hero');
    if (oldHero) oldHero.remove();
    if (select.value && store.lenses.length) showLensHero(select.value);
    textarea.focus();
  });

  // --- Depth pills ---

  const depthWarn = el.querySelector('.c-consult__depth-warn');
  pills.addEventListener('click', (e) => {
    const pill = e.target.closest('.c-consult__pill');
    if (!pill) return;
    depth = pill.dataset.depth;
    for (const p of pills.querySelectorAll('.c-consult__pill')) {
      const active = p === pill;
      p.classList.toggle('c-consult__pill--active', active);
      p.setAttribute('aria-checked', String(active));
    }
    const opt = DEPTH_OPTIONS.find(o => o.value === depth);
    depthWarn.hidden = !opt?.warn;
    depthWarn.textContent = opt?.warn || '';
  });

  // --- Style pills ---

  const stylePills = el.querySelector('.c-consult__style-pills');
  const styleDesc = el.querySelector('.c-consult__style-desc');
  stylePills.addEventListener('click', (e) => {
    const pill = e.target.closest('.c-consult__pill');
    if (!pill) return;
    style = pill.dataset.style;
    for (const p of stylePills.querySelectorAll('.c-consult__pill')) {
      const active = p === pill;
      p.classList.toggle('c-consult__pill--active', active);
      p.setAttribute('aria-checked', String(active));
    }
    const opt = STYLE_OPTIONS.find(o => o.value === style);
    if (opt && styleDesc) styleDesc.textContent = opt.desc;
  });

  // --- Send state ---

  function updateSendState() {
    sendBtn.disabled = sending || !textarea.value.trim() || (!select.value && !packSelect.value);
  }

  textarea.addEventListener('input', updateSendState);

  // --- Send question ---

  async function send() {
    const question = textarea.value.trim();
    const extractionId = select.value;
    const packId = packSelect.value;
    if (!question || (!extractionId && !packId) || sending) return;

    sending = true;
    textarea.value = '';
    updateSendState();
    textarea.disabled = true;

    appendMessage('question', question);
    const thinkingEl = appendMessage('thinking', 'Reasoning...');

    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(extractionId ? { extraction_id: extractionId } : {}),
          ...(packId ? { pack_id: packId } : {}),
          reasoning: reasoningCheck.checked,
          question,
          context: depth,
          style,
          history,
        }),
      });

      const data = await res.json();
      thinkingEl.remove();

      if (!res.ok) {
        appendMessage('error', data.error || 'Failed to get an answer.');
      } else {
        const answerEl = appendMessage('answer', data.answer);
        if (data.model) {
          const prov = document.createElement('div');
          prov.className = 'c-consult__model';
          prov.textContent = data.model;
          prov.title = 'Model that produced this answer (recorded for provenance)';
          answerEl.appendChild(prov);
        }
        if (data.recheck) {
          answerEl.appendChild(renderRecheckBadge(data.recheck));
        }
        if (data.grounding) {
          answerEl.appendChild(renderGroundingBadge(data.grounding));
        }
        history.push({ role: 'user', content: question });
        history.push({ role: 'assistant', content: data.answer });
        if (history.length > 20) history = history.slice(-20);
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

  // --- Re-check badge ---

  const RECHECK_TITLE =
    "Deterministic re-check of numeric claims against the pack's stored artifacts. " +
    "Covers numeric artifact-derived claims only; prose misattribution is not gated.";

  function renderRecheckBadge(recheck) {
    const flags = recheck.flags || 0;
    const checked = recheck.checked || 0;
    const wrap = document.createElement('div');
    wrap.className = 'c-consult__recheck';
    wrap.title = RECHECK_TITLE;

    const badge = document.createElement('button');
    badge.type = 'button';
    if (flags > 0) {
      badge.className = 'c-consult__recheck-badge c-consult__recheck-badge--alert';
      badge.textContent = `⚠ ${flags} of ${checked} numeric claims failed re-check`;
    } else if (checked > 0) {
      badge.className = 'c-consult__recheck-badge c-consult__recheck-badge--ok';
      badge.textContent = `✓ ${checked} numeric claims re-checked`;
    } else {
      badge.className = 'c-consult__recheck-badge c-consult__recheck-badge--muted';
      badge.textContent = '– no numeric claims to re-check';
    }
    wrap.appendChild(badge);

    const claims = Array.isArray(recheck.claims) ? recheck.claims : [];
    if (claims.length > 0) {
      const list = document.createElement('div');
      list.className = 'c-consult__recheck-list';
      list.hidden = true;
      for (const c of claims) {
        const item = document.createElement('div');
        item.className = `c-consult__recheck-claim c-consult__recheck-claim--${c.verdict === 'flag' ? 'flag' : 'pass'}`;
        const icon = document.createElement('span');
        icon.className = 'c-consult__recheck-icon';
        icon.textContent = c.verdict === 'flag' ? '⚠' : '✓';
        const text = document.createElement('div');
        text.className = 'c-consult__recheck-text';
        const claimLine = document.createElement('div');
        claimLine.className = 'c-consult__recheck-excerpt';
        claimLine.textContent = c.claim;
        const recLine = document.createElement('div');
        recLine.className = 'c-consult__recheck-recomputed';
        recLine.textContent = c.recomputed;
        text.appendChild(claimLine);
        text.appendChild(recLine);
        item.appendChild(icon);
        item.appendChild(text);
        list.appendChild(item);
      }
      badge.addEventListener('click', () => {
        list.hidden = !list.hidden;
      });
      wrap.appendChild(list);
    } else {
      badge.classList.add('c-consult__recheck-badge--static');
    }
    return wrap;
  }

  // --- Source-grounding badge (lens-only consults) ---

  const GROUNDING_TITLE =
    'Deterministic check of named entities, citations, URLs and numbers in this answer ' +
    'against the source document the lens was extracted from. Covers entity/numeric ' +
    'provenance only; prose claims are not gated.';

  function renderGroundingBadge(grounding) {
    const flags = Array.isArray(grounding.flags) ? grounding.flags : [];
    const checked = grounding.checked || 0;
    const wrap = document.createElement('div');
    wrap.className = 'c-consult__recheck';
    wrap.title = GROUNDING_TITLE;

    const badge = document.createElement('button');
    badge.type = 'button';
    if (flags.length > 0) {
      badge.className = 'c-consult__recheck-badge c-consult__recheck-badge--alert';
      badge.textContent = `⚠ ${flags.length} of ${checked} checked items not found in the source document`;
    } else if (checked > 0) {
      badge.className = 'c-consult__recheck-badge c-consult__recheck-badge--ok';
      badge.textContent = `✓ ${checked} entities & numbers trace to the source document`;
    } else {
      badge.className = 'c-consult__recheck-badge c-consult__recheck-badge--muted';
      badge.textContent = '– nothing checkable against the source document';
    }
    wrap.appendChild(badge);

    if (flags.length > 0) {
      const list = document.createElement('div');
      list.className = 'c-consult__recheck-list';
      list.hidden = true;
      for (const f of flags) {
        const item = document.createElement('div');
        item.className = 'c-consult__recheck-claim c-consult__recheck-claim--flag';
        const icon = document.createElement('span');
        icon.className = 'c-consult__recheck-icon';
        icon.textContent = '⚠';
        const text = document.createElement('div');
        text.className = 'c-consult__recheck-text';
        const claimLine = document.createElement('div');
        claimLine.className = 'c-consult__recheck-excerpt';
        claimLine.textContent = `"${f.span}" — not found in the source document (${f.rule})`;
        const ctxLine = document.createElement('div');
        ctxLine.className = 'c-consult__recheck-recomputed';
        ctxLine.textContent = f.context;
        text.appendChild(claimLine);
        text.appendChild(ctxLine);
        item.appendChild(icon);
        item.appendChild(text);
        list.appendChild(item);
      }
      badge.addEventListener('click', () => {
        list.hidden = !list.hidden;
      });
      wrap.appendChild(list);
    } else {
      badge.classList.add('c-consult__recheck-badge--static');
    }
    return wrap;
  }

  // --- Message rendering ---

  function appendMessage(type, content) {
    const msg = document.createElement('div');
    msg.className = `c-consult__msg c-consult__msg--${type}`;

    if (type === 'answer') {
      const body = document.createElement('div');
      body.className = 'md-body';
      body.innerHTML = renderMarkdown(content);
      msg.appendChild(body);
    } else {
      msg.textContent = content;
    }

    const welcome = log.querySelector('.c-consult__welcome');
    if (welcome) welcome.remove();
    const hero = log.querySelector('.c-consult__lens-hero');
    if (hero) hero.remove();
    log.appendChild(msg);
    log.scrollTop = log.scrollHeight;
    return msg;
  }

  // --- Deep link: pre-fill question ---

  if (deepLink?.question) {
    textarea.value = deepLink.question;
    updateSendState();
    textarea.focus();
  }

  // --- Teardown ---

  return function teardown() {
    for (const unsub of unsubs) unsub();
    el.remove();
  };
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
