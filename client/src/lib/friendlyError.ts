import type { TFunction } from 'i18next';
import { ApiError } from './api';

/**
 * Maps a raw server error to a translated, user-facing message.
 *
 * Server validation errors are English technical strings — sometimes with a
 * column name, e.g. "paperless_document_id must be a positive integer or
 * null" — and must never be rendered verbatim to a French-speaking family.
 * Known messages map to dedicated i18n keys; anything else falls back to a
 * generic translated error.
 */
const KNOWN: Array<[RegExp, string]> = [
    [/^category, amount and date are required$/i, 'budget:errors.fieldsRequired'],
    [/^paperless_document_id must be/i, 'budget:errors.paperlessIdInvalid'],
    [/^Invalid reminder_(offset_days|time|overdue)$/i, 'tasks:errors.invalidReminder'],
];

export const friendlyApiError = (
    err: unknown,
    t: TFunction,
    fallbackKey = 'budget:errors.generic'
): string => {
    if (err instanceof ApiError || err instanceof Error) {
        const message = err.message ?? '';
        for (const [pattern, key] of KNOWN) {
            if (pattern.test(message)) return t(key);
        }
    }
    return t(fallbackKey);
};
