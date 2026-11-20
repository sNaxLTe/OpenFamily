import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app, query, registerWithPassword, resetState, startSuite, stopSuite } from './helpers';
import { coreMigrations } from '../src/migrations/registry';
import { annualMigrations } from '../src/migrations/annual';
import { validateRegistry } from '../src/migrations/runner';
import { expandRecurringTransactions } from '../src/lib/budgetRecurrence';

// Lot 3 of the annual-budget fork:
// - GET /api/kakeibo/annual?year= + PUT /api/kakeibo/annual/notes (feature 5),
//   with migration annual/0004 (kakeibo_annual_notes)
// - GET /api/budget/forecast: retro-compatible extension with ?months=N
//   (feature 11 preparation); without months, the month/year behaviour is
//   unchanged.

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

const addEntry = (body: unknown) => post('/api/budget/entries', body);
const addRecurring = (body: unknown) => post('/api/budget/recurring', body);

describe('migration annual/0004', () => {
    it('validates in the combined registry and is recorded', async () => {
        expect(() => validateRegistry([...coreMigrations, ...annualMigrations])).not.toThrow();
        expect(annualMigrations.map((m) => m.id)).toContain('annual/0004-kakeibo-annual-notes');
        const recorded = await query(
            "SELECT id FROM openfamily_schema_migrations WHERE id = 'annual/0004-kakeibo-annual-notes'"
        );
        expect(recorded.rows).toHaveLength(1);
    });
});

describe('GET /api/kakeibo/annual', () => {
    const seed = async () => {
        // One earning member: 3000/month salary.
        const member = await post('/api/family', { name: 'Léa', color: '#3B82F6' });
        expect(member.status).toBe(200);
        const memberId = member.body.data.id as string;
        await put('/api/kakeibo/income', { incomes: { [memberId]: 3000 } });
        // Goals for January and June 2026.
        await put('/api/kakeibo/month', { month: 1, year: 2026, savings_goal: 500 });
        await put('/api/kakeibo/month', { month: 6, year: 2026, savings_goal: 500 });
        // Recurring rent 800/month all year (Logement → survival), income
        // series 3000/month is NOT counted as kakeibo expense (is_expense=false).
        await addRecurring({ label: 'Loyer', amount: 800, category: 'Logement', start_date: '2026-01-05' });
        // One-off June expense of 1000 (Alimentation → survival).
        await addEntry({ category: 'Alimentation', amount: 1000, date: '2026-06-10', is_expense: true });
        // One-off extra income in June (bonus).
        await addEntry({ category: 'Salaire', amount: 400, date: '2026-06-20', is_expense: false });
    };

    it('needs a valid year and a token', async () => {
        expect((await request(app).get('/api/kakeibo/annual?year=2026')).status).toBe(401);
        expect((await get('/api/kakeibo/annual')).status).toBe(400);
        expect((await get('/api/kakeibo/annual?year=abc')).status).toBe(400);
    });

    it('returns goals vs realized per month, by-pillar year totals and notes', async () => {
        await seed();
        const res = await get('/api/kakeibo/annual?year=2026');
        expect(res.status).toBe(200);
        const data = res.body.data;
        expect(data.year).toBe(2026);
        expect(data.goalsTotal).toBe(1000);
        expect(data.monthly).toHaveLength(12);
        // Every month: 3000 salary − 800 rent = 2200 realized, except June
        // (3000 + 400 bonus − 800 − 1000 = 1600).
        expect(data.monthly[0]).toEqual({ month: 1, savings_goal: 500, realized: 2200 });
        expect(data.monthly[5]).toEqual({ month: 6, savings_goal: 500, realized: 1600 });
        expect(data.monthly[1]).toEqual({ month: 2, savings_goal: 0, realized: 2200 });
        expect(data.realizedTotal).toBe(11 * 2200 + 1600);
        expect(data.savingsGoalReached).toBe(true);
        // Year by pillar: Logement 800*12 + Alimentation 1000, both survival.
        expect(data.byPillar).toEqual({ survival: 10600, wants: 0, culture: 0, extra: 0 });
        expect(data.byCategory[0]).toMatchObject({ category: 'Logement', amount: 9600, pillar: 'survival' });
        expect(data.notes).toBeNull();
    });

    it('is readable by a child account', async () => {
        await seed();
        const child = await makeChild();
        const res = await get('/api/kakeibo/annual?year=2026', child.token);
        expect(res.status).toBe(200);
        expect(res.body.data.realizedTotal).toBe(11 * 2200 + 1600);
    });

    it('rejects years outside 1-9999 with a clean 400 on GET /annual and PUT /annual/notes', async () => {
        for (const bad of ['0', '-1', '10000']) {
            const res = await get(`/api/kakeibo/annual?year=${bad}`);
            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/between 1 and 9999/);
            expect((await put('/api/kakeibo/annual/notes', { year: Number(bad), notes: 'x' })).status).toBe(400);
        }
        expect((await get('/api/kakeibo/annual?year=9999')).status).toBe(200);
        expect((await put('/api/kakeibo/annual/notes', { year: 9999, notes: 'ok' })).status).toBe(200);
    });
});

describe('PUT /api/kakeibo/annual/notes', () => {
    it('sets, updates and clears the end-of-year notes; GET /annual returns them', async () => {
        expect((await put('/api/kakeibo/annual/notes', { year: 2026, notes: 'Bonne année 2026' })).status).toBe(200);
        let res = await get('/api/kakeibo/annual?year=2026');
        expect(res.body.data.notes).toBe('Bonne année 2026');

        await put('/api/kakeibo/annual/notes', { year: 2026, notes: 'Bilan revu' });
        res = await get('/api/kakeibo/annual?year=2026');
        expect(res.body.data.notes).toBe('Bilan revu');

        // A second year is a separate row.
        await put('/api/kakeibo/annual/notes', { year: 2025, notes: 'Vieux' });
        res = await get('/api/kakeibo/annual?year=2026');
        expect(res.body.data.notes).toBe('Bilan revu');
        res = await get('/api/kakeibo/annual?year=2025');
        expect(res.body.data.notes).toBe('Vieux');

        // null clears.
        await put('/api/kakeibo/annual/notes', { year: 2026, notes: null });
        res = await get('/api/kakeibo/annual?year=2026');
        expect(res.body.data.notes).toBeNull();

        expect((await put('/api/kakeibo/annual/notes', { notes: 'x' })).status).toBe(400);
        expect((await put('/api/kakeibo/annual/notes', { year: 2026 })).status).toBe(400);
    });

    it('is refused for a child account', async () => {
        const child = await makeChild();
        const res = await put('/api/kakeibo/annual/notes', { year: 2026, notes: 'x' }, child.token);
        expect(res.status).toBe(403);
        expect((await query('SELECT COUNT(*)::int AS n FROM kakeibo_annual_notes')).rows[0].n).toBe(0);
    });
});

describe('GET /api/budget/forecast', () => {
    it('without months keeps the exact month/year behaviour (zero regression)', async () => {
        // No month/year and no months → 400, as before.
        expect((await get('/api/budget/forecast')).status).toBe(400);
        expect((await get('/api/budget/forecast?month=13&year=2026')).status).toBe(400);

        await addEntry({ category: 'Salaire', amount: 1000, date: '2026-06-10', is_expense: false });
        await addRecurring({ label: 'Loyer', amount: 100, category: 'Logement', start_date: '2026-06-01' });

        const res = await get('/api/budget/forecast?month=6&year=2026&as_of=2026-06-15');
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({
            openingBalance: 0,
            oneTimeIncome: 1000,
            oneTimeExpenses: 0,
            dueRecurringExpenses: 100, // occurrence 06-01 <= as_of
            upcomingRecurringExpenses: 0,
            currentBalance: 900,
            forecastBalance: 900,
            // compatibility aliases still present
            income: 1000,
            pointedRecurring: 100,
        });
    });

    it('rejects invalid months / variable_months', async () => {
        for (const q of ['months=0', 'months=25', 'months=abc', 'months=2.5']) {
            expect((await get(`/api/budget/forecast?${q}`)).status).toBe(400);
        }
        expect((await get('/api/budget/forecast?months=3&variable_months=-1')).status).toBe(400);
        expect((await get('/api/budget/forecast?months=3&variable_months=99')).status).toBe(400);
    });

    it('with months=N projects the N following months (recurring + variable average, cumulative from the realized balance)', async () => {
        // Realized history through end of June 2026:
        // - one-off expenses: 200 in May, 400 in June → window (2 months) avg 300
        // - recurring: expense 100/month since January (6 occurrences = 600),
        //   income 3000/month since January (6 = 18000)
        await addEntry({ category: 'Divers', amount: 200, date: '2026-05-05', is_expense: true });
        await addEntry({ category: 'Divers', amount: 400, date: '2026-06-05', is_expense: true });
        await addRecurring({ label: 'Loyer', amount: 100, category: 'Logement', start_date: '2026-01-05' });
        await addRecurring({ label: 'Salaire récurrent', amount: 3000, category: 'Salaire', start_date: '2026-01-05', is_expense: false });
        // A series that ends 2026-08-31: counted in July and August, not September.
        await addRecurring({ label: 'Taxe', amount: 50, category: 'Impots', start_date: '2026-07-10', recurrence_until: '2026-08-31' });

        const res = await get('/api/budget/forecast?months=3&variable_months=2&as_of=2026-06-15');
        expect(res.status).toBe(200);
        const data = res.body.data;
        expect(data.as_of).toBe('2026-06-15');
        expect(data.horizon).toBe(3);
        expect(data.variable_months).toBe(2);
        // opening = entries(−600) + recurring income(18000) − recurring expenses(600)
        expect(data.opening_balance).toBe(16800);
        expect(data.months.map((m: any) => m.month)).toEqual(['2026-07', '2026-08', '2026-09']);
        expect(data.months[0]).toMatchObject({
            recurring_expenses: 150, // 100 loyer + 50 taxe
            recurring_income: 3000,
            estimated_variable: 300,
            projected_expenses: 450,
            projected_income: 3000,
            monthly_balance: 2550,
            cumulative_balance: 16800 + 2550,
        });
        expect(data.months[1].recurring_expenses).toBe(150);
        expect(data.months[2].recurring_expenses).toBe(100); // taxe ended
        expect(data.months[2].cumulative_balance).toBe(16800 + 2550 + 2550 + 2600);
    });

    it('variable_months=0 projects recurring only', async () => {
        await addEntry({ category: 'Divers', amount: 999, date: '2026-06-05', is_expense: true });
        await addRecurring({ label: 'Loyer', amount: 100, category: 'Logement', start_date: '2026-06-01' });
        const res = await get('/api/budget/forecast?months=2&variable_months=0&as_of=2026-06-15');
        expect(res.status).toBe(200);
        expect(res.body.data.variable_months).toBe(0);
        expect(res.body.data.months[0].estimated_variable).toBe(0);
        expect(res.body.data.months[0].projected_expenses).toBe(100);
        // opening still counts the real June entry and occurrence
        expect(res.body.data.opening_balance).toBe(-1099);
    });

    it('is readable by a child account', async () => {
        const child = await makeChild();
        expect((await get('/api/budget/forecast?months=2&as_of=2026-06-15', child.token)).status).toBe(200);
        expect((await get('/api/budget/forecast?month=6&year=2026', child.token)).status).toBe(200);
    });

    it('months=N batches the recurring series in ONE query — output strictly identical to per-month expansion', async () => {
        // Mixed fixture: series starting before / during the horizon, one
        // ending mid-horizon, weekly and yearly frequencies, expense + income.
        await addEntry({ category: 'Divers', amount: 100, date: '2026-05-05', is_expense: true });
        await addEntry({ category: 'Divers', amount: 300, date: '2026-06-05', is_expense: true });
        await addRecurring({ label: 'Loyer', amount: 100, category: 'Logement', start_date: '2026-01-05' });
        await addRecurring({ label: 'Salaire', amount: 3000, category: 'Salaire', start_date: '2026-01-05', is_expense: false });
        await addRecurring({ label: 'Cadeau', amount: 40, category: 'Divers', start_date: '2026-07-15', recurrence_frequency: 'weekly', is_expense: false });
        await addRecurring({ label: 'Taxe', amount: 50, category: 'Impots', start_date: '2026-07-10', recurrence_until: '2026-08-31' });
        await addRecurring({ label: 'Anniv', amount: 200, category: 'Divers', start_date: '2026-09-01', recurrence_frequency: 'yearly' });

        const months = 6;
        const res = await get(`/api/budget/forecast?months=${months}&variable_months=2&as_of=2026-06-15`);
        expect(res.status).toBe(200);
        const data = res.body.data;
        expect(data.months).toHaveLength(months);

        // Independent expectation, computed with the single source of truth
        // (expandRecurringTransactions) per month window — the same expansion
        // the batched route runs in memory.
        const pad = (n: number) => String(n).padStart(2, '0');
        const shift = (y: number, m: number, off: number) => {
            const t = y * 12 + (m - 1) + off;
            return { y: Math.floor(t / 12), m: (t % 12) + 1 };
        };
        const rangeOf = (y: number, m: number) => ({
            start: `${y}-${pad(m)}-01`,
            end: `${y}-${pad(m)}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`,
        });
        const seriesRows = (await query(
            'SELECT * FROM recurring_expenses WHERE user_id = $1 AND is_active = true',
            [parent.user.id]
        )).rows;

        // opening: entries through 2026-06-30 (−400) + recurring occurrences
        // through 2026-06-30 (Loyer 6×100, Salaire 6×3000).
        const histOcc = expandRecurringTransactions(seriesRows, '2026-01-01', '2026-06-30');
        const opening = -400
            + histOcc.reduce((s, o) => s + (o.is_expense ? -Number(o.amount) : Number(o.amount)), 0);
        expect(data.opening_balance).toBe(opening);
        expect(opening).toBe(17000);

        // variable estimate: (100 + 300) / 2 = 200 per month, no income entries.
        let cumulative = opening;
        const expected = [];
        for (let i = 1; i <= months; i++) {
            const { y, m } = shift(2026, 6, i);
            const range = rangeOf(y, m);
            const occ = expandRecurringTransactions(seriesRows, range.start, range.end);
            const recExp = occ.reduce((s, o) => s + (o.is_expense ? Number(o.amount) : 0), 0);
            const recInc = occ.reduce((s, o) => s + (o.is_expense ? 0 : Number(o.amount)), 0);
            const projectedExpenses = recExp + 200;
            const projectedIncome = recInc;
            const monthlyBalance = projectedIncome - projectedExpenses;
            cumulative += monthlyBalance;
            expected.push({
                month: `${y}-${pad(m)}`,
                recurring_expenses: recExp,
                recurring_income: recInc,
                estimated_variable: 200,
                estimated_variable_income: 0,
                projected_expenses: projectedExpenses,
                projected_income: projectedIncome,
                monthly_balance: monthlyBalance,
                cumulative_balance: cumulative,
            });
        }
        // Strict output equivalence, month by month, field by field.
        expect(data.months).toEqual(expected);
        // Sanity on the tricky series: Taxe (until 2026-08-31) in Jul/Aug only,
        // Cadeau (weekly from 2026-07-15) 5 occurrences in September,
        // Anniv (yearly 2026-09-01) in September only.
        expect(data.months[0].month).toBe('2026-07');
        expect(data.months[0].recurring_expenses).toBe(150); // loyer 100 + taxe 50
        expect(data.months[2].month).toBe('2026-09');
        expect(data.months[2].recurring_expenses).toBe(300); // loyer 100 + anniv 200 ; taxe ended
        expect(data.months[2].recurring_income).toBe(3200); // salaire 3000 + cadeau 5×40
    });
});
