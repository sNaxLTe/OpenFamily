import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';

export interface UseComboboxSuggestionsOptions<T> {
    /** Raw input value; debounced before reaching `compute`. */
    query: string;
    /** Turns the debounced query into suggestions (see matchPrefixSuggestions). */
    compute: (debouncedQuery: string) => T[];
    /** Called with the picked suggestion; the list closes and focus stays in the field. */
    onSelect: (item: T) => void;
    /** id of the <ul role="listbox"> element. */
    listId: string;
    debounceMs?: number;
}

export interface ComboboxSuggestions<T> {
    suggestions: T[];
    /** True when the listbox should be rendered. */
    visible: boolean;
    activeIndex: number;
    listId: string;
    openList: () => void;
    closeList: () => void;
    onFocus: () => void;
    onBlur: () => void;
    onKeyDown: (e: ReactKeyboardEvent) => void;
    optionId: (index: number) => string;
    getOptionProps: (index: number) => {
        id: string;
        role: 'option';
        'aria-selected': boolean;
        onMouseDown: (e: ReactMouseEvent) => void;
        onMouseEnter: () => void;
    };
    inputAria: {
        role: 'combobox';
        'aria-expanded': boolean;
        'aria-controls': string;
        'aria-autocomplete': 'list';
        'aria-activedescendant': string | undefined;
    };
}

/**
 * Shared debounced-autocomplete behavior for combobox inputs (calendar title
 * B3, shopping add-item D3a): debounced query, ArrowUp/Down + Enter keyboard
 * navigation, and — while the list is open — a FIRST Escape that closes only
 * the list. Radix dialogs listen for Escape in the CAPTURE phase on `document`,
 * which fires before any React bubble handler, so the interception happens in
 * the capture phase on `window` (window capture runs before document capture):
 * that is what keeps the first Escape from closing the whole editor.
 */
export const useComboboxSuggestions = <T>(options: UseComboboxSuggestionsOptions<T>): ComboboxSuggestions<T> => {
    const { query, listId, debounceMs = 150 } = options;
    const [debouncedQuery, setDebouncedQuery] = useState(query);
    const [open, setOpen] = useState(false);
    const [focused, setFocused] = useState(false);
    const [activeIndex, setActiveIndex] = useState(0);

    useEffect(() => {
        const t = setTimeout(() => setDebouncedQuery(query), debounceMs);
        return () => clearTimeout(t);
    }, [query, debounceMs]);

    // Refs keep the callbacks stable without re-subscribing the Escape listener.
    const computeRef = useRef(options.compute);
    computeRef.current = options.compute;
    const onSelectRef = useRef(options.onSelect);
    onSelectRef.current = options.onSelect;

    const suggestions = computeRef.current(debouncedQuery);
    const visible = open && focused && suggestions.length > 0;

    useEffect(() => {
        if (visible) setActiveIndex(0);
    }, [visible]);

    useEffect(() => {
        if (!visible) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [visible]);

    const select = (item: T) => {
        onSelectRef.current(item);
        setOpen(false);
    };

    const onKeyDown = (e: ReactKeyboardEvent) => {
        if (!visible) return;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActiveIndex((i) => Math.min(i + 1, suggestions.length - 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActiveIndex((i) => Math.max(i - 1, 0));
        } else if (e.key === 'Enter') {
            e.preventDefault();
            select(suggestions[activeIndex]);
        }
        // Escape is NOT handled here: while the list is open it is intercepted
        // in the capture phase on window (effect above) and closes only the
        // list; once the list is closed, Escape reaches the dialog/overlay.
    };

    const optionId = (index: number) => `${listId}-opt-${index}`;
    const getOptionProps = (index: number) => ({
        id: optionId(index),
        role: 'option' as const,
        'aria-selected': index === activeIndex,
        // mousedown (not click) so the input's blur never fires first
        onMouseDown: (e: ReactMouseEvent) => {
            e.preventDefault();
            select(suggestions[index]);
        },
        onMouseEnter: () => setActiveIndex(index),
    });

    return {
        suggestions,
        visible,
        activeIndex,
        listId,
        openList: () => setOpen(true),
        closeList: () => setOpen(false),
        onFocus: () => {
            setFocused(true);
            setOpen(true);
        },
        onBlur: () => {
            setFocused(false);
            setOpen(false);
        },
        onKeyDown,
        optionId,
        getOptionProps,
        inputAria: {
            role: 'combobox',
            'aria-expanded': visible,
            'aria-controls': listId,
            'aria-autocomplete': 'list',
            'aria-activedescendant': visible ? optionId(activeIndex) : undefined,
        },
    };
};
