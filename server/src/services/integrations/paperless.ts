// Paperless-ngx → Budget bridge (fonctionnalité 13).
//
// Server-side ONLY: PAPERLESS_URL and PAPERLESS_TOKEN come from the server's
// environment (never committed, never sent to the client bundle — the client
// only talks to the /api/budget/paperless/* proxy routes). The token is used
// in the Authorization header of outbound calls and is NEVER logged.
//
// STRICTLY READ-ONLY towards Paperless: this module only ever issues GET
// requests (the test suite asserts it on a mocked fetcher). OpenFamily never
// creates, edits or deletes a Paperless document.
//
// Outbound calls go through safeFetch (redirect hops re-validated against the
// SSRF guard; metadata endpoints always blocked; LAN targets allowed because
// Paperless is self-hosted) with a hard timeout and a capped body.

import { safeFetch, readCappedText } from '../../lib/safeFetch';

const PAPERLESS_TIMEOUT_MS = 10_000;
// OCR text can be long; 1 MB is far more than any invoice needs.
const MAX_BODY_BYTES = 1_000_000;

export interface PaperlessConfig {
    baseUrl: string;
    token: string;
}

/** Reads the env at CALL time (tests set/unset it per case). Returns null when unconfigured. */
export const paperlessConfig = (): PaperlessConfig | null => {
    const rawUrl = (process.env.PAPERLESS_URL ?? '').trim().replace(/\/+$/, '');
    const token = (process.env.PAPERLESS_TOKEN ?? '').trim();
    if (!rawUrl || !token) return null;
    if (!/^https?:\/\//i.test(rawUrl)) return null;
    return { baseUrl: rawUrl, token };
};

export const paperlessConfigured = (): boolean => paperlessConfig() !== null;

/** Web page of a document in the Paperless UI (path routing: /documents/:id). */
export const paperlessDocumentUrl = (baseUrl: string, id: number): string =>
    `${baseUrl.replace(/\/+$/, '')}/documents/${id}`;

// ─── Injectable fetcher (tests answer in place of the network) ───────────────

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

let fetcher: Fetcher = (url, init) =>
    safeFetch(url, { ...init, timeoutMs: PAPERLESS_TIMEOUT_MS, maxBytes: MAX_BODY_BYTES });

/** Lets the tests replace the network. null restores the default safeFetch. */
export const setPaperlessFetcherForTests = (replacement: Fetcher | null): void => {
    fetcher = replacement ?? ((url, init) =>
        safeFetch(url, { ...init, timeoutMs: PAPERLESS_TIMEOUT_MS, maxBytes: MAX_BODY_BYTES }));
};

class PaperlessUpstreamError extends Error {
    constructor(readonly status: number) {
        super(`Paperless responded HTTP ${status}`);
    }
}

const authHeaders = (token: string): Record<string, string> => ({
    // Paperless (DRF) token auth. The token never appears in any log line.
    Authorization: `Token ${token}`,
    Accept: 'application/json',
});

const getJson = async (url: string, token: string): Promise<{ status: number; body: any }> => {
    const response = await fetcher(url, {
        method: 'GET', // read-only bridge: GET only, enforced by construction
        headers: authHeaders(token),
    });
    if (!response.ok) throw new PaperlessUpstreamError(response.status);
    const text = await readCappedText(response, MAX_BODY_BYTES);
    return { status: response.status, body: JSON.parse(text || '{}') };
};

// ─── Documents list / search ─────────────────────────────────────────────────

export interface PaperlessDocumentSummary {
    id: number;
    title: string;
    correspondent: string | null;
    created: string | null; // document date, YYYY-MM-DD
    added: string | null;
    document_url: string;
}

const correspondentNames = async (cfg: PaperlessConfig, ids: number[]): Promise<Map<number, string>> => {
    const map = new Map<number, string>();
    if (ids.length === 0) return map;
    try {
        const { body } = await getJson(`${cfg.baseUrl}/api/correspondents/?page_size=1000`, cfg.token);
        for (const c of body?.results ?? []) {
            if (typeof c?.id === 'number' && typeof c?.name === 'string') map.set(c.id, c.name);
        }
    } catch {
        // Correspondent names are cosmetic: the list still works without them.
    }
    return map;
};

/** Search (q) or recent documents (no q), newest first. READ-ONLY. */
export const searchPaperlessDocuments = async (
    cfg: PaperlessConfig,
    q: string,
    limit: number
): Promise<PaperlessDocumentSummary[]> => {
    const params = new URLSearchParams();
    params.set('page_size', String(limit));
    params.set('ordering', '-created');
    if (q) params.set('query', q);
    const { body } = await getJson(`${cfg.baseUrl}/api/documents/?${params.toString()}`, cfg.token);

    const results: any[] = Array.isArray(body?.results) ? body.results : [];
    const names = await correspondentNames(cfg, results.map((d) => d?.correspondent).filter((v) => typeof v === 'number'));
    return results.map((d) => ({
        id: d.id,
        title: String(d.title ?? ''),
        correspondent: typeof d.correspondent === 'number' ? (names.get(d.correspondent) ?? null) : null,
        created: typeof d.created === 'string' ? d.created.slice(0, 10) : null,
        added: typeof d.added === 'string' ? d.added.slice(0, 10) : null,
        document_url: paperlessDocumentUrl(cfg.baseUrl, d.id),
    }));
};

// ─── OCR heuristics (prefill) ────────────────────────────────────────────────

/** "1 234,56" / "1.234,56" / "1234.56" / "1234,56" → 1234.56. */
export const parseAmountParts = (intRaw: string, decRaw: string): number | null => {
    const intDigits = intRaw.replace(/[\s\u00A0\u202F.,]/g, '');
    if (!/^\d+$/.test(intDigits) || !/^\d{2}$/.test(decRaw)) return null;
    const value = Number(`${intDigits}.${decRaw}`);
    return Number.isFinite(value) && value < 1e9 ? value : null;
};

const TOTAL_LINE_RE = /\b(total|ttc|t\.?t\.?c|ttl|à payer|a payer|net à payer|net a payer|montant|amount|grand total|balance due|total due)\b/i;
const SUBTOTAL_LINE_RE = /\b(sous-?total|hors taxes|\bht\b|subtotal|tva|taxe|tax)\b/i;

/**
 * Proposed amount from the OCR text: the amount on the best "total" line
 * (TTC / à payer / montant…), ties resolved to the LAST such line (totals sit
 * at the bottom of an invoice). HT/subtotal lines score lower so a TTC line
 * wins. Returns null when no total-ish line carries an amount.
 */
export const extractAmountFromOcr = (text: string): number | null => {
    if (!text) return null;
    let best: { amount: number; score: number; index: number } | null = null;
    const amountRe = /(\d{1,3}(?:[\s\u00A0\u202F.,]\d{3})+|\d+)[.,](\d{2})(?:\s*(?:€|EUR|euros?))?/g;
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        amountRe.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = amountRe.exec(line)) !== null) {
            const amount = parseAmountParts(m[1], m[2]);
            if (amount === null) continue;
            const score = TOTAL_LINE_RE.test(line) ? 3 : SUBTOTAL_LINE_RE.test(line) ? 1 : 0;
            if (!best || score > best.score || (score === best.score && index >= best.index)) {
                best = { amount, score, index };
            }
        }
    }
    return best !== null && best.score > 0 ? best.amount : null;
};

const DATE_LINE_RE = /\b(facture|invoice|date|échéance|echeance|due|payable)\b/i;

/** Invoice date detected in the OCR (first date on a "facture/date/échéance" line), YYYY-MM-DD or null. */
export const extractInvoiceDateFromOcr = (text: string): string | null => {
    if (!text) return null;
    for (const line of text.split(/\r?\n/)) {
        if (!DATE_LINE_RE.test(line)) continue;
        const m = line.match(/(\d{1,2})[./-](\d{1,2})[./-](\d{4})/);
        if (!m) continue;
        const day = Number(m[1]);
        const month = Number(m[2]);
        const year = Number(m[3]);
        if (month >= 1 && month <= 12 && day >= 1 && day <= 31 && year >= 1990 && year <= 2100) {
            return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        }
    }
    return null;
};

// ─── Prefill ─────────────────────────────────────────────────────────────────

export interface PaperlessPrefill {
    document_id: number;
    title: string;
    correspondent: string | null;
    document_date: string | null;
    invoice_date: string | null;
    suggested_date: string | null;
    suggested_amount: number | null;
    suggested_description: string;
    document_url: string;
}

/** Document detail + OCR heuristics. Returns null when Paperless has no such document. READ-ONLY. */
export const getPaperlessPrefill = async (
    cfg: PaperlessConfig,
    id: number
): Promise<PaperlessPrefill | null> => {
    let body: any;
    try {
        ({ body } = await getJson(`${cfg.baseUrl}/api/documents/${id}/`, cfg.token));
    } catch (e) {
        if (e instanceof PaperlessUpstreamError && e.status === 404) return null;
        throw e;
    }

    const names = await correspondentNames(cfg, typeof body?.correspondent === 'number' ? [body.correspondent] : []);
    const title = String(body?.title ?? '');
    const correspondent = typeof body?.correspondent === 'number' ? (names.get(body.correspondent) ?? null) : null;
    const documentDate = typeof body?.created === 'string' ? body.created.slice(0, 10) : null;
    const content = typeof body?.content === 'string' ? body.content : '';

    const invoiceDate = extractInvoiceDateFromOcr(content);
    const amount = extractAmountFromOcr(content);

    return {
        document_id: id,
        title,
        correspondent,
        document_date: documentDate,
        invoice_date: invoiceDate,
        suggested_date: invoiceDate ?? documentDate,
        suggested_amount: amount,
        // Proposed description = title, falling back to the correspondent.
        suggested_description: title || correspondent || '',
        document_url: paperlessDocumentUrl(cfg.baseUrl, id),
    };
};
