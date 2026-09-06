# Plugins

A plugin adds behaviour that is specific to one event without forking the services. It can
listen to domain events, mount a few routes, and ship client scripts that register a tab or
a HUD widget. It is deliberately small.

## The trust model

**A plugin is first-party code.** It lives in this repository or in a content pack, it is
read and reviewed the way core code is read and reviewed, and it is enabled by the people
running the event. There is no plugin marketplace, no remote loading, and no way to point
the server at a URL and have it run what comes back.

That single decision is what makes the rest of the design simple. Because plugin code is
trusted, hooks run in-process, on the same event loop, with the same database handles as
everything else. Isolating trusted code in a worker would cost real complexity and buy
nothing: a plugin that wanted to misbehave could equally well be a bad patch to a service.

The boundaries that remain are the ones that protect the event from a *buggy* plugin
rather than a hostile one:

* A hook that throws, or takes longer than two seconds, fails that hook only. The domain
  operation has already been committed by the time hooks run.
* Five consecutive failures disable the plugin. A `PLUGIN_DISABLED` event goes out on the
  ops channel so somebody sees it.
* A disabled plugin's routes and assets both return 404, and the manifest stops listing it.
  Express cannot unmount a router at runtime, so every plugin route and every plugin asset
  path runs through the same `registry.enabled(name)` guard rather than being removed.

**Untrusted content does not become a plugin.** If you want to embed a sponsor's widget or
anything else you have not read, use the sandboxed iframe slot described at the end of this
page. Do not enable it as a plugin.

## Activation

The registry knows every plugin by static import, so `tsc` type-checks all of them whether
or not they run. Which ones are *active* is configuration: the content pack's `event.json`
lists the plugins the event wants under `plugins`, and the deployment can narrow that
further. A plugin that is not active is inert, and its routes and assets do not exist.

## The hooks

Hooks fire after the database write, on the domain bus, and never inside the transaction.
They cannot veto anything. This is the whole list:

| Hook | Fires when |
|---|---|
| `onCheckIn` | a volunteer's attendance is verified |
| `onRegistration` | someone is registered for a shift |
| `onSOSResolved` | an SOS ticket reaches `RESOLVED` |
| `onGymCaptured` | a territory changes faction |
| `onSpin` | a HackStop spin pays out |

A hook receives the resulting document and returns a promise. If you need to react to
something not on this list, add a hook to the bus in a reviewed change rather than reaching
into a service from a plugin.

## Server routes

A plugin may mount routes under `/api/v1/plugins/<name>`. They sit behind the same identity
middleware and the same rate limiter as core routes, they are restricted to an allow-listed
set of methods, and they answer 404 while the plugin is disabled. Nothing about a plugin
route is exempt from the rules in [IDENTITY.md](IDENTITY.md): the session cookie is still
the only identity, and a cookie-authenticated mutation still needs its CSRF nonce.

## Client assets, and how they are pinned

There is one path and one manifest.

Every plugin's client files are served same-origin under `/dashboard/plugins/<name>/`,
whether the plugin lives in the repository or in the content pack. `GET /api/v1/plugins` is
the single manifest:

```json
[{ "name": "hello-nexus", "version": "1.0.0", "assets": [{ "url": "/dashboard/plugins/hello-nexus/hello.js", "sha256": "…" }] }]
```

`public/plugins.js` reads that manifest and injects one `<script>` per asset carrying
`integrity="sha256-…"` from it. The hash is computed by the server over the bytes it will
serve. If the file on disk and the hash in the manifest disagree, the browser refuses to
run the script and `plugins.js` logs `PLUGIN_ASSET_MISMATCH`. A stale cached copy fails the
same way. This is why plugin scripts are the only scripts the page loads that it did not
ship with.

The Content Security Policy is unchanged for plugins: `script-src 'self'`, no inline
handlers, no external origins. A plugin script is a plain browser script under the same
rules as `app.js`.

## What a client plugin can register

The shell exposes a small registry on `window.Nexus`. A plugin script uses it and nothing
else:

* `Nexus.registerTab({id, label, roles, order, render})` adds a tab. `roles` decides who
  sees it, and a tab the current role cannot see is never put in the DOM.
* `Nexus.registerAction(name, handler)` claims `data-action="<name>"`. The last
  registration wins and the previous handler is returned, so an override can chain.
* `Nexus.registerSticker(item)` and `Nexus.registerItemRenderer(kind, fn)` extend the
  sticker book.
* `Nexus.registerHudWidget({id, corner, render, tick})` mounts a box over the campus
  canvas. `tick` is throttled to 2 Hz, so a widget cannot become the frame-rate problem.
* `Nexus.onEvent(channel, fn)` subscribes to the live channels.

Escape everything you inject into HTML. A plugin runs with the page's full privileges, and
the review that lets it do so assumes you did.

## The sandboxed slot for untrusted embeds

For content you have not reviewed, the shell offers an iframe slot instead. The frame is
`sandbox="allow-scripts"` **without** `allow-same-origin`, so it has an opaque origin: no
cookies, no access to the page's DOM, no fetches carrying the session. It communicates only
by `postMessage`, and the host side validates every message against a small schema and
drops anything it does not recognise.

This is strictly less capable than a plugin. It cannot register a tab, it cannot draw on
the campus canvas, and it cannot read anything about the person looking at it. That is the
point.
