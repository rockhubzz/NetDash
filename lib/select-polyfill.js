/**
 * In-page replacement for native `<select>` dropdown popups.
 *
 * Why this exists: the device stream is rendered with CDP
 * `Page.startScreencast`, which captures the page surface only. Native
 * `<select>` option popups (also date/color picker popups) render on a
 * separate popup surface, so they never appear in the streamed frames -
 * clicking a dropdown looks like nothing happens. `Page.captureScreenshot`
 * with `fromSurface: true` proves the popup is open remotely; the screencast
 * just can't show it.
 *
 * This script intercepts interaction with single-choice `<select>` elements
 * (the ones that would open a popup), suppresses the native popup, and
 * renders the option list as plain DOM positioned under the select. DOM is
 * part of the page surface, so it shows up in the screencast, and option
 * clicks are ordinary DOM clicks that already work through the existing
 * mouse-event forwarding. The chosen value is written back to the real
 * `<select>` with `input`/`change` events so device UIs react normally.
 *
 * Multi-selects (`multiple`, `size > 1`) render inline and need no popup, so
 * they are left alone. Installed via `context.addInitScript`, which runs on
 * every navigation in every frame; event delegation means dynamically added
 * selects work without a MutationObserver.
 */
(() => {
  if (window.__remoteSelectPolyfillInstalled) return;
  window.__remoteSelectPolyfillInstalled = true;

  const PANEL_ATTR = 'data-remote-select-panel';
  const STYLE_ID = '__remote-select-polyfill-style';
  const HIGHLIGHT = '__remote-select-polyfill-highlight';

  // Init scripts run before the document element exists, so `document.head`
  // is still null here - create the stylesheet lazily on first use (and
  // opportunistically now, when the DOM is already present).
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const parent = document.head || document.documentElement;
    if (!parent) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      [${PANEL_ATTR}] {
        position: fixed; z-index: 2147483647;
        background: #fff; color: #111;
        border: 1px solid #6b7280; border-radius: 2px;
        box-shadow: 0 4px 16px rgba(0,0,0,.35);
        max-height: 240px; overflow-y: auto;
        font: 13px/1.5 -apple-system, "Segoe UI", Roboto, sans-serif;
        padding: 2px 0; margin: 0;
      }
      [${PANEL_ATTR}] [role="option"] {
        padding: 2px 8px; white-space: nowrap; overflow: hidden;
        text-overflow: ellipsis; cursor: default; user-select: none;
      }
      [${PANEL_ATTR}] [role="option"].${HIGHLIGHT} { background: #1a73e8; color: #fff; }
      [${PANEL_ATTR}] [role="option"][aria-selected="true"]:not(.${HIGHLIGHT}) { background: #e8f0fe; }
      [${PANEL_ATTR}] [role="option"][aria-disabled="true"] { color: #9ca3af; }
    `;
    parent.appendChild(style);
  }

  try {
    ensureStyle();
  } catch {
    // Document isn't ready yet - ensureStyle() runs again on first open.
  }

  let open = null; // { select, panel, highlightIndex, options }

  function isPopupSelect(el) {
    return (
      el &&
      el.tagName === 'SELECT' &&
      !el.disabled &&
      !el.multiple &&
      !(el.size > 1)
    );
  }

  function flatOptions(select) {
    // Keep optgroup structure out of the way: list every option in order.
    return Array.from(select.options);
  }

  function closePanel() {
    if (open) {
      open.panel.remove();
      open = null;
    }
  }

  function commitChoice(select, option) {
    if (option.disabled) return;
    if (select.value !== option.value) {
      select.value = option.value;
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    closePanel();
    // Return focus so keyboard users can keep tabbing naturally.
    try {
      select.focus({ preventScroll: true });
    } catch {
      // focus() with options throws on very old engines - plain call then.
      try {
        select.focus();
      } catch {
        // ignore
      }
    }
  }

  function paintHighlight() {
    if (!open) return;
    const items = open.panel.querySelectorAll('[role="option"]');
    items.forEach((item, i) => {
      item.classList.toggle(HIGHLIGHT, i === open.highlightIndex);
    });
    const current = items[open.highlightIndex];
    if (current) current.scrollIntoView({ block: 'nearest' });
  }

  function openPanel(select) {
    // Toggle when clicking the already-open select.
    if (open && open.select === select) {
      closePanel();
      return;
    }
    closePanel();

    const options = flatOptions(select);
    if (options.length === 0) return;
    if (!document.body) return;
    ensureStyle();

    const rect = select.getBoundingClientRect();
    const panel = document.createElement('div');
    panel.setAttribute(PANEL_ATTR, '');
    panel.setAttribute('role', 'listbox');

    const width = Math.max(Math.round(rect.width), 140);
    panel.style.left = `${Math.max(0, Math.min(Math.round(rect.left), window.innerWidth - width - 4))}px`;
    panel.style.width = `${width}px`;

    options.forEach((opt) => {
      const item = document.createElement('div');
      item.setAttribute('role', 'option');
      item.textContent = opt.label || opt.text || opt.value;
      item.dataset.value = opt.value;
      if (opt.disabled) item.setAttribute('aria-disabled', 'true');
      if (opt.selected) item.setAttribute('aria-selected', 'true');
      panel.appendChild(item);
    });

    panel.addEventListener('click', (e) => {
      const item = e.target && e.target.closest ? e.target.closest('[role="option"]') : null;
      if (!item || !open) return;
      const opt = options[Array.from(panel.children).indexOf(item)];
      if (opt) commitChoice(select, opt);
    });

    panel.addEventListener('mousemove', (e) => {
      const item = e.target && e.target.closest ? e.target.closest('[role="option"]') : null;
      if (!item || !open) return;
      const idx = Array.from(panel.children).indexOf(item);
      if (idx !== open.highlightIndex) {
        open.highlightIndex = idx;
        paintHighlight();
      }
    });

    document.body.appendChild(panel);

    // Place below the select; flip above when there is no room below.
    const height = Math.min(panel.offsetHeight || 200, 240);
    let top = rect.bottom + 2;
    if (top + height > window.innerHeight - 4) {
      top = Math.max(4, rect.top - height - 2);
    }
    panel.style.top = `${Math.round(top)}px`;
    panel.style.maxHeight = `${Math.max(80, Math.min(240, window.innerHeight - top - 4))}px`;

    open = {
      select,
      panel,
      highlightIndex: Math.max(
        0,
        options.findIndex((o) => o.selected)
      ),
      options,
    };
    paintHighlight();
  }

  // Suppress the native popup and show the DOM one instead. Capture phase
  // so this runs before page-level handlers; stopPropagation only for the
  // select itself so unrelated page behaviour is untouched.
  document.addEventListener(
    'mousedown',
    (e) => {
      if (open && e.target && e.target.closest && e.target.closest(`[${PANEL_ATTR}]`)) {
        // Clicks inside the option list must reach the panel's own
        // click/mousemove listeners - don't close prematurely.
        e.stopPropagation();
        return;
      }
      const sel = e.target && e.target.closest ? e.target.closest('select') : null;
      if (isPopupSelect(sel)) {
        e.preventDefault();
        e.stopPropagation();
        openPanel(sel);
        return;
      }
      if (open) closePanel();
    },
    true
  );

  // Keyboard: opening via Enter/Space/Arrow would show the invisible native
  // popup - open the DOM list instead; navigate while it is open.
  document.addEventListener('keydown', (e) => {
    const sel = e.target && e.target.closest ? e.target.closest('select') : null;
    if (open) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closePanel();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        const n = open.options.length;
        open.highlightIndex =
          (open.highlightIndex + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
        paintHighlight();
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        const opt = open.options[open.highlightIndex];
        if (opt) commitChoice(open.select, opt);
      }
      return;
    }
    if (
      isPopupSelect(sel) &&
      (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp')
    ) {
      e.preventDefault();
      e.stopPropagation();
      openPanel(sel);
    }
  });

  window.addEventListener('resize', closePanel, { passive: true });
  // A scrolling ancestor (or a navigation) invalidates the anchored
  // position - the user can simply reopen the list. The panel's own
  // overflow scrolling (keyboard navigation in long lists) must not close it.
  window.addEventListener(
    'scroll',
    (e) => {
      if (open && e.target && (e.target === open.panel || open.panel.contains(e.target))) return;
      closePanel();
    },
    { capture: true, passive: true }
  );
  document.addEventListener('focusin', (e) => {
    if (open && open.panel.contains(e.target)) return;
    const sel = e.target && e.target.closest ? e.target.closest('select') : null;
    if (!sel || sel !== open?.select) closePanel();
  });
})();
