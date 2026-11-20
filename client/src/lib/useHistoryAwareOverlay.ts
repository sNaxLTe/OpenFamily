import { useEffect, useRef } from 'react';

const OVERLAY_STATE_KEY = '__openfamilyOverlay';

/**
 * Makes an overlay (bottom sheet, dialog) history-aware.
 *
 * Opening the overlay pushes one history entry, so the browser back button /
 * the iOS swipe-back gesture CLOSES the overlay instead of leaving the app —
 * which is what happens in the standalone PWA, where the previous history
 * entry is outside the app. Closing the overlay via its X button or Escape
 * pops that entry again, leaving the history stack exactly as it was found.
 * (Below the overlay entry sit the router's own entries, so a real back
 * gesture lands on the same route the user was on: the sheet closes, the
 * page does not change.)
 *
 * Reusable pattern: `useHistoryAwareOverlay(open, close)` on any overlay.
 * This chantier wires it ONLY to the budget Sheet (budgetParts.tsx — covers
 * every sheet of the Budget module) and to the Calendar dialogs; extending
 * it app-wide is a separate chantier, out of this lot's scope.
 */
export const useHistoryAwareOverlay = (open: boolean, close: () => void): void => {
    // Stabilize `close` so the effect below does not re-run (and re-push) on
    // every render while the overlay is open.
    const closeRef = useRef(close);
    useEffect(() => {
        closeRef.current = close;
    });

    useEffect(() => {
        if (!open) return;
        history.pushState({ [OVERLAY_STATE_KEY]: true }, '');
        const onPopState = () => closeRef.current();
        window.addEventListener('popstate', onPopState);
        return () => {
            window.removeEventListener('popstate', onPopState);
            // Closing via X/Escape: our pushed entry is still on top of the
            // stack → pop it silently (the listener is already removed, so
            // this does not re-trigger onPopState). After a real back gesture
            // the entry is already gone → no-op.
            const state = history.state as Record<string, unknown> | null;
            if (state && state[OVERLAY_STATE_KEY]) history.back();
        };
    }, [open]);
};
