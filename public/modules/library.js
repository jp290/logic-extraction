import { renderMarkdown } from '../shared/markdown.js';
import { store, on, loadLenses, selectLens } from '../store.js';

const DOC_TABS = [
  { key: 'logic_document', label: 'Logic Document' },
  { key: 'knowledge_extract', label: 'Knowledge Extract' },
  { key: 'understanding_document', label: 'Understanding' },
];

export function renderLibrary(root, deepLink) {
  let query = '';
  let detailId = null;
  const unsubs = [];

  const el = document.createElement('div');
  el.className = 'c-library';
  root.appendChild(el);

  if (!store.lenses.length) loadLenses();

  if (deepLink?.lensId) {
    showDetail(deepLink.lensId);
  } else {
    render();
  }

  unsubs.push(on('lenses-loaded', () => { if (!detailId) render(); }));
  unsubs.push(on('lens-created', () => loadLenses()));

  function render() {
    if (detailId) return;
    const lenses = filterLenses();
    let searchInput = el.querySelector('.c-library__search');

    if (!searchInput) {
      el.innerHTML = `
        <div class="c-library__header">
          <h1 class="c-library__title-main">Lens Library</h1>
          <p class="c-library__subtitle">${store.lenses.length} reasoning lenses available</p>
        </div>
        <input type="text" class="c-library__search input"
               placeholder="Search lenses..." value="${escAttr(query)}">
        <div class="c-library__body"></div>
      `;
      searchInput = el.querySelector('.c-library__search');
      searchInput.addEventListener('input', (e) => {
        query = e.target.value;
        render();
      });
    } else {
      el.querySelector('.c-library__subtitle').textContent = `${store.lenses.length} reasoning lenses available`;
    }

    const body = el.querySelector('.c-library__body');
    body.innerHTML = lenses.length === 0
      ? `<p class="c-library__empty">${store.lenses.length ? 'No lenses match.' : 'No lenses yet. Extract one to get started.'}</p>`
      : `<div class="c-library__grid">${lenses.map(cardHTML).join('')}</div>`;

    body.querySelectorAll('.c-library__card').forEach(card => {
      const activate = () => showDetail(card.dataset.id);
      card.addEventListener('click', activate);
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          activate();
        }
      });
    });
  }

  async function showDetail(id) {
    detailId = id;
    history.replaceState(null, '', `#library/${id}`);
    el.innerHTML = `<div class="c-library__detail"><div class="c-library__detail-loading">Loading...</div></div>`;

    try {
      const res = await fetch(`/api/extractions/${id}`);
      if (!res.ok) throw new Error('Failed to load');
      const data = await res.json();
      renderDetail(data);
    } catch {
      el.innerHTML = `<div class="c-library__detail"><p class="c-library__empty">Failed to load lens.</p></div>`;
    }
  }

  function renderDetail(data) {
    const tags = parseTags(data.domain_tags).slice(0, 6);
    const availableTabs = DOC_TABS.filter(t => data[t.key]);
    const firstTab = availableTabs[0]?.key || 'logic_document';

    el.innerHTML = `
      <div class="c-library__detail">
        <div class="c-library__detail-header">
          <button class="c-library__back btn btn-ghost">← Back</button>
          <div class="c-library__detail-actions">
            <button class="c-library__consult-btn btn btn-primary">Consult this lens</button>
          </div>
        </div>

        <div class="c-library__detail-meta">
          <h1 class="c-library__detail-title">${esc(data.title || 'Untitled')}</h1>
          ${data.author ? `<p class="c-library__detail-author">by ${esc(data.author)}</p>` : ''}
          ${data.topic_summary ? `<p class="c-library__detail-summary">${esc(data.topic_summary)}</p>` : ''}
          <div class="c-library__detail-info">
            ${data.doc_type ? `<span class="c-library__detail-chip">${esc(data.doc_type)}</span>` : ''}
            ${data.word_count ? `<span class="c-library__detail-chip">${data.word_count.toLocaleString()} words</span>` : ''}
            ${modelBadgeHTML(data.model)}
            ${data.reading_level ? `<span class="c-library__detail-chip">${esc(data.reading_level)}</span>` : ''}
          </div>
          ${tags.length ? `<div class="c-library__detail-tags">${tags.map(t => `<span class="c-library__tag">${esc(t)}</span>`).join('')}</div>` : ''}
        </div>

        ${availableTabs.length > 1 ? `
          <div class="c-library__detail-tabs">
            ${availableTabs.map(t => `
              <button class="c-library__detail-tab${t.key === firstTab ? ' c-library__detail-tab--active' : ''}" data-tab="${t.key}">${t.label}</button>
            `).join('')}
          </div>
        ` : ''}

        <div class="c-library__detail-content">
          <div class="md-body">${renderMarkdown(data[firstTab] || 'No content available.')}</div>
        </div>

        <div class="c-library__downloads">
          ${data.logic_document ? `<button class="c-library__download" data-doc="logic_document" data-label="Logic Document">↓ Logic Document</button>` : ''}
          ${data.knowledge_extract ? `<button class="c-library__download" data-doc="knowledge_extract" data-label="Knowledge Extract">↓ Knowledge Extract</button>` : ''}
          ${data.understanding_document ? `<button class="c-library__download" data-doc="understanding_document" data-label="Understanding Document">↓ Understanding</button>` : ''}
          <button class="c-library__download c-library__download--all" data-doc="all" data-label="Complete Lens">↓ All layers (.txt)</button>
        </div>
      </div>
    `;

    el.querySelector('.c-library__back').addEventListener('click', () => {
      detailId = null;
      history.replaceState(null, '', '#library');
      render();
    });

    el.querySelector('.c-library__consult-btn').addEventListener('click', () => {
      selectLens(data.id);
      window.navigate('consult');
    });

    const tabContainer = el.querySelector('.c-library__detail-tabs');
    if (tabContainer) {
      tabContainer.addEventListener('click', (e) => {
        const tab = e.target.closest('.c-library__detail-tab');
        if (!tab) return;
        const key = tab.dataset.tab;
        tabContainer.querySelectorAll('.c-library__detail-tab').forEach(t =>
          t.classList.toggle('c-library__detail-tab--active', t === tab)
        );
        const content = el.querySelector('.c-library__detail-content');
        content.innerHTML = `<div class="md-body">${renderMarkdown(data[key] || 'Not available.')}</div>`;
      });
    }

    el.querySelectorAll('.c-library__download').forEach(btn => {
      btn.addEventListener('click', () => {
        const docKey = btn.dataset.doc;
        const slug = (data.title || 'lens').replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase();
        let content, filename;

        if (docKey === 'all') {
          const parts = [`# ${data.title || 'Untitled'}\n`];
          if (data.topic_summary) parts.push(`${data.topic_summary}\n`);
          parts.push('\n---\n');
          if (data.logic_document) parts.push(`\n## Logic Document\n\n${data.logic_document}`);
          if (data.knowledge_extract) parts.push(`\n\n## Knowledge Extract\n\n${data.knowledge_extract}`);
          if (data.understanding_document) parts.push(`\n\n## Understanding Document\n\n${data.understanding_document}`);
          content = parts.join('');
          filename = `${slug}-complete.txt`;
        } else {
          content = data[docKey] || '';
          filename = `${slug}-${btn.dataset.label.replace(/\s+/g, '-').toLowerCase()}.md`;
        }

        const blob = new Blob([content], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
      });
    });
  }

  function filterLenses() {
    const list = store.lenses;
    if (!Array.isArray(list)) return [];
    if (!query.trim()) return list;
    const q = query.toLowerCase();
    return list.filter(l => {
      const text = ((l.title || '') + ' ' + (l.topic_summary || '')).toLowerCase();
      return text.includes(q);
    });
  }

  function cardHTML(lens) {
    const tags = parseTags(lens.domain_tags).slice(0, 3);
    const title = truncate(lens.title || 'Untitled', 60);
    const summary = truncate(lens.topic_summary || '', 120);
    const domain = tags[0] || '';

    return `
      <div class="c-library__card" data-id="${escAttr(String(lens.id))}" data-domain="${esc(domain)}" tabindex="0" role="button">
        ${modelBadgeHTML(lens.model)}
        <h3 class="c-library__title">${esc(title)}</h3>
        ${summary ? `<p class="c-library__summary">${esc(summary)}</p>` : ''}
        ${tags.length ? `<div class="c-library__tags">${tags.map(t => `<span class="c-library__tag">${esc(t)}</span>`).join('')}</div>` : ''}
        <span class="c-library__cta">View details →</span>
      </div>
    `;
  }

  return () => unsubs.forEach(fn => fn());
}

function parseTags(raw) {
  let tags = raw;
  if (!tags) return [];
  if (!Array.isArray(tags)) {
    try { tags = JSON.parse(tags); } catch { return []; }
    if (!Array.isArray(tags)) return [];
  }
  return tags.filter(t => typeof t === 'string' && !t.startsWith('⚡'));
}

function modelBadgeHTML(model) {
  if (!model) return '';
  const isFable = model.startsWith('claude-fable');
  const isClaude = !isFable && model.startsWith('claude');
  const label = isFable ? '⚡ Fable 5'
    : isClaude ? 'Claude'
    : model.includes('+s:') ? 'DeepSeek + Opus'
    : model.startsWith('deepseek') ? 'DeepSeek'
    : model;
  const mod = (isFable || isClaude) ? ' c-library__model--fable' : '';
  return `<span class="c-library__model${mod}" title="Extracted by ${escAttr(model)}">${esc(label)}</span>`;
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function escAttr(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
