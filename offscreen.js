// Service workers have no DOMParser, so background.js hands HTML here to be parsed.

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.target !== 'offscreen') return;
  if (msg.type === 'parse-devto') reply(parseDevto(msg.html));
});

const UNIT_MS = { minute: 60e3, hour: 3600e3, day: 86400e3, month: 30 * 86400e3, year: 365 * 86400e3 };

// dev.to only shows relative times like "about 2 hours ago"; null when there is none.
function relativeTime(text) {
  const m = text.match(/\b(\d+|an?|less than a) (minute|hour|day|month|year)s? ago\b/);
  if (!m) return null;
  const n = /^\d+$/.test(m[1]) ? Number(m[1]) : m[1] === 'less than a' ? 0 : 1;
  return Date.now() - n * UNIT_MS[m[2]];
}

function parseDevto(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return [...doc.querySelectorAll('[data-notification-id]')].map((n) => {
    const content = n.querySelector('.notification__content') ?? n;
    const text = content.textContent.replace(/\s+/g, ' ').trim();
    const reaction = content.querySelector('[data-tooltip]')?.getAttribute('data-tooltip');
    const urls = [...content.querySelectorAll('a[href]')].map((a) => new URL(a.getAttribute('href'), 'https://dev.to'));
    // Prefer a post/comment link (/user/slug...) over the actor's profile link (/user).
    const target = urls.find((u) => u.pathname.split('/').filter(Boolean).length >= 2) ?? urls[0];
    return {
      id: n.dataset.notificationId,
      text: reaction ? `${text} [${reaction}]` : text,
      url: target?.href ?? 'https://dev.to/notifications',
      ts: relativeTime(text),
    };
  });
}
