import { describe, expect, it } from 'vitest';
import { matchPrefixSuggestions } from './comboboxSuggestions';

// Run from the repo root: npx vitest run client/src/lib/comboboxSuggestions.test.ts

type Row = { id: string; name: string; created_at?: string };

const rows: Row[] = [
    { id: '1', name: 'Lait', created_at: '2026-11-20T10:00:00Z' },
    { id: '2', name: 'lait demi-écrémé', created_at: '2026-11-25T10:00:00Z' },
    { id: '3', name: 'Pain', created_at: '2026-11-01T10:00:00Z' },
    { id: '4', name: 'Œufs', created_at: '2026-11-26T10:00:00Z' },
    { id: '5', name: 'lait', created_at: '2026-10-01T10:00:00Z' }, // duplicate name, older
];

describe('matchPrefixSuggestions', () => {
    it('prefix match, case- and accent-insensitive', () => {
        const out = matchPrefixSuggestions({ query: 'LA', items: rows, getText: (r) => r.name });
        expect(out.map((r) => r.id)).toEqual(['1', '2']); // "Lait", "lait demi-écrémé" — not "Pain"/"Œufs"
        const eggs = matchPrefixSuggestions({ query: 'oeu', items: rows, getText: (r) => r.name });
        expect(eggs.map((r) => r.id)).toEqual(['4']); // foldText folds Œ -> oe
    });

    it('minLength 2 by default: 0 or 1 char suggests nothing', () => {
        expect(matchPrefixSuggestions({ query: '', items: rows, getText: (r) => r.name })).toEqual([]);
        expect(matchPrefixSuggestions({ query: 'l', items: rows, getText: (r) => r.name })).toEqual([]);
        // the query is folded AND trimmed, so ' la ' still has length 2
        expect(matchPrefixSuggestions({ query: ' la ', items: rows, getText: (r) => r.name }).length).toBeGreaterThan(0);
    });

    it('dedupes by folded text, keeping the first item of the pool order', () => {
        const out = matchPrefixSuggestions({ query: 'lait', items: rows, getText: (r) => r.name });
        expect(out.map((r) => r.id)).toEqual(['1', '2']); // id 5 "lait" collapses into folded "lait" of id 1
    });

    it('custom getKey dedupes on something else (e.g. lowercased name, not folded)', () => {
        const out = matchPrefixSuggestions({
            query: 'lait',
            items: rows,
            getText: (r) => r.name,
            getKey: (r) => r.name.toLowerCase(),
        });
        // "Lait"/"lait" share key "lait"; "lait demi-écrémé" has its own key
        expect(out.map((r) => r.id)).toEqual(['1', '2']);
    });

    it('applies filter before matching and compare to order the pool', () => {
        const out = matchPrefixSuggestions({
            query: 'lait',
            items: rows,
            getText: (r) => r.name,
            filter: (r) => r.id !== '1',
            compare: (a, b) => String(b.created_at).localeCompare(String(a.created_at)),
        });
        expect(out.map((r) => r.id)).toEqual(['2', '5']); // most recent first, id 1 excluded
    });

    it('caps at limit (default 6)', () => {
        const many: Row[] = Array.from({ length: 20 }, (_, i) => ({ id: String(i), name: `item ${i}` }));
        expect(matchPrefixSuggestions({ query: 'it', items: many, getText: (r) => r.name }).length).toBe(6);
        expect(matchPrefixSuggestions({ query: 'it', items: many, getText: (r) => r.name, limit: 3 }).length).toBe(3);
    });

    it('empty text never matches', () => {
        const out = matchPrefixSuggestions({ query: 'x', items: [{ id: 'e', name: '' }], getText: (r) => r.name });
        expect(out).toEqual([]);
    });
});
