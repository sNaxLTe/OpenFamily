import { useEffect, useRef } from 'react';

const OVERLAY_STATE_KEY = '__openfamilyOverlay';
const OVERLAY_ID_KEY = '__openfamilyOverlayId';

/** The history state pushed by an overlay, carrying its unique id. */
export const makeOverlayState = (id: string): Record<string, unknown> => ({
    [OVERLAY_STATE_KEY]: true,
    [OVERLAY_ID_KEY]: id,
});

/** The overlay id carried by a history state, or null for non-overlay entries (router…). */
export const overlayStateId = (state: unknown): string | null => {
    if (state && typeof state === 'object') {
        const id = (state as Record<string, unknown>)[OVERLAY_ID_KEY];
        if (typeof id === 'string') return id;
    }
    return null;
};

/**
 * popstate rule: a back gesture pops exactly ONE history entry. An overlay must
 * close only if the entry popped was its own — i.e. the state we LANDED on no
 * longer carries our id. If it carries ANOTHER overlay's id, the pop was consumed
 * by the overlay stacked above us: this one stays open. This is what makes
 * stacked overlays (e.g. the Paperless picker sheet on top of the transaction
 * sheet) safe: closing or backing out of the top overlay never closes the one
 * below.
 */
export const shouldCloseOnPop = (myId: string, landedOnState: unknown): boolean =>
    overlayStateId(landedOnState) !== myId;

/**
 * Programmatic-close rule (X button / Escape): pop our own entry ONLY if it is
 * still the current one (nobody already popped it). The popstate this back()
 * triggers lands on the entry below; if that entry belongs to another overlay,
 * its own listener sees its id and stays open (shouldCloseOnPop) — so a
 * programmatic close never cascades into the overlays below.
 */
export const shouldPopOnClose = (myId: string, currentState: unknown): boolean =>
    overlayStateId(currentState) === myId;

/**
 * Makes an overlay (bottom sheet, dialog) history-aware.
 *
 * Opening the overlay pushes one history entry, so the browser back button /
 * the iOS swipe-back gesture CLOSES the overlay instead of leaving the app —
 * which is what happens in the standalone PWA, where the previous history
 * entry is outside the app. Closing the overlay via its X button or Escape
 * pops that entry again, leaving the history stack exactly as it was found.
 *
 * Stacking: several overlays may be open at once (each pushes its own entry).
 * A back gesture closes only the TOPMOST overlay; the ones below stay open
 * until their own entry is popped. See shouldCloseOnPop / shouldPopOnClose.
 *
 * Reusable pattern: `useHistoryAwareOverlay(open, close)` on any overlay.
 * Wired to the budget Sheet (budgetParts.tsx — covers every sheet of the
 * Budget module, including the Paperless picker sheet) and to the Calendar
 * dialogs; extending it app-wide is a separate chantier.
 */
export const useHistoryAwareOverlay = (open: boolean, close: () => void): void => {
    // Stabilize `close` so the effect below does not re-run (and re-push) on
    // every render while the overlay is open.
    const closeRef = useRef(close);
    useEffect(() => {
        closeRef.current = close;
    });

    const idRef = useRef<string | null>(null);

    useEffect(() => {
        if (!open) return;
        const id = `ovl-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        idRef.current = id;
        history.pushState(makeOverlayState(id), '');
        const onPopState = () => {
            if (idRef.current && shouldCloseOnPop(idRef.current, history.state)) {
                closeRef.current();
            }
        };
        window.addEventListener('popstate', onPopState);
        return () => {
            window.removeEventListener('popstate', onPopState);
            // X / Escape close: pop our entry only if still on top. Our listener
            // is already removed, and the pop lands on the entry below — an
            // overlay below sees its OWN id there and stays open.
            if (idRef.current && shouldPopOnClose(idRef.current, history.state)) {
                history.back();
            }
            idRef.current = null;
        };
    }, [open]);
};
