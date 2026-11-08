import { renderExtract } from './modules/extract.js';
import { renderConsult } from './modules/consult.js';
import { renderLibrary } from './modules/library.js';
import { renderProcess } from './modules/process.js';
import { renderInterview } from './modules/interview.js';
import { renderPacks } from './modules/packs.js';
import { selectLens } from './store.js';

window.__interviewStore = { selectLens };

const routes = {
  extract: renderExtract,
  consult: renderConsult,
  library: renderLibrary,
  process: renderProcess,
  interview: renderInterview,
  packs: renderPacks,
};

const DEFAULT_ROUTE = 'library';

let currentTeardown = null;

function parseRoute() {
  const raw = location.hash.replace('#', '').split('?')[0];
  const [base] = raw.split('/');
  return routes[base] ? base : DEFAULT_ROUTE;
}

function getHashParam() {
  const raw = location.hash.replace('#', '').split('?')[0];
  const parts = raw.split('/');
  return parts[1] || null;
}

function getDeepLinkParams() {
  const params = new URLSearchParams(location.search);
  return {
    lens: params.get('lens'),
    question: params.get('q'),
  };
}

function updateNavActive(route) {
  document.querySelectorAll('.nav-link').forEach(link => {
    link.classList.toggle('active', link.dataset.route === route);
  });
}

async function mount(route) {
  const app = document.getElementById('app');

  if (currentTeardown) {
    currentTeardown();
    currentTeardown = null;
  }

  app.innerHTML = '';

  const renderFn = routes[route];
  if (!renderFn) return;

  let deepLink = null;
  if (route === 'consult') deepLink = getDeepLinkParams();
  else if (route === 'library') deepLink = { lensId: getHashParam() };
  else if (route === 'packs') deepLink = { packId: getHashParam() };
  const result = await renderFn(app, deepLink);
  if (typeof result === 'function') {
    currentTeardown = result;
  }

  updateNavActive(route);
}

function onRouteChange() {
  const route = parseRoute();
  mount(route);
}

window.addEventListener('hashchange', onRouteChange);

window.navigate = function navigate(hash) {
  location.hash = hash;
};

// Handle deep links: if ?lens= is present, select it and route to consult
const initialParams = getDeepLinkParams();
if (initialParams.lens) {
  selectLens(initialParams.lens);
  if (!location.hash.includes('consult')) {
    location.hash = 'consult';
  }
}

onRouteChange();
