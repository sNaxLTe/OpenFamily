import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app, query, registerWithPassword, resetState, startSuite, stopSuite } from './helpers';

// Lot 4 of the annual-budget fork: GET /api/budget/report (feature 10,
// "Explorateur"). Zero migration, read-only, children may read.

beforeAll(startSuite);
afterAll(stopSuite);

let parent: { token: string; user: { id: string } };

beforeEach(async () => {
    await resetState();
    parent = await registerWithPassword('parent@example.org');
});

const as = (token: string) => ({ Authorization: `Bearer ${token}` });
const post = (path: string, body: unknown, token = parent.token) =>
    request(app).post(path).set(as(token)).send(body as object);
const get = (path: string, token = parent.token) => request(app).get(path).set(as(token));

const addEntry = (body: unknown) => post('/api/budget/entries', body);
const addRecurring = (body: unknown) => post('/api/budget/recurring', body);

const makeChild = async (): Promise<string> => {
    const child = await registerWithPassword('child@example.org');
    await query(
        "UPDATE users SET family_owner_id = $1, role = 'enfant' WHERE id = $2",
        [parent.user.id, child.user.id]
    );
    const login = await request(app)
        .post('/api/auth/login')
        .send({ email: 'child@example.org', password: 'correct-horse-1' });
    expect(login.status).toBe(200);
    return login.body.data.token as string;
};

/** Seed: expenses 100 (Alimentation, Jan) + 200 (Logement, Jun, assigned to Léa),
 *  income 500 (Salaire, Mar); recurring expense 50/month (Logement) all 2026;
 *  plus 2025 leftovers: expense 30 in Aug 2025, expense 20 in Jun 2025. */
const seed = async () => {
    await addEntry({ category: 'Alimentation', amount: 100, date: '2026-01-15', is_expense: true });
    await addEntry({ category: 'Logement', amount: 200, date: '2026-06-05', is_expense: true });
    await addEntry({ category: 'Salaire', amount: 500, date: '2026-03-10', is_expense: false });
    await addEntry({ category: 'Divers', amount: 30, date: '2025-08-01', is_expense: true });
    await addEntry({ category: 'Divers', amount: 20, date: '2025-06-01', is_expense: true });
    await addRecurring({ label: 'Assurance', amount: 50, category: 'Logement', start_date: '2026-01-10' });
};

const memberId = async (): Promise<string> => {
    const member = await post('/api/family', { name: 'Léa', color: '#3B82F6' });
    return member.body.data.id as string;
};

describe('GET /api/budget/report — validation', () => {
    it('needs a token, a range, and valid enums', async () => {
        expect((await request(app).get('/api/budget/report?range_preset=this_year')).status).toBe(401);
        expect((await get('/api/budget/report')).status).toBe(400);
        expect((await get('/api/budget/report?range_preset=bogus&as_of=2026-06-15')).status).toBe(400);
        expect((await get('/api/budget/report?start_date=2026-06-01')).status).toBe(400);
        expect((await get('/api/budget/report?start_date=xx&end_date=2026-06-30')).status).toBe(400);
        expect((await get('/api/budget/report?start_date=2026-06-30&end_date=2026-06-01')).status).toBe(400);
        expect((await get('/api/budget/report?start_date=2020-01-01&end_date=2026-12-31')).status).toBe(400);
        expect((await get('/api/budget/report?range_preset=this_year&type=bogus&as_of=2026-06-15')).status).toBe(400);
        expect((await get('/api/budget/report?range_preset=this_year&split=bogus&as_of=2026-06-15')).status).toBe(400);
    });
});

describe('GET /api/budget/report — presets and splits', () => {
    it('this_year + split=month: 12 rows incl. empty months, recurring included, summary', async () => {
        await seed();
        const res = await get('/api/budget/report?range_preset=this_year&as_of=2026-06-15&split=month');
        expect(res.status).toBe(200);
        const data = res.body.data;
        expect(data.range).toEqual({ preset: 'this_year', start_date: '2026-01-01', end_date: '2026-12-31' });
        expect(data.params).toMatchObject({ type: 'expenses', split: 'month', include_recurring: true });
        expect(data.rows).toHaveLength(12);
        expect(data.rows.map((r: any) => r.key)).toEqual([
            '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06',
            '2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12',
        ]);
        expect(data.rows[0]).toEqual({ key: '2026-01', label: '2026-01', total: 150, count: 2, average: 75, recurring_total: 50 });
        // the recurring series fills every month: April has its 50
        expect(data.rows[3]).toEqual({ key: '2026-04', label: '2026-04', total: 50, count: 1, average: 50, recurring_total: 50 });
        expect(data.rows[5]).toEqual({ key: '2026-06', label: '2026-06', total: 250, count: 2, average: 125, recurring_total: 50 });
        // expenses type: 100 + 200 entries + 12 × 50 recurring
        expect(data.summary).toEqual({ total: 900, count: 14, average: 64.29, recurring_total: 600 });
    });

    it('type=income and type=net', async () => {
        await seed();
        const income = await get('/api/budget/report?range_preset=this_year&as_of=2026-06-15&type=income');
        expect(income.body.data.summary.total).toBe(500);
        expect(income.body.data.summary.count).toBe(1);
        expect(income.body.data.rows.find((r: any) => r.key === '2026-03').total).toBe(500);

        const net = await get('/api/budget/report?range_preset=this_year&as_of=2026-06-15&type=net');
        expect(net.body.data.summary.total).toBe(500 - 900);
        expect(net.body.data.rows.find((r: any) => r.key === '2026-01').total).toBe(-150);
        // March: +500 income − 50 recurring expense
        expect(net.body.data.rows.find((r: any) => r.key === '2026-03').total).toBe(450);
    });

    it('include_recurring=false counts entries only', async () => {
        await seed();
        const res = await get('/api/budget/report?range_preset=this_year&as_of=2026-06-15&include_recurring=false');
        expect(res.body.data.params.include_recurring).toBe(false);
        expect(res.body.data.summary).toMatchObject({ total: 300, count: 2, recurring_total: 0 });
        expect(res.body.data.rows.find((r: any) => r.key === '2026-06').total).toBe(200);
        expect(res.body.data.rows.find((r: any) => r.key === '2026-02').total).toBe(0);
    });

    it('split=category groups entries + recurring by category', async () => {
        await seed();
        const res = await get('/api/budget/report?range_preset=this_year&as_of=2026-06-15&split=category');
        const rows = res.body.data.rows;
        expect(rows.find((r: any) => r.key === 'Logement')).toMatchObject({ total: 800, count: 13, recurring_total: 600 });
        expect(rows.find((r: any) => r.key === 'Alimentation')).toMatchObject({ total: 100, count: 1, recurring_total: 0 });
        // sorted by total desc
        expect(rows[0].key).toBe('Logement');
    });

    it('split=member keys on assigned_to, unassigned (incl. recurring) under null', async () => {
        await seed();
        const lea = await memberId();
        await post('/api/budget/entries', { category: 'Alimentation', amount: 70, date: '2026-02-11', is_expense: true, assigned_to: lea });

        const res = await get('/api/budget/report?range_preset=this_year&as_of=2026-06-15&split=member');
        const rows = res.body.data.rows;
        const leaRow = rows.find((r: any) => r.key === lea);
        expect(leaRow).toMatchObject({ label: 'Léa', total: 70, count: 1, recurring_total: 0 });
        const unassigned = rows.find((r: any) => r.key === null);
        expect(unassigned.label).toBeNull();
        // 100 (Jan) + 200 (Jun) entries + 12 recurring occurrences
        expect(unassigned).toMatchObject({ total: 900, count: 14, recurring_total: 600 });
    });

    it('custom range via start_date+end_date lists every month of the range', async () => {
        await seed();
        const res = await get('/api/budget/report?start_date=2026-03-01&end_date=2026-06-30');
        expect(res.body.data.range).toEqual({ preset: 'custom', start_date: '2026-03-01', end_date: '2026-06-30' });
        expect(res.body.data.rows.map((r: any) => r.key)).toEqual(['2026-03', '2026-04', '2026-05', '2026-06']);
        // recurring 50 fills Mar/Apr/May; June adds the 200 entry
        expect(res.body.data.rows.map((r: any) => r.total)).toEqual([50, 50, 50, 250]);

        // without recurring, the empty months come back as zero rows (chart-ready)
        const noRec = await get('/api/budget/report?start_date=2026-03-01&end_date=2026-06-30&include_recurring=false');
        expect(noRec.body.data.rows.map((r: any) => r.total)).toEqual([0, 0, 0, 200]);
        expect(noRec.body.data.rows[0]).toMatchObject({ key: '2026-03', total: 0, count: 0, average: 0, recurring_total: 0 });
    });

    it('last_12_months and last_year resolve against as_of', async () => {
        await seed();
        const last12 = await get('/api/budget/report?range_preset=last_12_months&as_of=2026-06-15');
        expect(last12.body.data.range).toEqual({ preset: 'last_12_months', start_date: '2025-07-01', end_date: '2026-06-30' });
        // includes the Aug 2025 expense (30) but not Jun 2025 (20); recurring
        // only from its start (Jan 2026) through Jun 2026 = 6 × 50
        expect(last12.body.data.summary.total).toBe(30 + 100 + 200 + 300);
        expect(last12.body.data.rows).toHaveLength(12);

        const lastYear = await get('/api/budget/report?range_preset=last_year&as_of=2026-06-15');
        expect(lastYear.body.data.range).toEqual({ preset: 'last_year', start_date: '2025-01-01', end_date: '2025-12-31' });
        // 2025: entries 20 + 30, no recurring (series starts 2026)
        expect(lastYear.body.data.summary).toMatchObject({ total: 50, count: 2, recurring_total: 0 });
    });

    it('filters: categories and members, same semantics as /entries', async () => {
        await seed();
        const lea = await memberId();
        await post('/api/budget/entries', { category: 'Alimentation', amount: 70, date: '2026-02-11', is_expense: true, assigned_to: lea });

        const byCat = await get('/api/budget/report?range_preset=this_year&as_of=2026-06-15&categories=Alimentation');
        expect(byCat.body.data.summary).toMatchObject({ total: 170, count: 2, recurring_total: 0 });

        const byCatList = await get('/api/budget/report?range_preset=this_year&as_of=2026-06-15&categories=Alimentation,Logement');
        expect(byCatList.body.data.summary).toMatchObject({ total: 970, recurring_total: 600 });

        const byMember = await get(`/api/budget/report?range_preset=this_year&as_of=2026-06-15&members=${lea}&split=member`);
        // entries are restricted to Léa (70), but recurring occurrences have no
        // member and are NOT member-filtered: 600 more in the unassigned bucket
        expect(byMember.body.data.summary).toMatchObject({ total: 670, count: 13, recurring_total: 600 });
        const leaRow = byMember.body.data.rows.find((r: any) => r.key === lea);
        expect(leaRow).toMatchObject({ label: 'Léa', total: 70, count: 1, recurring_total: 0 });

        const both = await get(`/api/budget/report?range_preset=this_year&as_of=2026-06-15&categories=Alimentation&members=${lea}`);
        expect(both.body.data.summary.total).toBe(70);
    });

    it('equivalence with the annual view: this_year expenses split=month sums to the annual total', async () => {
        await seed();
        const report = await get('/api/budget/report?range_preset=this_year&as_of=2026-06-15&split=month');
        const annual = await get('/api/budget/statistics/annual?year=2026');
        const monthly = await get('/api/budget/statistics/monthly?year=2026');
        const reportSum = report.body.data.rows.reduce((s: number, r: any) => s + r.total, 0);
        expect(reportSum).toBe(annual.body.data.totalExpenses);
        expect(reportSum).toBe(monthly.body.data.reduce((s: number, m: any) => s + m.totalExpenses, 0));
    });

    it('is readable by a child account (like the budget statistics)', async () => {
        await seed();
        const childToken = await makeChild();
        const res = await get('/api/budget/report?range_preset=this_year&as_of=2026-06-15', childToken);
        expect(res.status).toBe(200);
        expect(res.body.data.summary.total).toBe(900);
    });
});
