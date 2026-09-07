/**
 * Pixel dropdowns, because the operating system will not draw ours.
 *
 * A native `<select>` renders its open popup in the OS, not the page. On macOS that is a
 * rounded translucent sheet with a system-blue-turned-green highlight and a checkmark glyph, and
 * **no CSS can touch any of it** — not the font, not the corners, not the colours. So a
 * dashboard that is otherwise 2 px borders, hard offset shadows and Silkscreen opens a menu that
 * looks like it came from a different application, which is exactly what it is.
 *
 * The fix is a real listbox we own. The rules it follows:
 *
 *   1. **The `<select>` stays.** It keeps its `name`, its `value` and its place in
 *      `form.elements`, so `form.elements.audience.value` and `new FormData(form)` are unchanged
 *      and every existing `change` listener still fires with `event.target` being the select.
 *      Nothing that reads these controls had to be edited for this to work.
 *   2. **Enhancement, not replacement.** With this file absent the page still works; you simply
 *      get the OS menu back. Nothing here is load-bearing for correctness.
 *   3. **Keyboard parity or it is not a control.** Enter/Space to open, arrows and Home/End to
 *      move, Enter to take, Escape to abandon, Tab to leave, and type-ahead — the same set the
 *      native control gives, because a volunteer running the desk on a laptop should not have to
 *      reach for the trackpad.
 *
 * Views render their markup whenever a tab is opened, so enhancement is driven by a
 * `MutationObserver` over the document rather than by a call at boot: a `<select class="pb">` is
 * upgraded whenever it appears, and `lead.js` rewriting the shift picker's `<option>`s is
 * noticed and repainted without that file knowing this one exists.
 */
(function () {
  'use strict';

  /** Enhanced already, or being enhanced. Marked on the select so a repaint cannot double-wrap. */
  const DONE = 'pxselDone';

  const isOpen = (root) => root.dataset.open === '1';

  /**
   * Build the button + listbox for one `<select>`, and keep the two in step.
   *
   * The select is hidden rather than removed: see the note at the top of the file. It is also
   * left `aria-hidden` and out of the tab order, because the button in front of it carries the
   * accessible name and the `combobox` role, and two focusable controls for one value is a worse
   * experience than none.
   */
  function enhance(select) {
    if (select.dataset[DONE]) return;
    select.dataset[DONE] = '1';

    const root = document.createElement('div');
    root.className = 'pxsel';
    const listId = `pxsel-list-${Math.random().toString(36).slice(2, 8)}`;

    const button = document.createElement('button');
    button.type = 'button';
    // Inherit the select's own look: `.pb`, `.pb-ghost`, `.pb-sm` all carry over, so a dropdown
    // styled as a ghost button stays a ghost button.
    button.className = `pxsel-btn ${select.className}`.trim();
    button.setAttribute('role', 'combobox');
    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-controls', listId);

    // The accessible name follows the control the user can actually reach. A `<label for>`
    // pointing at the hidden select would name nothing, so it is re-pointed at the button.
    const label = select.id ? document.querySelector(`label[for="${CSS.escape(select.id)}"]`) : null;
    if (select.getAttribute('aria-label')) button.setAttribute('aria-label', select.getAttribute('aria-label'));
    if (label) {
      if (!label.id) label.id = `${listId}-label`;
      button.setAttribute('aria-labelledby', label.id);
      label.addEventListener('click', () => button.focus());
    }

    const value = document.createElement('span');
    value.className = 'pxsel-value';
    const caret = document.createElement('span');
    caret.className = 'pxsel-caret';
    caret.setAttribute('aria-hidden', 'true');
    button.append(value, caret);

    const list = document.createElement('ul');
    list.className = 'pxsel-list';
    list.id = listId;
    list.setAttribute('role', 'listbox');
    list.hidden = true;

    select.parentNode.insertBefore(root, select);
    root.append(button, list, select);
    select.classList.add('pxsel-native');
    select.setAttribute('aria-hidden', 'true');
    select.tabIndex = -1;

    /** Index of the option the keyboard is on, which is not always the chosen one. */
    let active = -1;

    function options() {
      return Array.from(list.children);
    }

    /** Mirror the `<select>`'s options into the listbox. Called on build and on every repaint. */
    function sync() {
      list.textContent = '';
      Array.from(select.options).forEach((opt, i) => {
        const li = document.createElement('li');
        li.className = 'pxsel-opt';
        li.id = `${listId}-o${i}`;
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', String(opt.selected));
        li.dataset.value = opt.value;
        if (opt.disabled) li.setAttribute('aria-disabled', 'true');
        // A marker column, so the chosen row is legible without relying on colour alone.
        const mark = document.createElement('span');
        mark.className = 'pxsel-mark';
        mark.setAttribute('aria-hidden', 'true');
        mark.textContent = opt.selected ? '▸' : '';
        const text = document.createElement('span');
        text.className = 'pxsel-text';
        text.textContent = opt.textContent;
        li.append(mark, text);
        list.append(li);
      });
      value.textContent = select.selectedOptions[0]?.textContent ?? '';
      active = select.selectedIndex;
    }

    function paintActive() {
      options().forEach((li, i) => li.classList.toggle('is-active', i === active));
      const current = options()[active];
      if (current) {
        button.setAttribute('aria-activedescendant', current.id);
        current.scrollIntoView({ block: 'nearest' });
      } else {
        button.removeAttribute('aria-activedescendant');
      }
    }

    function open() {
      if (isOpen(root)) return;
      // One at a time. Two open menus is a state the native control cannot reach, and a stray
      // one left behind a programmatic `.click()` is confusing rather than merely untidy.
      document.querySelectorAll('.pxsel[data-open="1"]').forEach((other) => {
        if (other !== root) other.querySelector('.pxsel-btn')?.dispatchEvent(new CustomEvent('pxsel:close'));
      });
      root.dataset.open = '1';
      list.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      active = select.selectedIndex;
      paintActive();
      // Opened downward by default; flipped up when there is not room, so a picker near the
      // bottom of a long panel does not run off the page.
      const room = window.innerHeight - button.getBoundingClientRect().bottom;
      root.classList.toggle('drop-up', room < Math.min(list.scrollHeight + 16, 260));
    }

    function close(refocus) {
      if (!isOpen(root)) return;
      delete root.dataset.open;
      list.hidden = true;
      button.setAttribute('aria-expanded', 'false');
      button.removeAttribute('aria-activedescendant');
      root.classList.remove('drop-up');
      if (refocus) button.focus();
    }

    /**
     * Take the option at `i`.
     *
     * The `change` event is dispatched **on the select**, so listeners written against the
     * native control — `sos.js` matches on `event.target.id` — see exactly what they saw before.
     */
    function choose(i) {
      const opt = select.options[i];
      if (!opt || opt.disabled) return;
      const changed = select.selectedIndex !== i;
      select.selectedIndex = i;
      sync();
      if (changed) select.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function move(delta) {
      const total = select.options.length;
      if (!total) return;
      let next = active;
      for (let step = 0; step < total; step += 1) {
        next = (next + delta + total) % total;
        if (!select.options[next].disabled) break;
      }
      active = next;
      paintActive();
    }

    button.addEventListener('click', () => (isOpen(root) ? close(false) : open()));
    button.addEventListener('pxsel:close', () => close(false));

    button.addEventListener('keydown', (e) => {
      switch (e.key) {
        case 'ArrowDown': case 'ArrowUp':
          e.preventDefault();
          if (!isOpen(root)) { open(); return; }
          move(e.key === 'ArrowDown' ? 1 : -1);
          return;
        case 'Home': case 'End':
          if (!isOpen(root)) return;
          e.preventDefault();
          active = e.key === 'Home' ? -1 : select.options.length;
          move(e.key === 'Home' ? 1 : -1);
          return;
        case 'Enter': case ' ':
          e.preventDefault();
          if (!isOpen(root)) { open(); return; }
          choose(active);
          close(true);
          return;
        case 'Escape':
          if (isOpen(root)) { e.preventDefault(); close(true); }
          return;
        case 'Tab':
          close(false);
          return;
        default:
          break;
      }
      // Type-ahead: a single printable character jumps to the next option starting with it,
      // which is how the native control behaves and how anybody used to one will try to drive it.
      if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const needle = e.key.toLowerCase();
        const total = select.options.length;
        for (let step = 1; step <= total; step += 1) {
          const i = ((active < 0 ? 0 : active) + step) % total;
          if ((select.options[i].textContent || '').trim().toLowerCase().startsWith(needle)) {
            active = i;
            if (isOpen(root)) paintActive(); else choose(i);
            return;
          }
        }
      }
    });

    list.addEventListener('mousedown', (e) => {
      // `mousedown`, not `click`: the button would otherwise take focus back and close the list
      // out from under the press.
      const li = e.target.closest('.pxsel-opt');
      if (!li || li.getAttribute('aria-disabled') === 'true') return;
      e.preventDefault();
      choose(options().indexOf(li));
      close(true);
    });

    list.addEventListener('mousemove', (e) => {
      const li = e.target.closest('.pxsel-opt');
      if (!li) return;
      active = options().indexOf(li);
      paintActive();
    });

    document.addEventListener('mousedown', (e) => {
      if (!root.contains(e.target)) close(false);
    });

    // The owning view repainted its `<option>`s — `lead.js` does this for the shift picker every
    // poll — so re-read them. Without this the list would keep showing the shifts from boot.
    new MutationObserver(() => { if (!isOpen(root)) sync(); }).observe(select, { childList: true, subtree: true });

    sync();
  }

  function enhanceAll(root) {
    const scope = root && root.querySelectorAll ? root : document;
    scope.querySelectorAll('select.pb').forEach(enhance);
  }

  // Views render on tab open, so watch for selects arriving rather than assuming they are all
  // present at boot.
  new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches?.('select.pb')) enhance(node);
        else enhanceAll(node);
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => enhanceAll(document));
  } else {
    enhanceAll(document);
  }
})();
