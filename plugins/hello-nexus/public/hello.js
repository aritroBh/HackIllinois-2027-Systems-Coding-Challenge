/**
 * hello-nexus, browser half — the smallest useful client plugin.
 *
 * Served from `/dashboard/plugins/hello-nexus/hello.js`. A plugin script is an ordinary
 * classic script under the same CSP as the shell: `script-src 'self'`, no inline handlers,
 * no build step, no imports. It gets `window.Nexus` and nothing else, and it must survive
 * loading in any order relative to the rest of the dashboard.
 *
 * The tab renders from the plugin's own route, so it also demonstrates the failure the guard
 * produces: when the plugin is disabled server-side the fetch is a 404 and the tab says so
 * rather than sitting empty.
 */
(function () {
  const N = window.Nexus;
  if (!N) { console.error('[hello-nexus] nexus.js must load first'); return; }

  const ENDPOINT = '/api/v1/plugins/hello-nexus/hello';
  const TAB_ID = 'tab-hello-nexus';

  let host = null;

  /**
   * Builds the panel with `textContent` throughout. Nothing from the server is ever
   * concatenated into markup, so there is no escaping to get wrong.
   */
  function field(label, value) {
    const row = document.createElement('div');
    row.className = 'stat';
    const k = document.createElement('small');
    k.className = 'muted';
    k.textContent = label;
    const v = document.createElement('span');
    v.className = 'v';
    v.textContent = String(value);
    row.append(k, v);
    return row;
  }

  function renderStatus(message) {
    if (!host) return;
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = message;
    host.replaceChildren(p);
  }

  function renderData(data) {
    if (!host) return;
    const box = document.createElement('div');
    box.className = 'panel';

    const title = document.createElement('h3');
    title.textContent = data.greeting;
    box.append(title);

    box.append(field('Plugin', `${data.plugin} v${data.version}`));
    box.append(field('Check-ins seen', data.checkInsSeen));
    box.append(field('Server uptime', `${data.uptimeSeconds}s`));

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pb';
    btn.dataset.action = 'hello-nexus-refresh';
    btn.textContent = 'Refresh';
    box.append(btn);

    host.replaceChildren(box);
  }

  async function load() {
    renderStatus('Loading…');
    try {
      const { data } = await N.api(ENDPOINT);
      renderData(data);
    } catch (err) {
      // A disabled plugin is a 404 by design; say which of the two happened.
      renderStatus(err.status === 404
        ? 'This plugin is not enabled on this server.'
        : `Could not reach the plugin: ${err.message}`);
    }
  }

  N.registerAction('hello-nexus-refresh', () => { void load(); });

  N.registerTab({
    id: TAB_ID,
    label: 'Hello',
    // Plugin tabs sit after the shell's own; 10..60 are taken by app.js.
    order: 900,
    render(section) {
      host = document.createElement('div');
      section.replaceChildren(host);
    },
    onShow() { void load(); },
  });
})();
