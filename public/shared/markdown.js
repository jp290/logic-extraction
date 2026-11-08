export function renderMarkdown(text) {
  const raw = marked.parse(text);
  return DOMPurify.sanitize(raw, { FORCE_BODY: true, FORBID_TAGS: ['style', 'form', 'input', 'textarea'], FORBID_ATTR: ['onerror', 'onload', 'style'] });
}
