// Focus-trap hook for modal dialogs (issue #177).
//
// Applied to a dialog's root element, this hook delivers the four keyboard
// behaviors a screen-reader user expects from a modal:
//   1. On open, focus moves to the first focusable element inside the dialog.
//   2. Tab / Shift+Tab cycle within the dialog (focus cannot escape to the
//      page behind the modal).
//   3. Escape closes the dialog (via the supplied `onClose`).
//   4. On close, focus returns to the element that was focused before the
//      dialog opened (typically the toolbar button that triggered it).
//
// Usage:
//   const ref = useRef<HTMLDivElement>(null);
//   useFocusTrap(ref, onClose);
//   return <div ref={ref} role="dialog" aria-modal="true">...</div>;
//
// The hook is intentionally framework-light (no context, no portal) so it can
// be dropped into the many existing hand-rolled dialogs without restructuring
// them.
//
// Nested dialogs (#177 review M1): when dialog B opens on top of dialog A,
// the two dialogs live under independent backdrops and are NOT nested in the
// DOM. A per-container keydown listener alone would leave both traps live and
// fighting over Tab. To fix this each trap registers itself on a module-level
// stack on mount and pops on unmount; only the top-of-stack trap performs Tab
// / Escape handling — others become inert no-ops until they regain the top.

import { useEffect, type RefObject } from "react";

// Elements that can receive keyboard focus. `[tabindex]:not([tabindex="-1"])`
// covers custom focusables; the disabled / hidden filters run at query time.
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/** Collect the visible, focusable descendants of `container` in DOM order. */
export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  const nodes = Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  );
  return nodes.filter((el) => {
    if (el.hasAttribute("disabled")) return false;
    if (el.getAttribute("aria-hidden") === "true") return false;
    // offsetParent is null for display:none elements (and fixed-position ones,
    // but dialogs don't nest those as focusables in this codebase).
    return el.offsetParent !== null || el === document.activeElement;
  });
}

// Module-level stack of active traps. The last entry is the front-most
// (most-recently-mounted) dialog; only it handles keyboard events.
const trapStack: object[] = [];

/**
 * Trap keyboard focus inside the element referenced by `containerRef` while it
 * is mounted. `onClose` is invoked on Escape. `enabled` lets a caller keep the
 * hook mounted but inert (defaults to true).
 */
export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  enabled: boolean = true,
): void {
  useEffect(() => {
    if (!enabled) return;
    const container = containerRef.current;
    if (!container) return;

    // Identity token for this trap's position in the stack.
    const token = {};
    trapStack.push(token);

    // Only the front-most (top-of-stack) trap acts on keyboard events. A
    // nested dialog opened on top pushes a new token; this trap then goes
    // inert until that dialog unmounts and pops its token back off.
    const isTopMost = () => trapStack[trapStack.length - 1] === token;

    // Remember who had focus so we can restore it on unmount.
    const previouslyFocused = document.activeElement as HTMLElement | null;

    // Move focus inside the dialog. Prefer the first focusable element; fall
    // back to the container itself (must be programmatically focusable).
    const initialFocusables = getFocusableElements(container);
    if (initialFocusables.length > 0) {
      initialFocusables[0].focus();
    } else {
      if (!container.hasAttribute("tabindex")) {
        container.setAttribute("tabindex", "-1");
      }
      container.focus();
    }

    const onKeyDown = (e: KeyboardEvent) => {
      // Inert while a nested dialog is on top — let its trap handle it.
      if (!isTopMost()) return;

      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;

      const focusables = getFocusableElements(container);
      if (focusables.length === 0) {
        // Nothing focusable inside — keep focus pinned on the container.
        e.preventDefault();
        container.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;

      if (e.shiftKey) {
        // Shift+Tab from the first element wraps to the last.
        if (active === first || !container.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        // Tab from the last element wraps to the first.
        if (active === last || !container.contains(active)) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    container.addEventListener("keydown", onKeyDown);

    return () => {
      container.removeEventListener("keydown", onKeyDown);
      // Pop this trap off the stack — the dialog below (if any) becomes the
      // front-most active trap again.
      const idx = trapStack.lastIndexOf(token);
      if (idx !== -1) trapStack.splice(idx, 1);
      // Restore focus to the trigger element if it is still in the document.
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
  }, [containerRef, onClose, enabled]);
}
