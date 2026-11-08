const listeners = {};

export function on(event, fn) {
  if (!listeners[event]) listeners[event] = [];
  listeners[event].push(fn);
  return () => {
    listeners[event] = listeners[event].filter(f => f !== fn);
  };
}

export function emit(event, data) {
  if (!listeners[event]) return;
  for (const fn of listeners[event]) fn(data);
}

export const store = {
  lenses: [],
  currentLensId: null,
  packs: [],
  currentPackId: null,
};

export async function loadPacks() {
  try {
    const res = await fetch('/api/packs');
    const data = await res.json();
    store.packs = (data.packs || []).filter(p => p.status === 'complete');
    emit('packs-loaded', store.packs);
  } catch {
    store.packs = [];
    emit('packs-error');
  }
}

export function selectPack(id) {
  store.currentPackId = id || null;
  emit('pack-selected', store.currentPackId);
}

export async function loadLenses() {
  try {
    const res = await fetch('/api/extractions/titles');
    const data = await res.json();
    store.lenses = data.extractions || data;
    emit('lenses-loaded', store.lenses);
  } catch {
    store.lenses = [];
    emit('lenses-error');
  }
}

export function selectLens(id) {
  store.currentLensId = id;
  emit('lens-selected', id);
}
