/**
 * The announcement banner (plan §C5).
 *
 * A lead says something and it appears above the tabs for everyone it applies to. The
 * audience filter is the server's: `GET /api/v1/announcements` returns only what the caller
 * is part of, and the SSE hub drops a targeted frame before it reaches a stream that should
 * not have it. This file decides nothing about who may see what; it renders what arrives.
 *
 * `role="status"` with `aria-live="polite"` means a screen reader announces a new notice
 * when it lands without interrupting whatever the person is doing. That is the right
 * urgency for "pizza is here" and, deliberately, also for an escalation: the loud path for
 * a real emergency is the lead console, not a banner.
 */
(function () {
  'use strict';

  const N = window.Nexus;
  if (!N) { console.error('[announce] nexus.js must load first'); return; }

  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const live = new Map(); // id → { message, tone, authorName, expiresAt }
  let timer = null;

  function host() {
    return document.getElementById('announce-banner');
  }

  function paint() {
    const el = host();
    if (!el) return;
    const now = Date.now();
    for (const [id, a] of live) if (new Date(a.expiresAt).getTime() <= now) live.delete(id);

    if (live.size === 0) {
      el.hidden = true;
      el.replaceChildren();
      return;
    }
    // Newest first, and only the three most recent: a banner that grows without bound
    // pushes the actual dashboard off the screen.
    const rows = [...live.values()]
      .sort((a, b) => new Date(b.createdAt ?? 0) - new Date(a.createdAt ?? 0))
      .slice(0, 3);
    el.hidden = false;
    el.innerHTML = rows
      .map((a) => `<div class="announce-row" data-tone="${esc(a.tone || 'INFO')}">
        <span class="announce-tone">${esc((a.tone || 'INFO').toLowerCase())}</span>
        <span class="announce-msg">${esc(a.message)}</span>
        <span class="announce-by">${esc(a.authorName || '')}</span>
      </div>`)
      .join('');
  }

  function remember(a) {
    if (!a || !a.id || !a.message) return;
    live.set(a.id, a);
    paint();
  }

  async function refresh() {
    try {
      const { data } = await N.api('/api/v1/announcements', { lenient: true });
      live.clear();
      for (const a of Array.isArray(data) ? data : []) live.set(a.id, a);
      paint();
    } catch (err) {
      console.debug('[announce] refresh failed:', err.message);
    }
  }

  // A frame that reaches this client has already passed the hub's audience filter.
  N.onEvent('ANNOUNCEMENT', (a) => remember(a));
  N.onEvent('ANNOUNCEMENT_CLEARED', (a) => { if (a?.id) { live.delete(a.id); paint(); } });
  N.onEvent('session:ready', () => {
    void refresh();
    // Expiry is a wall-clock property, so nothing pushes it: sweep on a slow timer.
    if (!timer) timer = setInterval(paint, 15_000);
  });
})();
