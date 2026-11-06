import './styles.css';
import { createClient, normalizeBaseUrl, type OverseerrClient } from './api/client';
import { describeError } from './api/errors';
import type { Candidate } from './api/types';
import { requestCandidate } from './core/actions';
import { buildRecommendations } from './core/recommend';
import { clearSettings, createSkipStore, loadSettings, saveSettings, type Settings } from './core/storage';
import { createMockApi } from './mock/mockApi';
import { attachSwipe } from './ui/swipe';

type View = 'setup' | 'loading' | 'ready' | 'error' | 'empty';

const skips = createSkipStore();
let settings: Settings = loadSettings();
let client: OverseerrClient | null = null;
let view: View = 'setup';
let deck: Candidate[] = [];
let busy = false;
let progress = '';
let failure: { title: string; hint: string } | null = null;
let settingsOpen = false;
let scanToken = 0;
let detachSwipe: (() => void) | null = null;

const app = document.getElementById('app')!;
const SWIPE_DISTANCE = 110;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, string> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else el.setAttribute(k, v);
  }
  el.append(...kids);
  return el;
}

function makeClient(): OverseerrClient {
  if (settings.demo) {
    const mock = createMockApi({ latencyMs: 250 });
    return createClient({ baseUrl: 'https://demo.invalid', apiKey: mock.apiKey, fetchImpl: mock.fetch });
  }
  return createClient({ baseUrl: settings.baseUrl, apiKey: settings.apiKey });
}

async function scan() {
  const token = ++scanToken;
  failure = null;
  view = 'loading';
  progress = 'Reading your library…';
  render();
  try {
    client = makeClient();
    await client.getMe();
    const res = await buildRecommendations(client, {
      skipped: skips.all(),
      onProgress: (d, t) => {
        if (token !== scanToken) return;
        progress = `Scanning your library… ${d} / ${t}`;
        const p = document.getElementById('progress');
        if (p) p.textContent = progress;
      },
    });
    if (token !== scanToken) return;
    deck = res.candidates;
    view = deck.length ? 'ready' : 'empty';
  } catch (e) {
    if (token !== scanToken) return;
    failure = describeError(e);
    view = 'error';
  }
  render();
}

function toast(message: string, kind: 'ok' | 'err' | 'info' = 'info', hint = '') {
  let region = document.getElementById('toasts');
  if (!region) {
    region = h('div', { id: 'toasts', class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(region);
  }
  const t = h('div', { class: `toast ${kind}` }, h('strong', {}, message));
  if (hint) t.append(h('span', {}, hint));
  region.append(t);
  setTimeout(() => t.remove(), kind === 'err' ? 7000 : 3500);
}

const topCard = () => document.querySelector<HTMLElement>('.card[data-top="1"]');

function flyOut(dir: 1 | -1, done: () => void) {
  const el = topCard();
  if (!el) return done();
  el.classList.remove('dragging');
  el.style.transition = 'transform .32s ease-in, opacity .32s ease-in';
  el.style.transform = `translateX(${dir * window.innerWidth}px) rotate(${dir * 24}deg)`;
  el.style.opacity = '0';
  setTimeout(done, 300);
}

function springBack() {
  const el = topCard();
  if (!el) return;
  el.style.transition = 'transform .35s cubic-bezier(.2,1.4,.4,1)';
  el.style.transform = '';
  el.style.setProperty('--tilt', '0');
}

function skipTop() {
  if (busy || view !== 'ready' || !deck.length) return;
  const c = deck[0];
  skips.add(c.key);
  busy = true;
  render(false);
  flyOut(-1, () => {
    deck.shift();
    busy = false;
    afterAdvance();
  });
  toast(`Skipped ${c.title}`, 'info');
}

async function requestTop() {
  if (busy || view !== 'ready' || !deck.length || !client) return;
  const c = deck[0];
  busy = true;
  render(false);
  const el = topCard();
  if (el) {
    el.style.transition = 'transform .25s ease-out';
    el.style.transform = 'translateX(36px) rotate(3deg)';
  }
  try {
    await requestCandidate(client, c, skips);
    toast(`Requested ${c.title}`, 'ok', c.mediaType === 'tv' ? 'Season 1 sent to Overseerr.' : '');
    flyOut(1, () => {
      deck.shift();
      busy = false;
      afterAdvance();
    });
  } catch (e) {
    const d = describeError(e);
    toast(`Couldn’t request ${c.title}`, 'err', [d.title, d.hint].filter(Boolean).join(' — '));
    busy = false;
    springBack();
    render(false);
  }
}

function afterAdvance() {
  if (!deck.length) view = 'empty';
  render();
}

// ---------- rendering ----------

function render(full = true) {
  if (!full && view === 'ready') {
    updateControls();
    return;
  }
  detachSwipe?.();
  detachSwipe = null;
  const header = h(
    'header',
    { class: 'top' },
    h('h1', {}, h('span', { class: 'mark', 'aria-hidden': 'true' }, '▮'), 'Overseer ', h('em', {}, 'Recs')),
    h(
      'div',
      { class: 'top-actions' },
      iconButton('Refresh recommendations', '⟳', () => void scan(), view === 'loading' || !isConfigured()),
      iconButton('Settings', '⚙', () => ((settingsOpen = true), render()), false),
    ),
  );
  const main = h('main', { id: 'main', class: 'stage' });
  if (view === 'setup') main.append(setupView());
  else if (view === 'loading') main.append(loadingView());
  else if (view === 'error') main.append(errorView());
  else if (view === 'empty') main.append(emptyView());
  else main.append(deckView());
  app.replaceChildren(header, main);
  if (view === 'ready') {
    app.append(controls());
    const el = topCard();
    if (el) {
      detachSwipe = attachSwipe(
        el,
        {
          onMove: (dx) => {
            el.style.transition = 'none';
            el.style.transform = `translateX(${dx}px) rotate(${dx / 18}deg)`;
            el.style.setProperty('--intent', String(Math.max(-1, Math.min(1, dx / SWIPE_DISTANCE))));
          },
          onRelease: (dx, v) => {
            el.style.setProperty('--intent', '0');
            if (dx > SWIPE_DISTANCE || v > 0.6) void requestTop();
            else if (dx < -SWIPE_DISTANCE || v < -0.6) skipTop();
            else springBack();
          },
        },
        () => !busy,
      );
    }
    updateControls();
  }
  document.getElementById('settings-dialog')?.remove();
  if (settingsOpen) app.append(settingsDialog());
}

const isConfigured = () => settings.demo || (!!settings.baseUrl && !!settings.apiKey);

function iconButton(label: string, glyph: string, onClick: () => void, disabled: boolean) {
  const b = h('button', { class: 'icon-btn', type: 'button', 'aria-label': label, title: label }, glyph);
  b.disabled = disabled;
  b.addEventListener('click', onClick);
  return b;
}

function panel(icon: string, title: string, body: string, ...extra: Node[]) {
  return h('section', { class: 'panel', 'aria-live': 'polite' }, h('div', { class: 'panel-icon', 'aria-hidden': 'true' }, icon), h('h2', {}, title), h('p', {}, body), ...extra);
}

function button(label: string, onClick: () => void, cls = 'btn') {
  const b = h('button', { class: cls, type: 'button' }, label);
  b.addEventListener('click', onClick);
  return b;
}

function setupView() {
  return panel(
    '🎞',
    'Find your next watch',
    'Connect your Overseerr or Jellyseerr and get swipeable picks based on what is already in your library.',
    button('Open settings', () => ((settingsOpen = true), render()), 'btn primary'),
    button('Try the demo', () => {
      settings = { ...settings, demo: true };
      saveSettings(settings);
      void scan();
    }, 'btn ghost'),
  );
}

function loadingView() {
  const p = panel('◌', 'Building your deck', '');
  p.classList.add('loading');
  p.querySelector('p')!.id = 'progress';
  p.querySelector('p')!.textContent = progress;
  p.append(h('div', { class: 'spinner', role: 'progressbar', 'aria-label': 'Loading' }));
  return p;
}

function errorView() {
  const f = failure ?? { title: 'Something went wrong', hint: '' };
  const p = panel('⚠', f.title, f.hint || 'Please try again.');
  p.classList.add('error');
  p.append(button('Try again', () => void scan(), 'btn primary'), button('Settings', () => ((settingsOpen = true), render()), 'btn ghost'));
  return p;
}

function emptyView() {
  const n = skips.all().size;
  const p = panel('✓', 'You’re all caught up', 'No new recommendations right now. Refresh after your library grows' + (n ? ', or bring back skipped titles.' : '.'));
  p.append(button('Refresh', () => void scan(), 'btn primary'));
  if (n) {
    p.append(
      button(`Reset ${n} skipped`, () => {
        skips.clear();
        void scan();
      }, 'btn ghost'),
    );
  }
  return p;
}

function deckView() {
  const wrap = h('div', { class: 'deck', role: 'group', 'aria-roledescription': 'card stack', 'aria-label': `${deck.length} recommendations` });
  const visible = deck.slice(0, 3);
  for (let i = visible.length - 1; i >= 0; i--) wrap.append(cardEl(visible[i], i));
  return wrap;
}

function cardEl(c: Candidate, depth: number) {
  const card = h('article', {
    class: 'card',
    'data-top': depth === 0 ? '1' : '0',
    style: `--depth:${depth}`,
    'aria-hidden': depth === 0 ? 'false' : 'true',
    ...(depth === 0 ? { tabindex: '0', 'aria-label': `${c.title}. Swipe right or press right arrow to request. Swipe left or press left arrow to skip.` } : {}),
  });
  const poster = h('div', { class: 'poster' });
  if (c.posterPath) {
    const img = h('img', { src: `https://image.tmdb.org/t/p/w500${c.posterPath}`, alt: '', draggable: 'false', loading: 'lazy', referrerpolicy: 'no-referrer' });
    img.addEventListener('error', () => img.remove());
    poster.append(img);
  }
  poster.append(h('span', { class: 'poster-fallback', 'aria-hidden': 'true' }, c.title.slice(0, 1)));
  const meta = [c.mediaType === 'tv' ? 'TV' : 'Movie', c.year, c.voteAverage ? `★ ${c.voteAverage.toFixed(1)}` : ''].filter(Boolean).join(' · ');
  const why = `Similar to ${c.sourceCount} title${c.sourceCount === 1 ? '' : 's'} in your library`;
  card.append(
    poster,
    h('div', { class: 'stamp request', 'aria-hidden': 'true' }, 'REQUEST'),
    h('div', { class: 'stamp skip', 'aria-hidden': 'true' }, 'SKIP'),
    h('div', { class: 'info' }, h('p', { class: 'meta' }, meta), h('h2', {}, c.title), h('p', { class: 'why' }, why), h('p', { class: 'overview' }, c.overview || 'No synopsis available.')),
  );
  return card;
}

function controls() {
  const skipB = h('button', { id: 'skip-btn', class: 'round skip', type: 'button', 'aria-label': 'Skip (left arrow)' }, '✕');
  const reqB = h('button', { id: 'req-btn', class: 'round request', type: 'button', 'aria-label': 'Request (right arrow)' }, '＋');
  skipB.addEventListener('click', skipTop);
  reqB.addEventListener('click', () => void requestTop());
  return h('footer', { class: 'controls' }, skipB, h('p', { id: 'count', class: 'count' }), reqB);
}

function updateControls() {
  for (const id of ['skip-btn', 'req-btn']) {
    const b = document.getElementById(id) as HTMLButtonElement | null;
    if (b) b.disabled = busy;
  }
  const req = document.getElementById('req-btn');
  req?.classList.toggle('pending', busy);
  req?.setAttribute('aria-busy', String(busy));
  const n = document.getElementById('count');
  if (n) n.textContent = `${deck.length} left`;
  document.querySelector('.deck')?.setAttribute('aria-busy', String(busy));
}

function settingsDialog() {
  const url = h('input', { id: 'f-url', type: 'url', inputmode: 'url', autocomplete: 'off', placeholder: 'https://overseerr.your-tailnet.ts.net', spellcheck: 'false' });
  url.value = settings.baseUrl;
  const key = h('input', { id: 'f-key', type: 'password', autocomplete: 'off', placeholder: 'Overseerr API key', spellcheck: 'false' });
  key.value = settings.apiKey;
  const status = h('p', { class: 'form-status', role: 'status' });
  const form = h(
    'form',
    { class: 'dialog-body' },
    h('h2', { id: 'settings-title' }, 'Settings'),
    h('p', { class: 'help' }, 'Stored only in this browser (localStorage). Requests go straight from your browser to your server — nothing passes through any app backend. Find the API key in Overseerr under Settings > General.'),
    h('label', { for: 'f-url' }, 'Server URL'),
    url,
    h('label', { for: 'f-key' }, 'API key'),
    key,
    status,
  );
  const buttons = h('div', { class: 'row' });
  const test = button('Test connection', async () => {
    status.className = 'form-status';
    try {
      const c = createClient({ baseUrl: url.value, apiKey: key.value.trim() });
      const me = await c.getMe();
      status.textContent = `Connected as ${me.displayName ?? me.username ?? me.email ?? 'user ' + me.id}.`;
      status.classList.add('ok');
    } catch (e) {
      const d = describeError(e);
      status.textContent = [d.title, d.hint].filter(Boolean).join(' — ');
      status.classList.add('bad');
    }
  }, 'btn ghost');
  const save = h('button', { class: 'btn primary', type: 'submit' }, 'Save & scan');
  const cancel = button('Close', () => ((settingsOpen = false), render()), 'btn ghost');
  const reset = button('Forget settings', () => {
    clearSettings();
    settings = { baseUrl: '', apiKey: '', demo: false };
    settingsOpen = false;
    view = 'setup';
    deck = [];
    scanToken++;
    render();
  }, 'btn danger');
  buttons.append(test, save, cancel, reset);
  form.append(buttons);
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    try {
      settings = { baseUrl: normalizeBaseUrl(url.value), apiKey: key.value.trim(), demo: false };
    } catch (e) {
      const d = describeError(e);
      status.textContent = [d.title, d.hint].filter(Boolean).join(' — ');
      status.className = 'form-status bad';
      return;
    }
    if (!settings.apiKey) {
      status.textContent = 'Enter your API key (Settings > General in Overseerr).';
      status.className = 'form-status bad';
      return;
    }
    saveSettings(settings);
    settingsOpen = false;
    void scan();
  });
  const dlg = h('div', { id: 'settings-dialog', class: 'backdrop' }, h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'settings-title' }, form));
  dlg.addEventListener('pointerdown', (e) => {
    if (e.target === dlg) {
      settingsOpen = false;
      render();
    }
  });
  queueMicrotask(() => url.focus());
  return dlg;
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && settingsOpen) {
    settingsOpen = false;
    render();
    return;
  }
  if (settingsOpen || view !== 'ready') return;
  const t = e.target as HTMLElement;
  if (t.closest('input, textarea, select')) return;
  if (e.key === 'ArrowLeft') {
    e.preventDefault();
    skipTop();
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    void requestTop();
  }
});

if (isConfigured()) void scan();
else render();

