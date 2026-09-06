/**
 * onboarding — the `#onboard` dialog (plan C3, M1 slice: two steps).
 *
 *   STEP 1 / 2  Sign in. Claim code always; magic link and Adonix only when
 *               GET /auth/providers says so; "Continue as demo volunteer" in
 *               legacy / dev mode.
 *   STEP 2 / 2  "That's you." — name, kind, faction. Let's go.
 *
 * The faction picker, trainer creator and permission priming (steps 3–4 in
 * the plan) land in M3/M4 and slot in between.
 *
 * Opens itself when session.js says a sign-in is required, when a badge /
 * magic / Adonix fragment is being exchanged (so the user sees the outcome),
 * and from the header chip (`data-action="session"`). Everything goes through
 * `Nexus.dialog` for the focus trap and Escape handling; no inline styles —
 * see the `.ob-*` block in styles.css.
 */

(function () {
  'use strict';

  const N = window.Nexus;
  if (!N) { console.error('[onboarding] nexus.js must load first'); return; }

  const KIND_LABEL = { VOLUNTEER: 'Volunteer', HACKER: 'Hacker' };
  const CODE_LEN = 10;

  const state = {
    el: null,           // #onboard
    step: 1,
    providers: { mode: 'legacy', providers: [], available: false },
    required: false,
    busy: false,
    linkPending: false,
    pendingFragment: /^#(claim|magic|adonix)=/.test(location.hash) ? location.hash.slice(1).split('=')[0] : null,
  };

  const esc = (v) => String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const factionMeta = (id) => {
    const f = typeof factionOf === 'function' ? factionOf(id) : null;
    return f || { label: String(id || 'Unclaimed').replace(/^TEAM_/, 'Team ').replace(/\b\w/g, (c) => c.toUpperCase()), color: '#7C8DAA' };
  };

  const sprite = (id, scale) => (window.Sprites ? window.Sprites.img(id, scale, 'pxi', '') : '');

  /* ------------------------------------------------------------------ *
   * Markup
   * ------------------------------------------------------------------ */

  function ensureHost() {
    if (state.el) return state.el;
    const el = document.createElement('div');
    el.id = 'onboard';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', 'ob-title');
    document.body.appendChild(el);
    el.addEventListener('submit', onSubmit);
    state.el = el;
    return el;
  }

  const hasProvider = (id) => state.providers.providers.some((p) => p.id === id && p.enabled);
  const provider = (id) => state.providers.providers.find((p) => p.id === id) || null;
  const demoAllowed = () => state.providers.mode === 'legacy' || hasProvider('dev');

  function stepOne() {
    const magic = hasProvider('magic');
    const adonix = hasProvider('adonix') && /^https:\/\//.test(provider('adonix')?.startUrl || '');
    return `
      <div class="ob-head">
        <span class="ob-duck" aria-hidden="true">${sprite('duck', 4)}</span>
        <div>
          <div class="eyebrow">Nexus Quest · HackIllinois 2027</div>
          <h2 id="ob-title">Who goes there?</h2>
          <p>${state.required ? 'No badge, no campus. Sign in.' : 'Sign in to play as yourself. Karma sticks to you, not the laptop.'}</p>
        </div>
      </div>

      <form class="ob-form" data-ob="claim" novalidate>
        <label class="hud-label" for="ob-code">Badge code</label>
        <div class="ob-row">
          <input id="ob-code" class="px-input code" name="code" type="text" inputmode="text" autocapitalize="characters" autocomplete="one-time-code" spellcheck="false" maxlength="${CODE_LEN + 2}" placeholder="XXXXXXXXXX" aria-describedby="ob-code-hint" required>
          <button class="pb" type="submit">Enter</button>
        </div>
        <p class="ob-hint" id="ob-code-hint">Badge code. Ten characters. Go.</p>
      </form>

      ${magic ? `
      <form class="ob-form" data-ob="magic" novalidate>
        <label class="hud-label" for="ob-email">Or your email</label>
        <div class="ob-row">
          <input id="ob-email" class="px-input" name="email" type="email" inputmode="email" autocomplete="email" autocapitalize="none" spellcheck="false" placeholder="you@illinois.edu" aria-describedby="ob-email-hint" required>
          <button class="pb pb-patina" type="submit">Send link</button>
        </div>
        <p class="ob-hint" id="ob-email-hint">We mail you a link. Fifteen minutes. One use.</p>
      </form>` : ''}

      ${adonix || demoAllowed() ? `
      <div class="ob-alt">
        ${adonix ? `<a class="pb pb-ghost" id="ob-adonix" rel="noopener">${esc(provider('adonix').label || 'Sign in with Adonix')}</a>` : ''}
        ${demoAllowed() ? `<button class="pb pb-ghost" type="button" data-action="onboard-demo">Continue as demo volunteer</button>` : ''}
      </div>` : ''}

      <div class="ob-status" id="ob-status" role="status" aria-live="polite"></div>

      ${state.required ? '' : `<div class="ob-foot"><button class="link" type="button" data-action="onboard-close">Later</button></div>`}`;
  }

  function stepTwo(user) {
    const f = factionMeta(user.faction);
    const kind = KIND_LABEL[user.kind] || user.kind || 'Trainer';
    return `
      <div class="ob-head">
        <span class="ob-duck" aria-hidden="true">${sprite('duck', 4)}</span>
        <div>
          <div class="eyebrow">Signed in</div>
          <h2 id="ob-title">That's you.</h2>
          <p>${user.kind === 'HACKER' ? 'Hackers spin stops, hold gyms and can call for help. Quests are for volunteers.' : 'Quests, gyms, stops, distress calls. All of it counts.'}</p>
        </div>
      </div>

      <div class="ob-card">
        <div class="ob-avatar">${sprite('trainer', 6)}</div>
        <div class="ob-id">
          <div class="ob-name">${esc(user.displayName || user.name || 'Trainer')}</div>
          <div class="ob-meta">
            <span class="sticker flat">${esc(kind)}</span>
            <span class="ob-fac" data-faction="${esc(user.faction || 'NEUTRAL')}"><i></i>${esc(f.label)}</span>
            ${user.role && user.role !== 'VOLUNTEER' && user.role !== 'HACKER' ? `<span class="sticker rare">${esc(String(user.role).replace(/_/g, ' '))}</span>` : ''}
          </div>
          <div class="ob-stats">
            <span><b>${Number(user.karmaPoints) || 0}</b><small>KARMA</small></span>
            <span><b>${Number(user.hoursServed) || 0}</b><small>HOURS</small></span>
            <span><b>${(user.badges || []).length}</b><small>BADGES</small></span>
          </div>
        </div>
      </div>

      <div class="ob-foot">
        <button class="pb pb-live" type="button" data-action="onboard-go" id="ob-go">Let's go</button>
        <button class="link" type="button" data-action="onboard-logout">Not you? Log out</button>
      </div>`;
  }

  function stepLink(user) {
    return `
      <div class="ob-head">
        <span class="ob-duck" aria-hidden="true">${sprite('duck', 4)}</span>
        <div>
          <div class="eyebrow">Connect HackIllinois</div>
          <h2 id="ob-title">Link this login?</h2>
          <p>You are signed in as <b>${esc(user.displayName || user.name || 'Trainer')}</b>. A HackIllinois login just arrived. Connect it to this account so it signs you in next time?</p>
          <p class="ob-hint">If you did not just click "Sign in with HackIllinois", choose Not now.</p>
        </div>
      </div>
      <div class="ob-status" id="ob-status" role="status" aria-live="polite"></div>
      <div class="ob-foot">
        <button class="pb pb-live" type="button" data-action="onboard-link-confirm">Yes, connect it</button>
        <button class="link" type="button" data-action="onboard-link-dismiss">Not now</button>
      </div>`;
  }

  function render() {
    const el = ensureHost();
    const user = N.session.user;
    const linking = !!(state.linkPending && user && N.session.pendingLink);
    const step = state.step === 2 && user ? 2 : 1;
    state.step = step;
    el.innerHTML = `
      <div class="px ob-panel">
        <span class="sticker ob-step">${linking ? 'LINK' : `STEP ${step} / 2`}</span>
        ${linking ? stepLink(user) : step === 2 ? stepTwo(user) : stepOne()}
      </div>`;
    // href set as a property, never interpolated: the value is server-provided.
    const a = el.querySelector('#ob-adonix');
    if (a) a.href = provider('adonix').startUrl;
    el.querySelectorAll('.ob-fac[data-faction]').forEach((chip) => {
      chip.style.setProperty('--c', factionMeta(chip.dataset.faction).color);
    });
    return el;
  }

  /* ------------------------------------------------------------------ *
   * Open / close / status
   * ------------------------------------------------------------------ */

  function open(step = 1, { required = state.required } = {}) {
    state.required = !!required;
    state.step = step;
    const el = render();
    N.dialog.open(el, {
      dismissible: !state.required,
      initialFocus: step === 2 ? '#ob-go' : '#ob-code',
      onClose: () => { state.busy = false; },
    });
    return el;
  }

  function close() {
    if (state.el) N.dialog.close(state.el);
  }

  function status(text, tone = '') {
    const s = state.el?.querySelector('#ob-status');
    if (!s) return;
    s.textContent = text || '';
    s.className = `ob-status${tone ? ` is-${tone}` : ''}`;
  }

  function setBusy(on) {
    state.busy = on;
    state.el?.querySelectorAll('button, input').forEach((c) => {
      if (c.dataset.action === 'onboard-close') return;
      c.disabled = on;
    });
  }

  const friendly = (err) => {
    switch (err?.code) {
      case 'ACCOUNT_LINK_CONFIRM':
        return 'Confirm the link from the dialog before connecting this login.';
      case 'ACCOUNT_LINK_REQUIRED':
        return 'That email already has an account. Sign in with your badge code first, then connect HackIllinois.';
      case 'CREDENTIAL_INVALID':
      case 'CLAIM_CODE_INVALID':
      case 'CLAIM_CODE_USED':
      case 'CLAIM_CODE_EXPIRED':
      case 'NOT_FOUND':
        return "That code didn't open anything. Check the badge and try again.";
      case 'RATE_LIMITED':
      case 'HTTP_429':
        return 'Too many tries. Breathe. Try again in a minute.';
      case 'HTTP_404':
        return 'Sign-in is not switched on for this server yet.';
      default:
        return err?.message || 'Something went sideways. Try again.';
    }
  };

  /* ------------------------------------------------------------------ *
   * Handlers
   * ------------------------------------------------------------------ */

  async function onSubmit(e) {
    const form = e.target instanceof HTMLFormElement ? e.target : null;
    if (!form || !form.dataset.ob) return;
    e.preventDefault();
    if (state.busy) return;
    const kind = form.dataset.ob;

    if (kind === 'claim') {
      const input = form.querySelector('#ob-code');
      const code = String(input?.value || '').replace(/[\s-]/g, '').toUpperCase();
      if (code.length < 6) { status('Ten characters. It is printed under the QR.', 'warn'); input?.focus(); return; }
      setBusy(true);
      status('Reading your badge…');
      try {
        await N.session.exchange('claim', code);
        open(2);
      } catch (err) {
        setBusy(false);
        status(friendly(err), 'err');
        input?.select?.();
      }
      return;
    }

    if (kind === 'magic') {
      const input = form.querySelector('#ob-email');
      const email = String(input?.value || '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { status('That is not an email.', 'warn'); input?.focus(); return; }
      setBusy(true);
      status('Sending…');
      try {
        await N.session.requestMagicLink(email);
        setBusy(false);
        status(`Sent to ${email}. Open it on this device. Fifteen minutes.`, 'ok');
      } catch (err) {
        setBusy(false);
        status(friendly(err), 'err');
      }
    }
  }

  N.registerAction('onboard-demo', async () => {
    if (state.busy) return;
    setBusy(true);
    status('Borrowing the organiser account from the roster…');
    try {
      const first = await N.session.pickDemoAccount();
      if (!first?.id) throw new N.ApiError('No volunteers seeded yet.', { code: 'NO_VOLUNTEERS' });
      try {
        await N.session.exchange('dev', first.id);
        open(2);
      } catch (err) {
        if (err.status !== 404) throw err;
        // No dev-login route (legacy server): app.js already acts as the
        // first volunteer without a session, so just get out of the way.
        setBusy(false);
        close();
      }
    } catch (err) {
      setBusy(false);
      status(friendly(err), 'err');
    }
  });

  N.registerAction('onboard-link-confirm', async () => {
    if (state.busy) return;
    setBusy(true);
    status('Connecting…');
    try {
      await N.session.confirmLink();
      state.linkPending = false;
      open(2);
    } catch (err) {
      setBusy(false);
      status(friendly(err), 'err');
    }
  });
  N.registerAction('onboard-link-dismiss', () => {
    N.session.dismissLink();
    state.linkPending = false;
    close();
  });
  N.onEvent('session:link-pending', () => {
    state.linkPending = true;
    open(2, { required: false });
  });

  N.registerAction('onboard-go', () => { close(); window.game?.toast?.(`Welcome, ${N.session.user?.displayName || 'trainer'}. The campus is yours.`); });
  N.registerAction('onboard-close', () => { if (!state.required) close(); });
  N.registerAction('onboard-logout', () => { setBusy(true); N.session.logout(); });
  N.registerAction('session', () => open(N.session.user ? 2 : 1, { required: false }));

  /* ------------------------------------------------------------------ *
   * Header chip
   * ------------------------------------------------------------------ */

  function paintChip(user) {
    const btn = document.getElementById('session-btn');
    if (!btn) return;
    btn.textContent = user ? (user.displayName || 'Signed in') : 'Sign in';
    btn.classList.toggle('pb-patina', !!user);
    btn.classList.toggle('pb-ghost', !user);
    btn.setAttribute('aria-label', user ? `Signed in as ${user.displayName || 'trainer'}. Open account.` : 'Sign in');
  }

  /* ------------------------------------------------------------------ *
   * Session events
   * ------------------------------------------------------------------ */

  // A fragment is being exchanged right now: show the dialog in its busy
  // state so the outcome has somewhere to land.
  if (state.pendingFragment) {
    const start = () => {
      if (N.session.user || !state.pendingFragment) return;
      open(1);
      setBusy(true);
      status(state.pendingFragment === 'claim' ? 'Reading your badge…' : state.pendingFragment === 'magic' ? 'Checking your link…' : 'Talking to Adonix…');
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start();
  }

  N.onEvent('session', paintChip);

  N.onEvent('session:ready', ({ user, providers }) => {
    state.providers = providers;
    state.pendingFragment = null;
    paintChip(user);
    if (user && state.el && N.dialog.isOpen(state.el)) open(2);
  });

  N.onEvent('session:exchanged', ({ kind }) => {
    state.pendingFragment = null;
    // Show the confirmation for a badge / link / Adonix landing; a dev
    // auto-login is the zero-setup demo and should not interrupt.
    if (kind !== 'dev') open(2, { required: false });
  });

  N.onEvent('session:error', ({ error }) => {
    state.pendingFragment = null;
    if (!state.el || !N.dialog.isOpen(state.el)) open(1);
    setBusy(false);
    status(friendly(error), 'err');
  });

  N.onEvent('session:required', (providers) => {
    state.providers = providers;
    open(1, { required: true });
  });

  N.onEvent('session:logout', () => { state.required = state.providers.mode === 'required'; });

  window.onboarding = { open, close };
})();
