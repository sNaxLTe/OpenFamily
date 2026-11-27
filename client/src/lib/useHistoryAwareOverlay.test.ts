import { describe, expect, it } from 'vitest';
import {
    makeOverlayState,
    overlayStateId,
    resolvePopAction,
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

describe('resolvePopAction — closeOnPop option (B1: anti-accidental-close)', () => {
    it('default (closeOnPop=true) keeps the historical behaviour: pop closes', () => {
        expect(resolvePopAction('A', ROUTER, true)).toBe('close');
        expect(resolvePopAction('A', makeOverlayState('B'), true)).toBe('close');
        expect(resolvePopAction('A', makeOverlayState('A'), true)).toBe('none');
    });

    it('protected overlay (closeOnPop=false): a back landing away is CONSUMED, not closed', () => {
        // Single protected overlay, user swipe-back lands on the router entry:
        expect(resolvePopAction('A', ROUTER, false)).toBe('consume');
        // The hook then re-pushes A's entry, so the next popstate sees the same
        // situation and consumes again — the overlay never closes via back.
        expect(resolvePopAction('A', makeOverlayState('A'), false)).toBe('none');
    });

    it('REGRESSION iOS swipe-back — stacked protected overlays: each back consumes, nothing closes', () => {
        const stack: Array<Record<string, unknown>> = [ROUTER];
        const push = (id: string) => stack.push(makeOverlayState(id));
        const back = () => { stack.pop(); };
        const current = () => stack[stack.length - 1];

        push('A'); // editing sheet (protected)
        push('B'); // picker on top (dismissible)

        back(); // swipe-back pops B's entry, lands on A
        expect(resolvePopAction('B', current(), true)).toBe('close');   // B closes (dismissible)
        expect(resolvePopAction('A', current(), false)).toBe('none');    // A stays (its own entry)

        back(); // second swipe-back would land on router
        expect(resolvePopAction('A', ROUTER, false)).toBe('consume');    // A protected: consumed
        // after the consume, the hook re-pushes A:
        push('A');
        expect(overlayStateId(current())).toBe('A');
        // A can still be closed explicitly afterwards: its entry is on top → pop once, no cascade
        expect(shouldPopOnClose('A', current())).toBe(true);
    });

    it('protected overlay alone + back: consume, and explicit close still pops exactly one entry', () => {
        const stack: Array<Record<string, unknown>> = [ROUTER];
        stack.push(makeOverlayState('A'));
        stack.pop(); // the back
        expect(resolvePopAction('A', ROUTER, false)).toBe('consume');
        stack.push(makeOverlayState('A')); // hook re-push after consume
        expect(shouldPopOnClose('A', stack[stack.length - 1])).toBe(true); // X close → single back
    });
});
