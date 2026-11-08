import { renderMarkdown } from '../shared/markdown.js';
import { loadPacks, selectPack } from '../store.js';

const ROLES = ['ignore', 'index', 'value', 'group', 'x', 'y'];
const ROLE_HINTS = {
  index: 'one row per step (cycle, day…) — gets trend fits',
  value: 'measured quantity to fit against the index',
  group: 'run/cycle id for long-format trace data',
  x: 'within-group coordinate (time…)',
  y: 'within-group measurement — gets a shape table',
  ignore: 'not used',
};

export function renderPacks(root, deepLink) {
  const el = document.createElement('div');
  el.className = 'c-packs';
  root.appendChild(el);

  let pollTimer = null;

  if (deepLink?.packId) {
    renderDetail(deepLink.packId);
  } else {
    renderList();
  }

  async function renderList() {
    el.innerHTML = `
      <div class="c-packs__wrap">
        <header class="c-packs__header">
          <h1 class="c-packs__title">Grounding Packs</h1>
          <p class="c-packs__tagline">Ask your own process data — every number mechanically verified.
          A pack holds your measurements plus deterministically fitted models, validated on held-out data,
          with the valid envelope stated up front. In-envelope Q&amp;A — not forecasting.
          Answers consulted against a pack get an answer-time numeric re-check; numeric artifact-derived
          claims only, prose misattribution remains verifier-only.</p>
        </header>
        <div class="c-packs__list"><p class="c-packs__muted">Loading…</p></div>
        <section class="c-packs__new">
          <h2 class="c-packs__h2">Create a pack</h2>
          <p class="c-packs__muted">Upload a numeric CSV (header row + at least 12 data rows), then tell us what each column means.</p>
          <input class="c-packs__field input" type="text" id="pack-title" placeholder="Pack title (e.g. 'Reactor 3 — daily yield, Jan–May')" maxlength="120">
          <textarea class="c-packs__field textarea" id="pack-notes" rows="2" placeholder="Operator notes: equipment, conditions, units context (optional)"></textarea>
          <input type="file" id="pack-file" accept=".csv,text/csv" class="c-packs__file">
          <div id="pack-columns"></div>
          <button class="btn btn-primary" id="pack-submit" disabled>Build &amp; verify pack</button>
          <div class="c-packs__status" id="pack-status" hidden></div>
        </section>
      </div>
    `;

    const listEl = el.querySelector('.c-packs__list');
    try {
      const res = await fetch('/api/packs');
      const data = await res.json();
      const packs = data.packs || [];
      listEl.innerHTML = packs.length === 0
        ? '<p class="c-packs__muted">No packs yet.</p>'
        : packs.map(p => `
            <a class="c-packs__row" href="#packs/${escapeHtml(p.id)}">
              <span class="c-packs__row-title">${escapeHtml(p.title)}</span>
              <span class="c-packs__badge c-packs__badge--${p.status}">${
                p.status === 'complete' ? '✓ verified' : p.status === 'building' ? 'building…' : 'failed'
              }</span>
            </a>`).join('');
    } catch {
      listEl.innerHTML = '<p class="c-packs__muted">Could not load packs.</p>';
    }

    wireForm();
  }

  function wireForm() {
    const fileInput = el.querySelector('#pack-file');
    const columnsEl = el.querySelector('#pack-columns');
    const submitBtn = el.querySelector('#pack-submit');
    const statusEl = el.querySelector('#pack-status');
    let csvText = '';
    let header = [];

    fileInput.addEventListener('change', async () => {
      const f = fileInput.files?.[0];
      if (!f) return;
      if (f.size > 300_000) {
        statusEl.hidden = false;
        statusEl.textContent = 'CSV too large (max 300KB).';
        return;
      }
      csvText = await f.text();
      header = (csvText.trim().split('\n')[0] || '').split(',').map(h => h.trim());
      columnsEl.innerHTML = `
        <table class="c-packs__coltable">
          <thead><tr><th>Column</th><th>Role</th><th>Unit</th></tr></thead>
          <tbody>
            ${header.map((h, i) => `
              <tr>
                <td><code>${escapeHtml(h)}</code></td>
                <td><select data-col="${i}" class="c-packs__role">
                  ${ROLES.map(r => `<option value="${r}">${r}</option>`).join('')}
                </select></td>
                <td><input data-unit="${i}" class="c-packs__unit input" type="text" maxlength="20" placeholder="unit"></td>
              </tr>`).join('')}
          </tbody>
        </table>
        <p class="c-packs__muted c-packs__rolehint">Roles: ${ROLES.filter(r => r !== 'ignore').map(r => `<strong>${r}</strong> — ${ROLE_HINTS[r]}`).join('; ')}.</p>
      `;
      submitBtn.disabled = false;
    });

    submitBtn.addEventListener('click', async () => {
      const title = el.querySelector('#pack-title').value.trim();
      if (title.length < 3) {
        statusEl.hidden = false;
        statusEl.textContent = 'Title required (3+ characters).';
        return;
      }
      const columns = {};
      header.forEach((h, i) => {
        const role = columnsEl.querySelector(`select[data-col="${i}"]`)?.value || 'ignore';
        const unit = columnsEl.querySelector(`input[data-unit="${i}"]`)?.value.trim();
        columns[h] = unit ? { role, unit } : { role };
      });
      submitBtn.disabled = true;
      statusEl.hidden = false;
      statusEl.textContent = 'Building pack — fitting models and running the verification gate…';
      try {
        const res = await fetch('/api/packs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title,
            notes: el.querySelector('#pack-notes').value.trim(),
            csv: csvText,
            columns,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          statusEl.textContent = data.error || 'Failed to create pack.';
          submitBtn.disabled = false;
          return;
        }
        pollStatus(data.id, statusEl);
      } catch {
        statusEl.textContent = 'Network error — please try again.';
        submitBtn.disabled = false;
      }
    });
  }

  function pollStatus(id, statusEl) {
    pollTimer = setInterval(async () => {
      try {
        const res = await fetch(`/api/packs/${id}`);
        const p = await res.json();
        if (p.status === 'complete') {
          clearInterval(pollTimer);
          loadPacks();
          location.hash = `packs/${id}`;
        } else if (p.status === 'failed') {
          clearInterval(pollTimer);
          statusEl.textContent = `Pack failed: ${p.error || 'unknown error'}`;
          const btn = el.querySelector('#pack-submit');
          if (btn) btn.disabled = false;
        }
      } catch { /* keep polling */ }
    }, 1500);
  }

  async function renderDetail(id) {
    el.innerHTML = '<div class="c-packs__wrap"><p class="c-packs__muted">Loading pack…</p></div>';
    let p;
    try {
      const res = await fetch(`/api/packs/${id}`);
      p = await res.json();
      if (!res.ok) throw new Error(p.error);
    } catch {
      el.innerHTML = '<div class="c-packs__wrap"><p class="c-packs__muted">Pack not found.</p><p><a href="#packs">← All packs</a></p></div>';
      return;
    }

    let verify = null;
    try { verify = JSON.parse(p.verify_report || 'null'); } catch { verify = null; }
    const envelope = extractEnvelope(p.pack_doc || '');

    el.innerHTML = `
      <div class="c-packs__wrap">
        <p><a href="#packs">← All packs</a></p>
        <header class="c-packs__header">
          <h1 class="c-packs__title">${escapeHtml(p.title)}</h1>
          <div class="c-packs__meta">
            <span class="c-packs__badge c-packs__badge--${p.status}">${
              p.status === 'complete' ? '✓ verified at write time' : p.status === 'building' ? 'building…' : 'failed'
            }</span>
            ${p.dataset_sha256 ? `<span class="c-packs__sha" title="sha256 of the uploaded dataset">data ${escapeHtml(p.dataset_sha256.slice(0, 12))}…</span>` : ''}
          </div>
        </header>
        ${p.status === 'failed' ? `<div class="c-packs__error">Build failed: ${escapeHtml(p.error || 'unknown')}</div>` : ''}
        ${envelope ? `<div class="c-packs__envelope"><strong>Valid envelope.</strong> ${escapeHtml(envelope)}</div>` : ''}
        ${verify && Array.isArray(verify.items) ? `
          <section class="c-packs__verify">
            <h2 class="c-packs__h2">Verification — every number recomputed from the raw data</h2>
            <ul class="c-packs__checks">
              ${verify.items.map(i => `<li class="${i.pass ? 'pass' : 'fail'}">${i.pass ? '✓' : '✗'} ${escapeHtml(i.key)}</li>`).join('')}
            </ul>
          </section>` : ''}
        ${p.status === 'complete' ? `<button class="btn btn-primary" id="pack-consult">Consult this pack</button>` : ''}
        ${p.pack_doc ? `<section class="c-packs__doc md-body">${renderMarkdown(p.pack_doc)}</section>` : ''}
      </div>
    `;

    const consultBtn = el.querySelector('#pack-consult');
    if (consultBtn) {
      consultBtn.addEventListener('click', () => {
        selectPack(p.id);
        location.hash = 'consult';
      });
    }
  }

  return function teardown() {
    if (pollTimer) clearInterval(pollTimer);
    el.remove();
  };
}

function extractEnvelope(doc) {
  const m = doc.match(/\*\*Valid envelope:([\s\S]*?)\*\*/);
  return m ? m[1].trim() : '';
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
