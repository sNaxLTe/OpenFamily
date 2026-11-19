import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app, query, registerWithPassword, resetState, startSuite, stopSuite } from './helpers';

// Lot 1 of the annual-budget fork: the annual/0001 migration (reminder_days on
// recurring_expenses) and GET /api/budget/statistics/annual, which must agree
// with GET /api/budget/statistics/monthly month by month (same 12-month series:
// one-off entries + virtual recurring occurrences).

beforeAll(startSuite);
afterAll(stopSuite);

let parent: { token: string; user: { id: string } };

beforeEach(async () => {
    await resetState();
    parent = await registerWithPassword('parent@example.org');
});

const asParent = (token: string) => ({ Authorization: `Bearer ${token}` });

const addEntry = (body: unknown) =>
    request(app).post('/api/budget/entries').set(asParent(parent.token)).send(body as object);
const addRecurring = (body: unknown) =>
    request(app).post('/api/budget/recurring').set(asParent(parent.token)).send(body as object);
const annual = async (year: number | string) =>
    (await request(app).get(`/api/budget/statistics/annual?year=${year}`).set(asParent(parent.token))).body;
const monthly = async (year: number) =>
    (await request(app).get(`/api/budget/statistics/monthly?year=${year}`).set(asParent(parent.token))).body;

describe('migration annual/0001', () => {
    it('is recorded and added a nullable reminder_days to recurring_expenses (out-of-range refused)', async () => {
        const recorded = await query(
            "SELECT id FROM openfamily_schema_migrations WHERE id = 'annual/0001-recurring-reminder-days'"
        );
        expect(recorded.rows).toHaveLength(1);

        const column = await query(
            `SELECT is_nullable FROM information_schema.columns
             WHERE table_name = 'recurring_expenses' AND column_name = 'reminder_days'`
        );
        expect(column.rows[0]?.is_nullable).toBe('YES');

        const series = (await addRecurring({ label: 'Loyer', amount: 800, category: 'Logement', start_date: '2026-01-05' })).body.data;
        expect(series.reminder_days).toBeNull();
        await query('UPDATE recurring_expenses SET reminder_days = 3 WHERE id = $1', [series.id]);
        await expect(query(
            'UPDATE recurring_expenses SET reminder_days = 400 WHERE id = $1',
            [series.id]
        )).rejects.toThrow();
    });
});

describe('GET /api/budget/statistics/annual', () => {
    it('requires a valid year and a token', async () => {
        const anonymous = await request(app).get('/api/budget/statistics/annual?year=2026');
        expect(anonymous.status).toBe(401);
        const missing = await request(app).get('/api/budget/statistics/annual').set(asParent(parent.token));
        expect(missing.status).toBe(400);
        const notAYear = await request(app).get('/api/budget/statistics/annual?year=abc').set(asParent(parent.token));
        expect(notAYear.status).toBe(400);
    });

    it('returns zeros and null best/worst months for a year without data', async () => {
        const body = await annual(2026);
        expect(body.success).toBe(true);
        expect(body.data).toMatchObject({
            year: 2026,
            totalIncome: 0,
            totalExpenses: 0,
            balance: 0,
            savingsRate: 0,
            monthlyAverage: 0,
            bestMonth: null,
            worstMonth: null,
            previousYear: { totalIncome: 0, totalExpenses: 0, balance: 0 },
        });
    });

    it('sums the same 12-month series as /statistics/monthly (entries + recurring occurrences)', async () => {
        // One-off entries in 2026: salary in January, groceries in March.
        await addEntry({ category: 'Salaire', amount: 3000, description: 'Jan', date: '2026-01-10', is_expense: false });
        await addEntry({ category: 'Alimentation', amount: 200, description: 'Mar', date: '2026-03-12', is_expense: true });
        await addEntry({ category: 'Alimentation', amount: 300, description: 'Mar2', date: '2026-03-20', is_expense: true });
        // Monthly recurring expense of 800 starting January, plus a yearly
        // insurance of 120 in June 2026 only.
        await addRecurring({ label: 'Loyer', amount: 800, category: 'Logement', start_date: '2026-01-05' });
        await addRecurring({
            label: 'Assurance', amount: 120, category: 'Assurance', start_date: '2026-06-15',
            recurrence_frequency: 'yearly', recurrence_until: '2026-12-31',
        });
        // A series that ended in 2024 must count neither in 2026 nor in 2025.
        await addRecurring({
            label: 'Vieux truc', amount: 50, category: 'Autre', start_date: '2024-01-10',
            recurrence_until: '2024-12-31',
        });
        // Previous year activity, for the comparison.
        await addEntry({ category: 'Salaire', amount: 2900, date: '2025-01-10', is_expense: false });
        await addEntry({ category: 'Loisirs', amount: 100, date: '2025-02-10', is_expense: true });

        const monthlyBody = await monthly(2026);
        expect(monthlyBody.success).toBe(true);
        expect(monthlyBody.data).toHaveLength(12);
        // Shape of the existing monthly route is untouched.
        expect(monthlyBody.data[0]).toEqual({
            month: 1, totalExpenses: 800, totalIncome: 3000,
            recurringExpenses: 800, recurringIncome: 0, balance: 2200,
        });
        expect(monthlyBody.data[2]).toMatchObject({ month: 3, totalExpenses: 1300, totalIncome: 0, balance: -1300 });
        expect(monthlyBody.data[5]).toMatchObject({ month: 6, recurringExpenses: 920, totalExpenses: 920 });

        const body = await annual(2026);
        expect(body.success).toBe(true);

        const sumIncome = monthlyBody.data.reduce((s: number, m: any) => s + m.totalIncome, 0);
        const sumExpenses = monthlyBody.data.reduce((s: number, m: any) => s + m.totalExpenses, 0);
        expect(body.data.totalIncome).toBe(sumIncome); // 3000
        expect(body.data.totalExpenses).toBe(sumExpenses); // 12*800 + 120 + 500 = 10220
        expect(body.data.balance).toBe(sumIncome - sumExpenses);
        expect(body.data.savingsRate).toBeCloseTo((sumIncome - sumExpenses) / sumIncome);
        expect(body.data.monthlyAverage).toBeCloseTo((sumIncome - sumExpenses) / 12);
        expect(body.data.bestMonth).toEqual({ month: 1, balance: 2200 });
        expect(body.data.worstMonth).toEqual({ month: 3, balance: -1300 });
        expect(body.data.previousYear).toEqual({ totalIncome: 2900, totalExpenses: 100, balance: 2800 });
    });
});
