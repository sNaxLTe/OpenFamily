import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app, query, registerWithPassword, resetState, startSuite, stopSuite } from './helpers';
import { coreMigrations } from '../src/migrations/registry';
import { annualMigrations } from '../src/migrations/annual';
import { validateRegistry } from '../src/migrations/runner';
import {
    setPaperlessFetcherForTests,
    extractAmountFromOcr,
    extractInvoiceDateFromOcr,
    parseAmountParts,
} from '../src/services/integrations/paperless';

// Lot 10 of the annual-budget fork: the Paperless → Budget bridge (feature 13).
// - migration annual/0005 (paperless_document_id / paperless_url on budget_entries)
// - GET /api/budget/paperless/status | /documents | /documents/:id/prefill
//   (503 when PAPERLESS_URL/PAPERLESS_TOKEN are unset, requireParent on the
//   data routes, proxied through a MOCKED fetcher — no real network in tests)
// - POST/PUT /entries accept and return the paperless fields; the stored URL
//   is derived server-side from PAPERLESS_PUBLIC_URL (fallback PAPERLESS_URL),
//   never taken from the client; PAPERLESS_URL stays the internal URL of every
//   outbound (mocked) call
// - strictly read-only towards Paperless: every mocked call must be a GET

beforeAll(startSuite);
afterAll(stopSuite);

let parent: { token: string; user: { id: string } };

beforeEach(async () => {
    await resetState();
    parent = await registerWithPassword('parent@example.org');
    delete process.env.PAPERLESS_URL;
    delete process.env.PAPERLESS_TOKEN;
    delete process.env.PAPERLESS_PUBLIC_URL;
});

afterEach(() => {
    setPaperlessFetcherForTests(null);
    delete process.env.PAPERLESS_URL;
    delete process.env.PAPERLESS_TOKEN;
    delete process.env.PAPERLESS_PUBLIC_URL;
});

const as = (token: string) => ({ Authorization: `Bearer ${token}` });
const post = (path: string, body: unknown, token = parent.token) =>
    request(app).post(path).set(as(token)).send(body as object);
const put = (path: string, body: unknown, token = parent.token) =>
    request(app).put(path).set(as(token)).send(body as object);
const get = (path: string, token = parent.token) => request(app).get(path).set(as(token));

const makeChild = async (): Promise<{ token: string; user: { id: string } }> => {
    const child = await registerWithPassword('child@example.org');
    await query(
        "UPDATE users SET family_owner_id = $1, role = 'enfant' WHERE id = $2",
        [parent.user.id, child.user.id]
    );
    const login = await request(app)
        .post('/api/auth/login')
        .send({ email: 'child@example.org', password: 'correct-horse-1' });
    expect(login.status).toBe(200);
    return { token: login.body.data.token as string, user: child.user };
};

const BASE = 'http://paperless.test:8000';
const PUBLIC = 'https://paperless.example.com';
const TOKEN = 'secret-token-123';

interface RecordedCall { url: string; method: string; authorization: string | null }

/** A mocked Paperless: records every call, answers canned API payloads. */
const mockPaperless = (documents: any[], detailById: Record<number, any>, correspondents: any[] = []) => {
    const calls: RecordedCall[] = [];
    setPaperlessFetcherForTests(async (url: string, init: RequestInit) => {
        calls.push({
            url,
            method: String(init.method ?? 'GET'),
            authorization: (init.headers as Record<string, string> | undefined)?.Authorization ?? null,
        });
        const u = new URL(url);
        if (u.pathname === '/api/documents/') {
            return new Response(JSON.stringify({ count: documents.length, results: documents }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }
        if (u.pathname === '/api/correspondents/') {
            return new Response(JSON.stringify({ results: correspondents }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }
        const docMatch = u.pathname.match(/^\/api\/documents\/(\d+)\/$/);
        if (docMatch) {
            const id = Number(docMatch[1]);
            if (detailById[id]) {
                return new Response(JSON.stringify(detailById[id]), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            return new Response('{"detail":"Not found."}', { status: 404 });
        }
        return new Response('{}', { status: 404 });
    });
    return calls;
};

const setEnv = () => {
    process.env.PAPERLESS_URL = BASE;
    process.env.PAPERLESS_TOKEN = TOKEN;
};

/** Internal URL + token + a distinct PUBLIC url for link derivation. */
const setEnvWithPublic = (publicUrl: string | undefined) => {
    setEnv();
    if (publicUrl === undefined) delete process.env.PAPERLESS_PUBLIC_URL;
    else process.env.PAPERLESS_PUBLIC_URL = publicUrl;
};

const entryBody = { category: 'Alimentation', amount: 42.5, date: '2026-11-12', is_expense: true, description: 'test' };

describe('migration annual/0005', () => {
    it('validates in the combined registry and is recorded; columns + index exist', async () => {
        expect(() => validateRegistry([...coreMigrations, ...annualMigrations])).not.toThrow();
        expect(annualMigrations.map((m) => m.id)).toContain('annual/0005-paperless-link');
        const recorded = await query(
            "SELECT id FROM openfamily_schema_migrations WHERE id = 'annual/0005-paperless-link'"
        );
        expect(recorded.rows).toHaveLength(1);

        const cols = await query(
            `SELECT column_name, data_type FROM information_schema.columns
             WHERE table_name = 'budget_entries' AND column_name IN ('paperless_document_id', 'paperless_url')`
        );
        expect(cols.rows.map((r) => r.column_name).sort()).toEqual(['paperless_document_id', 'paperless_url']);
        expect(cols.rows.find((r) => r.column_name === 'paperless_document_id')?.data_type).toBe('integer');

        const idx = await query(
            "SELECT indexname FROM pg_indexes WHERE tablename = 'budget_entries' AND indexname = 'idx_budget_entries_paperless_document'"
        );
        expect(idx.rows).toHaveLength(1);
    });
});

describe('OCR heuristics', () => {
    it('parses french/english amounts', () => {
        expect(parseAmountParts('1 234', '56')).toBe(1234.56);
        expect(parseAmountParts('1.234', '56')).toBe(1234.56);
        expect(parseAmountParts('1234', '56')).toBe(1234.56);
        expect(parseAmountParts('89', '90')).toBe(89.9);
        expect(parseAmountParts('abc', '56')).toBeNull();
    });

    it('extracts the TTC total from an invoice OCR, not the HT subtotal', () => {
        const ocr = [
            'FACTURE n° 2026-014',
            'Date de facture : 12/11/2026',
            'Article A .......... 100,00 €',
            'Sous-total HT : 100,00 €',
            'TVA 20 % : 20,00 €',
            'Total TTC : 1 234,56 €',
        ].join('\n');
        expect(extractAmountFromOcr(ocr)).toBe(1234.56);
        expect(extractInvoiceDateFromOcr(ocr)).toBe('2026-11-12');
    });

    it('picks the LAST total line when several match (totals at the bottom)', () => {
        const ocr = 'Total TTC : 10,00 €\n...\nTOTAL À PAYER 89,90 EUR';
        expect(extractAmountFromOcr(ocr)).toBe(89.9);
    });

    it('returns null when no total line carries an amount', () => {
        expect(extractAmountFromOcr('Article A 100,00 €\nMerci')).toBeNull();
        expect(extractInvoiceDateFromOcr('aucune date ici')).toBeNull();
    });
});

describe('paperless routes when NOT configured (env unset)', () => {
    it('status reports configured:false', async () => {
        const res = await get('/api/budget/paperless/status');
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({ configured: false });
    });

    it('documents and prefill answer 503 with a clear message', async () => {
        const docs = await get('/api/budget/paperless/documents?q=edf');
        expect(docs.status).toBe(503);
        expect(docs.body.success).toBe(false);
        expect(docs.body.error).toMatch(/PAPERLESS_URL/);

        const pre = await get('/api/budget/paperless/documents/5/prefill');
        expect(pre.status).toBe(503);
        expect(pre.body.error).toMatch(/PAPERLESS_URL/);
    });
});

describe('paperless proxy routes (mocked upstream)', () => {
    const docs = [
        { id: 7, title: 'Facture EDF octobre', correspondent: 3, created: '2026-10-02', added: '2026-10-03' },
        { id: 9, title: 'Facture eau', correspondent: null, created: '2026-11-05', added: '2026-11-05' },
    ];
    const correspondents = [{ id: 3, name: 'EDF' }];

    it('GET /documents proxies the search, maps correspondent names, sends the token, GET only', async () => {
        setEnv();
        const calls = mockPaperless(docs, {}, correspondents);
        const res = await get('/api/budget/paperless/documents?q=edf&limit=10');
        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(2);
        expect(res.body.data[0]).toMatchObject({
            id: 7,
            title: 'Facture EDF octobre',
            correspondent: 'EDF',
            created: '2026-10-02',
            document_url: `${BASE}/documents/7`,
        });
        expect(res.body.data[1].correspondent).toBeNull();

        const docCall = calls.find((c) => c.url.includes('/api/documents/'));
        expect(docCall).toBeDefined();
        expect(docCall!.method).toBe('GET');
        expect(new URL(docCall!.url).searchParams.get('query')).toBe('edf');
        expect(new URL(docCall!.url).searchParams.get('page_size')).toBe('10');
        expect(docCall!.authorization).toBe(`Token ${TOKEN}`);
        // The base URL and token must not leak into the response body.
        expect(JSON.stringify(res.body)).not.toContain(TOKEN);
    });

    it('is refused for a child account (403) on both data routes', async () => {
        setEnv();
        mockPaperless(docs, {}, correspondents);
        const child = await makeChild();
        expect((await get('/api/budget/paperless/documents?q=edf', child.token)).status).toBe(403);
        expect((await get('/api/budget/paperless/documents/7/prefill', child.token)).status).toBe(403);
    });

    it('GET /documents/:id/prefill returns OCR heuristics (factice content)', async () => {
        setEnv();
        const calls = mockPaperless([], {
            7: {
                id: 7,
                title: 'Facture EDF octobre',
                correspondent: 3,
                created: '2026-10-02',
                content: [
                    'EDF — Facture n° 2026-1042',
                    'Date de facture : 28/10/2026',
                    'Échéance : 15/11/2026',
                    'Consommation : 350 kWh',
                    'Montant HT : 102,46 €',
                    'TVA : 20,49 €',
                    'Total TTC : 122,95 €',
                ].join('\n'),
            },
        }, correspondents);

        const res = await get('/api/budget/paperless/documents/7/prefill');
        expect(res.status).toBe(200);
        const p = res.body.data;
        expect(p.document_id).toBe(7);
        expect(p.title).toBe('Facture EDF octobre');
        expect(p.correspondent).toBe('EDF');
        expect(p.document_date).toBe('2026-10-02');
        expect(p.invoice_date).toBe('2026-10-28');
        expect(p.suggested_date).toBe('2026-10-28');
        expect(p.suggested_amount).toBe(122.95);
        expect(p.suggested_description).toBe('Facture EDF octobre');
        expect(p.document_url).toBe(`${BASE}/documents/7`);
        expect(JSON.stringify(res.body)).not.toContain(TOKEN);

        // Read-only principle: every upstream call was a GET.
        expect(calls.length).toBeGreaterThan(0);
        for (const c of calls) expect(c.method).toBe('GET');
    });

    it('prefill falls back to the document date when no invoice date is detected', async () => {
        setEnv();
        mockPaperless([], {
            9: { id: 9, title: 'Reçu', correspondent: null, created: '2026-11-05', content: 'Total : 10,00 €' },
        });
        const res = await get('/api/budget/paperless/documents/9/prefill');
        expect(res.status).toBe(200);
        expect(res.body.data.invoice_date).toBeNull();
        expect(res.body.data.suggested_date).toBe('2026-11-05');
        expect(res.body.data.suggested_amount).toBe(10);
        expect(res.body.data.suggested_description).toBe('Reçu');
    });

    it('prefill 404 when Paperless has no such document; 400 on a bad id', async () => {
        setEnv();
        mockPaperless([], {});
        expect((await get('/api/budget/paperless/documents/999/prefill')).status).toBe(404);
        expect((await get('/api/budget/paperless/documents/abc/prefill')).status).toBe(400);
    });
});

describe('PAPERLESS_PUBLIC_URL (dérivation des liens publics)', () => {
    const docs = [{ id: 7, title: 'Facture EDF octobre', correspondent: 3, created: '2026-10-02', added: '2026-10-03' }];
    const correspondents = [{ id: 3, name: 'EDF' }];
    const detail = {
        7: {
            id: 7,
            title: 'Facture EDF octobre',
            correspondent: 3,
            created: '2026-10-02',
            content: 'Date de facture : 28/10/2026\nTotal TTC : 122,95 €',
        },
    };

    it('both URLs set: outbound calls hit the INTERNAL url, document links use the PUBLIC url (list, prefill, stored entry)', async () => {
        setEnvWithPublic(PUBLIC);
        const calls = mockPaperless(docs, detail, correspondents);

        const list = await get('/api/budget/paperless/documents?q=edf');
        expect(list.status).toBe(200);
        expect(list.body.data[0].document_url).toBe(`${PUBLIC}/documents/7`);
        // Every outbound call went to the internal URL, GET only, with the token.
        expect(calls.length).toBeGreaterThan(0);
        for (const c of calls) {
            expect(c.url.startsWith(`${BASE}/api/`)).toBe(true);
            expect(c.method).toBe('GET');
            expect(c.authorization).toBe(`Token ${TOKEN}`);
        }
        // Neither the internal URL nor the token leaks into the response body.
        expect(JSON.stringify(list.body)).not.toContain(BASE);
        expect(JSON.stringify(list.body)).not.toContain(TOKEN);

        const pre = await get('/api/budget/paperless/documents/7/prefill');
        expect(pre.status).toBe(200);
        expect(pre.body.data.document_url).toBe(`${PUBLIC}/documents/7`);
        expect(JSON.stringify(pre.body)).not.toContain(BASE);

        const created = await post('/api/budget/entries', { ...entryBody, paperless_document_id: 7 });
        expect(created.status).toBe(200);
        expect(created.body.data.paperless_url).toBe(`${PUBLIC}/documents/7`);
        const listed = await get('/api/budget/entries');
        expect(listed.body.data[0].paperless_url).toBe(`${PUBLIC}/documents/7`);
    });

    it('PUBLIC absent → strict fallback to PAPERLESS_URL for the links', async () => {
        setEnvWithPublic(undefined);
        mockPaperless(docs, detail, correspondents);
        const list = await get('/api/budget/paperless/documents');
        expect(list.status).toBe(200);
        expect(list.body.data[0].document_url).toBe(`${BASE}/documents/7`);
        const created = await post('/api/budget/entries', { ...entryBody, paperless_document_id: 7 });
        expect(created.body.data.paperless_url).toBe(`${BASE}/documents/7`);
    });

    it('PUBLIC empty or whitespace-only → strict fallback to PAPERLESS_URL', async () => {
        mockPaperless(docs, detail, correspondents);
        for (const empty of ['', '   ', '\t\n ']) {
            setEnvWithPublic(empty);
            const list = await get('/api/budget/paperless/documents');
            expect(list.status).toBe(200);
            expect(list.body.data[0].document_url).toBe(`${BASE}/documents/7`);
        }
    });

    it('PUBLIC present but not http(s) → bridge disabled (fail closed, nothing leaks)', async () => {
        setEnvWithPublic('ftp://nope');
        const status = await get('/api/budget/paperless/status');
        expect(status.status).toBe(200);
        expect(status.body.data).toEqual({ configured: false });
        // /status reveals no URL at all.
        expect(JSON.stringify(status.body)).not.toContain('ftp://nope');
        expect(JSON.stringify(status.body)).not.toContain(BASE);
        expect((await get('/api/budget/paperless/documents')).status).toBe(503);
    });
});

describe('POST/PUT /entries with the paperless fields', () => {
    it('POST stores paperless_document_id and derives paperless_url server-side; GET returns both', async () => {
        setEnv();
        const created = await post('/api/budget/entries', { ...entryBody, paperless_document_id: 7 });
        expect(created.status).toBe(200);
        expect(created.body.data.paperless_document_id).toBe(7);
        expect(created.body.data.paperless_url).toBe(`${BASE}/documents/7`);

        const list = await get('/api/budget/entries');
        expect(list.body.data[0].paperless_document_id).toBe(7);
        expect(list.body.data[0].paperless_url).toBe(`${BASE}/documents/7`);
    });

    it('never stores a client-sent paperless_url: the server URL wins', async () => {
        setEnv();
        const created = await post('/api/budget/entries', {
            ...entryBody,
            paperless_document_id: 7,
            paperless_url: 'https://evil.example.com/phish',
        });
        expect(created.status).toBe(200);
        expect(created.body.data.paperless_url).toBe(`${BASE}/documents/7`);
    });

    it('stores a null url when Paperless is not configured server-side', async () => {
        const created = await post('/api/budget/entries', { ...entryBody, paperless_document_id: 7 });
        expect(created.status).toBe(200);
        expect(created.body.data.paperless_document_id).toBe(7);
        expect(created.body.data.paperless_url).toBeNull();
    });

    it('rejects invalid paperless_document_id values with a 400', async () => {
        for (const bad of [-5, 0, 1.5, 'abc', '12x']) {
            const res = await post('/api/budget/entries', { ...entryBody, paperless_document_id: bad });
            expect(res.status).toBe(400);
        }
    });

    it('PUT links, then unlinks (null), and keeps the link when the field is absent', async () => {
        setEnv();
        const created = await post('/api/budget/entries', entryBody);
        const id = created.body.data.id;
        expect(created.body.data.paperless_document_id).toBeNull();

        const linked = await put(`/api/budget/entries/${id}`, { paperless_document_id: 42 });
        expect(linked.status).toBe(200);
        expect(linked.body.data.paperless_document_id).toBe(42);
        expect(linked.body.data.paperless_url).toBe(`${BASE}/documents/42`);

        // absent field → untouched
        const kept = await put(`/api/budget/entries/${id}`, { amount: 50 });
        expect(kept.body.data.paperless_document_id).toBe(42);

        // explicit null → unlinked
        const unlinked = await put(`/api/budget/entries/${id}`, { paperless_document_id: null });
        expect(unlinked.body.data.paperless_document_id).toBeNull();
        expect(unlinked.body.data.paperless_url).toBeNull();

        // invalid → 400
        expect((await put(`/api/budget/entries/${id}`, { paperless_document_id: 'nope' })).status).toBe(400);
    });

    it('child accounts cannot create entries (403) — paperless fields included', async () => {
        const child = await makeChild();
        const res = await post('/api/budget/entries', { ...entryBody, paperless_document_id: 7 }, child.token);
        expect(res.status).toBe(403);
    });
});
