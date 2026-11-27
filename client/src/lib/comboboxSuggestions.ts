import { foldText } from './textSearch';

export interface PrefixSuggestionOptions<T> {
    /** Raw input value; matching is prefix, case- and accent-insensitive. */
    query: string;
    items: readonly T[];
    /** Text matched against the query (title, item name, ...). */
    getText: (item: T) => string;
    /** Extra predicate (recency cutoff, exclude the record being edited, ...). */
    filter?: (item: T) => boolean;
    /** Order of the pool before matching: most relevant first wins. */
    compare?: (a: T, b: T) => number;
    /** Dedupe key — items sharing a key collapse, the first one kept. Default: folded text. */
    getKey?: (item: T) => string;
    /** Minimum folded query length to suggest anything. Default 2. */
    minLength?: number;
    /** Maximum suggestions returned. Default 6. */
    limit?: number;
}

/**
 * Debounced-combobox source matcher: prefix match on folded text, deduped,
 * capped. Pure so both the calendar title field and the shopping add-item
 * field share one behavior (B3/D3a).
 */
export const matchPrefixSuggestions = <T>(options: PrefixSuggestionOptions<T>): T[] => {
    const { items, getText } = options;
    const query = foldText(options.query);
    if (query.length < (options.minLength ?? 2)) return [];

    const limit = options.limit ?? 6;
    const getKey = options.getKey ?? ((item: T) => foldText(getText(item)));
    const pool = options.filter ? items.filter(options.filter) : [...items];
    if (options.compare) pool.sort(options.compare);

    const seen = new Set<string>();
    const out: T[] = [];
    for (const item of pool) {
        const text = getText(item);
        if (!text || !foldText(text).startsWith(query)) continue;
        const key = getKey(item);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(item);
        if (out.length >= limit) break;
    }
    return out;
};
