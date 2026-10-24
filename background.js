// Clicking the toolbar icon (or Alt+Shift+L) opens the side panel.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

// ---------- signal feed: LinkedIn, dev.to, the Jetson security endpoint, Stripe sales ----------
//
// Everything lands in chrome.storage.local as { feed: { items, errors, updatedAt }, seenAt, settings };
// the panel just renders it. Settings (including secrets) live only in storage.local, never sync.

const POLL_MINUTES = 5;
const KEEP_PER_SOURCE = 60;

const SOURCES = {
  // snapshot: the source reports current state, so its items replace the old ones instead of accumulating.
  linkedin: { enabled: (s) => s.linkedin !== false, fetch: fetchLinkedIn, snapshot: false },
  devto: { enabled: (s) => s.devto !== false, fetch: fetchDevto, snapshot: false },
  server: { enabled: (s) => Boolean(s.serverUrl && s.serverToken), fetch: fetchServer, snapshot: true },
  sales: { enabled: (s) => Boolean(s.stripeKey), fetch: fetchSales, snapshot: false },
};

function schedule() {
  chrome.alarms.create('poll', { periodInMinutes: POLL_MINUTES, delayInMinutes: 0.1 });
}
chrome.runtime.onInstalled.addListener(schedule);
chrome.runtime.onStartup.addListener(schedule);
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'poll') poll(); });

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg === 'poll') { poll().then(() => reply(true)); return true; }
  if (msg === 'seen') { markSeen().then(() => reply(true)); return true; }
});

chrome.notifications.onClicked.addListener(async (id) => {
  const { feed } = await chrome.storage.local.get('feed');
  const item = feed?.items.find((i) => i.id === id);
  if (item?.url) chrome.tabs.create({ url: item.url });
  chrome.notifications.clear(id);
});

let polling = null;
function poll() {
  polling ??= runPoll().finally(() => { polling = null; });
  return polling;
}

async function runPoll() {
  let { settings = {}, feed = { items: [], errors: {} }, seenAt } = await chrome.storage.local.get(['settings', 'feed', 'seenAt']);
  if (seenAt === undefined) {
    // First run: everything that already exists counts as seen.
    seenAt = Date.now();
    await chrome.storage.local.set({ seenAt });
  }

  const results = await Promise.all(Object.entries(SOURCES).map(async ([name, src]) => {
    if (!src.enabled(settings)) return { name, disabled: true };
    try {
      return { name, got: await src.fetch(settings, feed.items.filter((i) => i.source === name), seenAt) };
    } catch (err) {
      return { name, error: err.message || String(err) };
    }
  }));

  const known = new Set(feed.items.map((i) => i.id));
  const fresh = [];
  const errors = {};
  let items = feed.items;
  for (const { name, disabled, got, error } of results) {
    const mine = items.filter((i) => i.source === name);
    const others = items.filter((i) => i.source !== name);
    if (disabled) { items = others; continue; }
    if (error) { errors[name] = error; continue; }  // keep showing the last good items
    if (mine.length) fresh.push(...got.filter((i) => !known.has(i.id)));  // no alerts on a source's first sync
    let merged = SOURCES[name].snapshot ? got : [...got, ...mine];
    const ids = new Set();
    merged = merged.filter((i) => !ids.has(i.id) && ids.add(i.id));
    merged.sort((a, b) => b.ts - a.ts);
    items = [...others, ...merged.slice(0, KEEP_PER_SOURCE)];
  }
  items.sort((a, b) => b.ts - a.ts);

  await chrome.storage.local.set({ feed: { items, errors, updatedAt: Date.now() } });
  await updateBadge(items, seenAt);
  if (settings.alerts !== false) notify(fresh);
}

async function markSeen() {
  const seenAt = Date.now();
  await chrome.storage.local.set({ seenAt });
  const { feed } = await chrome.storage.local.get('feed');
  await updateBadge(feed?.items ?? [], seenAt);
}

async function updateBadge(items, seenAt) {
  const n = items.filter((i) => i.ts > seenAt).length;
  await chrome.action.setBadgeBackgroundColor({ color: '#bc13fe' });
  await chrome.action.setBadgeText({ text: n ? (n > 99 ? '99+' : String(n)) : '' });
}

function notify(items) {
  for (const i of items) {
    const loud = i.source === 'sales' || i.source === 'devto' || (i.source === 'server' && (i.level === 'warn' || i.level === 'crit'));
    if (!loud) continue;
    const prefix = { sales: '💸 ', devto: 'DEV: ', server: '⛨ Jetson: ' }[i.source];
    chrome.notifications.create(i.id, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: i.source === 'devto' ? 'DEV Community' : `${prefix}${i.title}`,
      message: i.source === 'devto' ? i.title : i.detail || '',
      priority: i.level === 'crit' ? 2 : 0,
    });
  }
}

// ---------- LinkedIn ----------
// LinkedIn has no API for personal notifications. Its /notifications/ page ships the cards as
// HTML-escaped Voyager JSON inside the document, so we fetch the page with the browser's own
// LinkedIn session and pull the notification Card entities out of that JSON.

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|quot|amp|lt|gt|apos);/gi, (_, e) => {
    const k = e.toLowerCase();
    if (k[0] === '#') return String.fromCodePoint(k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
    return { quot: '"', amp: '&', lt: '<', gt: '>', apos: "'" }[k];
  });
}

async function fetchLinkedIn() {
  const res = await fetch('https://www.linkedin.com/notifications/', { credentials: 'include', cache: 'no-store' });
  if (/\/(login|authwall|checkpoint|uas)\b/.test(res.url)) throw new Error('Log in to LinkedIn in this browser');
  if (!res.ok) throw new Error(`LinkedIn returned ${res.status}`);
  const html = await res.text();

  const cards = new Map();
  for (const [block] of html.matchAll(/\{&quot;[^<]*\}/g)) {
    if (!block.includes('fsd_notificationCard')) continue;
    let data;
    try { data = JSON.parse(decodeEntities(block)); } catch { continue; }
    for (const e of data.included ?? []) {
      if (e.$type?.endsWith('notifications.Card') && e.headline?.text) cards.set(e.entityUrn, e);
    }
  }
  if (!cards.size) throw new Error('No notifications found (LinkedIn may have changed its page)');

  return [...cards.values()].map((c) => ({
    id: `li:${c.entityUrn}`,
    source: 'linkedin',
    ts: c.publishedAt,
    title: c.headline.text,
    detail: c.contentPrimaryText?.[0]?.text ?? '',
    url: safeUrl(c.cardAction?.actionTarget, 'https://www.linkedin.com/notifications/'),
    unread: !c.read,
  }));
}

// ---------- dev.to ----------
// Same idea as LinkedIn: dev.to's notifications page is server-rendered for the logged-in user.
// The HTML is parsed in the offscreen document (offscreen.js) because workers have no DOMParser.

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['DOM_PARSER'],
      justification: 'Parse the dev.to notifications page',
    });
  } catch (err) {
    if (!/single offscreen/i.test(err.message)) throw err;  // another poll created it first
  }
}

async function fetchDevto(_settings, previous, seenAt) {
  const res = await fetch('https://dev.to/notifications', { credentials: 'include', cache: 'no-store' });
  if (/\/enter\b/.test(res.url)) throw new Error('Log in to dev.to in this browser');
  if (!res.ok) throw new Error(`dev.to returned ${res.status}`);
  await ensureOffscreen();
  const parsed = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'parse-devto', html: await res.text() });
  if (!parsed?.length) return [];

  // Not every notification shows a time. Keep the time we first saw it; on the very first sync,
  // undated ones are backdated just before seenAt so they don't all show up as new.
  const firstSync = !previous.length;
  const known = new Map(previous.map((i) => [i.id, i.ts]));
  return parsed.map((p, idx) => {
    const id = `dev:${p.id}`;
    return {
      id,
      source: 'devto',
      ts: known.get(id) ?? p.ts ?? (firstSync ? seenAt - (idx + 1) * 1000 : Date.now()),
      title: p.text.length > 220 ? `${p.text.slice(0, 220)}…` : p.text,
      url: p.url,
    };
  });
}

// ---------- Jetson security feed (server/secfeed.py) ----------

async function fetchServer(s) {
  let res;
  try {
    res = await fetch(s.serverUrl, {
      headers: { Authorization: `Bearer ${s.serverToken}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new Error('Jetson unreachable (off, or you are off the home network?)');
  }
  if (res.status === 401) throw new Error('Jetson rejected the token');
  if (!res.ok) throw new Error(`Jetson returned ${res.status}`);
  const data = await res.json();
  return data.items.map((i) => ({
    id: `srv:${i.id}`,
    source: 'server',
    ts: i.ts * 1000,
    level: i.level,
    title: i.title,
    detail: i.detail ?? '',
  }));
}

// ---------- Stripe sales ----------

function money(cents, currency) {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

async function fetchSales(s) {
  const res = await fetch('https://api.stripe.com/v1/charges?limit=25', {
    headers: { Authorization: `Bearer ${s.stripeKey}` },
    cache: 'no-store',
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || `Stripe returned ${res.status}`);

  return data.data.filter((c) => c.status === 'succeeded').map((c) => ({
    id: `stripe:${c.id}${c.refunded ? ':refunded' : ''}`,
    source: 'sales',
    ts: c.created * 1000,
    title: c.refunded ? `↩ ${money(c.amount, c.currency)} refunded` : `${money(c.amount, c.currency)} sale`,
    detail: [c.billing_details?.name, c.description].filter(Boolean).join(' — '),
    url: `https://dashboard.stripe.com/${c.livemode ? '' : 'test/'}payments/${c.payment_intent || c.id}`,
    amount: c.amount,
    currency: c.currency.toUpperCase(),
    refunded: c.refunded,
  }));
}

function safeUrl(url, fallback) {
  try {
    const u = new URL(url, 'https://www.linkedin.com');
    return /^https?:$/.test(u.protocol) ? u.href : fallback;
  } catch {
    return fallback;
  }
}
