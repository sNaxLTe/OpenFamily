import { describe, expect, it } from 'vitest';
import {
    makeOverlayState,
    overlayStateId,
    shouldCloseOnPop,
    shouldPopOnClose,
} from './useHistoryAwareOverlay';

// Unit tests for the DECISION LOGIC of useHistoryAwareOverlay (the hook itself
// needs a DOM; the rules below are what make stacked overlays safe).
// Run from the repo root: npx vitest run client/src/lib/useHistoryAwareOverlay.test.ts

const ROUTER = { someRouterState: true }; // a non-overlay history entry

describe('useHistoryAwareOverlay — decision logic', () => {
    it('overlayStateId reads the id, null for router/null states', () => {
        expect(overlayStateId(makeOverlayState('A'))).toBe('A');
        expect(overlayStateId(ROUTER)).toBeNull();
        expect(overlayStateId(null)).toBeNull();
        expect(overlayStateId('whatever')).toBeNull();
    });

    it('single overlay + user back (lands on router): closes, and must not pop again', () => {
        expect(shouldCloseOnPop('A', ROUTER)).toBe(true);
        expect(shouldPopOnClose('A', ROUTER)).toBe(false);
    });

    it('REGRESSION — stacked overlays, top closes programmatically: the one below stays open', () => {
        // History: [router, A, B] — B (picker) closes via X/pick: B pops itself,
        // the popstate lands on A's entry.
        const stack: Array<Record<string, unknown>> = [ROUTER];
        const push = (id: string) => stack.push(makeOverlayState(id));
        const back = () => { stack.pop(); };
        const current = () => stack[stack.length - 1];

        push('A'); // transaction sheet
        push('B'); // paperless picker sheet on top

        // B's cleanup: its entry is still on top → it pops itself…
        expect(shouldPopOnClose('B', current())).toBe(true);
        back(); // …the popstate lands on A
        // …and the still-mounted listener of A must NOT close (the old code did):
        expect(shouldCloseOnPop('A', current())).toBe(false);
        expect(overlayStateId(current())).toBe('A');
        // B is the overlay whose entry was consumed by that pop:
        expect(shouldCloseOnPop('B', current())).toBe(true);
        // A's entry is still current: if A closed programmatically NOW, it would
        // pop its own entry (and land on the router) — correct behaviour:
        expect(shouldPopOnClose('A', current())).toBe(true);
    });

    it('stacked overlays + user back once: only the topmost (B) closes, then A on the next back', () => {
        const stack: Array<Record<string, unknown>> = [ROUTER];
        const push = (id: string) => stack.push(makeOverlayState(id));
        const back = () => { stack.pop(); };
        const current = () => stack[stack.length - 1];

        push('A');
        push('B');
        back(); // user swipe-back: lands on A
        expect(shouldCloseOnPop('B', current())).toBe(true);  // top overlay closes
        expect(shouldCloseOnPop('A', current())).toBe(false); // below stays open
        expect(shouldPopOnClose('B', current())).toBe(false);  // already popped, no double-back
        back(); // second swipe-back: lands on router
        expect(shouldCloseOnPop('A', current())).toBe(true);
    });

    it('closing the lower overlay while the top is still open must not pop the top entry', () => {
        expect(shouldPopOnClose('A', makeOverlayState('B'))).toBe(false);
    });
});
