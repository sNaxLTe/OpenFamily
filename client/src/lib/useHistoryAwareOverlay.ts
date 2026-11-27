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

export interface OverlayOptions {
    /**
     * Default true: a back/swipe-back popstate CLOSES the overlay.
     * When false (editing overlays with unsaved input), the pop is CONSUMED
     * silently — the overlay's history entry is immediately re-pushed — and
     * the overlay stays open. Escape and the X / explicit buttons still close.
     */
    closeOnPop?: boolean;
}

/**
 * What a popstate should do for overlay `myId` landing on `landedOnState`:
 * - 'none'    the popped entry was not ours (another overlay's) — ignore;
 * - 'close'   the pop was ours and the overlay is dismissible — close;
 * - 'consume' the pop was ours but the overlay is protected (editing) —
 *             re-push our entry, stay open.
 */
export const resolvePopAction = (
    myId: string,
    landedOnState: unknown,
    closeOnPop: boolean
): 'none' | 'close' | 'consume' => {
    if (!shouldCloseOnPop(myId, landedOnState)) return 'none';
    return closeOnPop ? 'close' : 'consume';
};

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
 * Reusable pattern: `useHistoryAwareOverlay(open, close, options?)` on any
 * overlay. The Dialog and Sheet components wire it themselves, so every
 * surface inherits it — pass `dismissible={false}` on an editing overlay
 * (unsaved input) to also consume back/swipe-back silently instead of
 * closing: the pop is swallowed by re-pushing our entry. Escape and explicit
 * buttons (X, "Annuler", …) keep closing as usual.
 */
export const useHistoryAwareOverlay = (
    open: boolean,
    close: () => void,
    options?: OverlayOptions
): void => {
    // Stabilize `close` and `options` so the effect below does not re-run (and
    // re-push) on every render while the overlay is open.
    const closeRef = useRef(close);
    const optionsRef = useRef(options);
    useEffect(() => {
        closeRef.current = close;
        optionsRef.current = options;
    });

    const idRef = useRef<string | null>(null);

    useEffect(() => {
        if (!open) return;
        const id = `ovl-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        idRef.current = id;
        history.pushState(makeOverlayState(id), '');
        const onPopState = () => {
            if (!idRef.current) return;
            const action = resolvePopAction(
                idRef.current,
                history.state,
                optionsRef.current?.closeOnPop ?? true
            );
            if (action === 'close') {
                closeRef.current();
            } else if (action === 'consume') {
                // Protected overlay (editing): swallow the back/swipe-back by
                // restoring our entry — the overlay stays open.
                history.pushState(makeOverlayState(idRef.current), '');
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
