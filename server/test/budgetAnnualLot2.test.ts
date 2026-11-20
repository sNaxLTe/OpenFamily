import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app, query, registerWithPassword, resetState, startSuite, stopSuite } from './helpers';
import { coreMigrations } from '../src/migrations/registry';
import { annualMigrations } from '../src/migrations/annual';
import { validateRegistry } from '../src/migrations/runner';
import { checkBudgetReminders, pruneBudgetReminderLog } from '../src/lib/budgetReminderScheduler';
import { addDays, dayInZone, instantInZone } from '../src/lib/timeZone';

// Lot 2 of the annual-budget fork:
// - GET /api/budget/recurring/schedule?start_date&end_date (feature 2)
// - PUT /api/budget/recurring/:id/reminder (feature 3)
// - migrations annual/0002 (annual limits, month NULL) + annual/0003
//   (annual_reminder_log) and the /api/budget/limits/annual routes (feature 4)
// - the budget reminder job: idempotence, catch-up after reboot, family zone

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
const del = (path: string, token = parent.token) => request(app).delete(path).set(as(token));

const addRecurring = (body: unknown) => post('/api/budget/recurring', body);

/** Register a second account and make it a child of the parent's family. */
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

describe('migrations annual/0002 and annual/0003', () => {
    it('validate in the combined registry and are recorded in the database', async () => {
        expect(() => validateRegistry([...coreMigrations, ...annualMigrations])).not.toThrow();
        const ids = annualMigrations.map((m) => m.id);
        expect(ids).toEqual(expect.arrayContaining([
            'annual/0001-recurring-reminder-days',
            'annual/0002-annual-budget-limits',
            'annual/0003-budget-reminder-log',
        ]));
        // Ordered, unique, and each one applied exactly once.
        expect(new Set(ids).size).toBe(ids.length);
        expect([...ids].sort()).toEqual(ids);
        const recorded = await query(
            "SELECT id FROM openfamily_schema_migrations WHERE id LIKE 'annual/%' ORDER BY id"
        );
        expect(recorded.rows.map((r) => r.id)).toEqual([...ids].sort());
    });

    it('made budget_limits.month nullable and enforces one annual row per (user, category, year)', async () => {
        const column = await query(
            `SELECT is_nullable FROM information_schema.columns
             WHERE table_name = 'budget_limits' AND column_name = 'month'`
        );
        expect(column.rows[0]?.is_nullable).toBe('YES');

        await query(
            `INSERT INTO budget_limits (user_id, category, monthly_limit, month, year)
             VALUES ($1, 'Alimentation', 6000, NULL, 2026)`,
            [parent.user.id]
        );
        await expect(query(
            `INSERT INTO budget_limits (user_id, category, monthly_limit, month, year)
             VALUES ($1, 'Alimentation', 7000, NULL, 2026)`,
            [parent.user.id]
        )).rejects.toThrow();
        // A monthly row on the same category/year is still allowed and distinct.
        await query(
            `INSERT INTO budget_limits (user_id, category, monthly_limit, month, year)
             VALUES ($1, 'Alimentation', 500, 6, 2026)`,
            [parent.user.id]
        );
    });
});

describe('GET /api/budget/recurring — registry mode (no month/year, post-version n°2)', () => {
    it('returns one entry per series (active + ended) with next occurrence and annual committed', async () => {
        await addRecurring({ label: 'Loyer', amount: 100, category: 'Logement', start_date: '2026-01-05' });
        await addRecurring({ label: 'Annuel', amount: 500, category: 'Divers', start_date: '2027-03-01', recurrence_frequency: 'yearly' });
        await addRecurring({ label: 'Hebdo', amount: 10, category: 'Divers', start_date: '2026-06-01', recurrence_frequency: 'weekly', recurrence_interval: 2 });
        await addRecurring({ label: 'Quotidien', amount: 1, category: 'Divers', start_date: '2026-06-01', recurrence_frequency: 'daily' });
        await addRecurring({ label: 'Vieux', amount: 50, category: 'Divers', start_date: '2026-01-10', recurrence_until: '2026-05-31' });
        const off = (await addRecurring({ label: 'Inactif', amount: 30, category: 'Divers', start_date: '2026-01-10' })).body.data;
        await query('UPDATE recurring_expenses SET is_active = false WHERE id = $1', [off.id]);

        const res = await get('/api/budget/recurring?as_of=2026-06-15');
        expect(res.status).toBe(200);
        const rows = res.body.data;
        expect(rows).toHaveLength(6);
        const byLabel = Object.fromEntries(rows.map((r: any) => [r.label, r]));

        // Next occurrence = first >= as_of (2026-06-15), recurrence_until respected.
        expect(byLabel['Loyer'].next_occurrence).toBe('2026-07-05');
        expect(byLabel['Annuel'].next_occurrence).toBe('2027-03-01');
        expect(byLabel['Vieux'].next_occurrence).toBeNull(); // recurrence_until 2026-05-31 passed
        expect(byLabel['Inactif'].next_occurrence).toBeNull(); // is_active = false

        // Annual committed: amount × (365|52|12|1) / interval.
        expect(byLabel['Loyer'].annual_committed).toBe(1200);   // 100 × 12
        expect(byLabel['Annuel'].annual_committed).toBe(500);   // 500 × 1
        expect(byLabel['Hebdo'].annual_committed).toBe(260);    // 10 × 52 / 2
        expect(byLabel['Quotidien'].annual_committed).toBe(365); // 1 × 365

        // Current-month occurrence for pointing: Loyer has 2026-06-05 in June;
        // as_of is the 15th → first ahead this month = none → last of month.
        expect(byLabel['Loyer'].current_occurrence.occurrence_date).toBe('2026-06-05');
        expect(byLabel['Loyer'].current_occurrence.occurrence_id).toBe(`${byLabel['Loyer'].id}:2026-06-05`);
        expect(byLabel['Loyer'].current_occurrence.is_pointed).toBe(false);
        expect(byLabel['Vieux'].current_occurrence).toBeNull();
        expect(byLabel['Inactif'].current_occurrence).toBeNull();
    });

    it('current_occurrence is pointable through the SAME endpoint as the month view, which stays unchanged', async () => {
        const s = (await addRecurring({ label: 'Loyer', amount: 800, category: 'Logement', start_date: '2026-06-12' })).body.data;
        const reg = await get('/api/budget/recurring?as_of=2026-06-15');
        const row = reg.body.data[0];
        expect(row.id).toBe(s.id);
        expect(row.current_occurrence.occurrence_date).toBe('2026-06-12');
        expect(row.next_occurrence).toBe('2026-07-12');

        const pr = await post(`/api/budget/recurring/${row.id}/point`, { occurrence_date: '2026-06-12', is_pointed: true });
        expect(pr.status).toBe(200);

        const reg2 = await get('/api/budget/recurring?as_of=2026-06-15');
        expect(reg2.body.data[0].current_occurrence.is_pointed).toBe(true);

        // Month view contract strictly unchanged: occurrence rows, no registry fields.
        const monthView = await get('/api/budget/recurring?month=6&year=2026');
        expect(monthView.status).toBe(200);
        expect(monthView.body.data[0].occurrence_date).toBe('2026-06-12');
        expect(monthView.body.data[0].is_pointed).toBe(true);
        expect(monthView.body.data[0].next_occurrence).toBeUndefined();
        expect(monthView.body.data[0].annual_committed).toBeUndefined();
    });
});

describe('GET /api/budget/recurring/schedule', () => {
    it('needs a token and valid dates', async () => {
        expect((await request(app).get('/api/budget/recurring/schedule?start_date=2026-06-01&end_date=2026-06-30')).status).toBe(401);
        expect((await get('/api/budget/recurring/schedule')).status).toBe(400);
        expect((await get('/api/budget/recurring/schedule?start_date=2026-06-01')).status).toBe(400);
        expect((await get('/api/budget/recurring/schedule?start_date=xx&end_date=2026-06-30')).status).toBe(400);
        expect((await get('/api/budget/recurring/schedule?start_date=2026-06-30&end_date=2026-06-01')).status).toBe(400);
        expect((await get('/api/budget/recurring/schedule?start_date=2020-01-01&end_date=2026-12-31')).status).toBe(400);
    });

    it('returns virtual occurrences over the range, sorted, with series fields', async () => {
        const loyer = (await addRecurring({ label: 'Loyer', amount: 800, category: 'Logement', start_date: '2026-01-05' })).body.data;
        const courses = (await addRecurring({ label: 'Courses', amount: 50, category: 'Alimentation', start_date: '2026-06-01', recurrence_frequency: 'weekly' })).body.data;
        await addRecurring({ label: 'Assurance', amount: 120, category: 'Assurance', start_date: '2026-06-15', recurrence_frequency: 'yearly', recurrence_until: '2026-12-31' });
        // Ended before the range: excluded. Inactive: excluded.
        await addRecurring({ label: 'Vieux', amount: 50, category: 'Autre', start_date: '2025-01-10', recurrence_until: '2026-05-31' });
        const off = (await addRecurring({ label: 'Eteint', amount: 10, category: 'Autre', start_date: '2026-06-02' })).body.data;
        await put(`/api/budget/recurring/${off.id}`, { is_active: false });

        const res = await get('/api/budget/recurring/schedule?start_date=2026-06-01&end_date=2026-06-30');
        expect(res.status).toBe(200);
        const rows = res.body.data as any[];
        expect(rows.map((r) => `${r.occurrence_date}:${r.label}`)).toEqual([
            '2026-06-01:Courses',
            '2026-06-05:Loyer',
            '2026-06-08:Courses',
            '2026-06-15:Assurance',
            '2026-06-15:Courses',
            '2026-06-22:Courses',
            '2026-06-29:Courses',
        ]);
        const first = rows[0];
        expect(first).toMatchObject({
            series_id: courses.id,
            occurrence_id: `${courses.id}:2026-06-01`,
            label: 'Courses',
            amount: 50,
            occurrence_date: '2026-06-01',
            is_expense: true,
            category: 'Alimentation',
        });
        expect(rows.find((r) => r.label === 'Loyer')?.series_id).toBe(loyer.id);
        // The start/end aliases work too.
        const alias = await get('/api/budget/recurring/schedule?start=2026-06-01&end=2026-06-07');
        expect(alias.body.data.map((r: any) => r.label)).toEqual(['Courses', 'Loyer']);
    });

    it('is readable by a child account (read-only rule)', async () => {
        await addRecurring({ label: 'Loyer', amount: 800, category: 'Logement', start_date: '2026-06-05' });
        const child = await makeChild();
        const res = await get('/api/budget/recurring/schedule?start_date=2026-06-01&end_date=2026-06-30', child.token);
        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(1);
    });
});

describe('PUT /api/budget/recurring/:id/reminder', () => {
    it('sets, validates and clears reminder_days', async () => {
        const series = (await addRecurring({ label: 'Loyer', amount: 800, category: 'Logement', start_date: '2026-06-05' })).body.data;
        expect(series.reminder_days).toBeNull();

        const set = await put(`/api/budget/recurring/${series.id}/reminder`, { reminder_days: 3 });
        expect(set.status).toBe(200);
        expect(set.body.data.reminder_days).toBe(3);

        const cleared = await put(`/api/budget/recurring/${series.id}/reminder`, { reminder_days: null });
        expect(cleared.status).toBe(200);
        expect(cleared.body.data.reminder_days).toBeNull();

        for (const bad of [366, -1, 1.5, 'abc', {}]) {
            const res = await put(`/api/budget/recurring/${series.id}/reminder`, { reminder_days: bad });
            expect(res.status).toBe(400);
        }
        expect((await put(`/api/budget/recurring/${series.id}/reminder`, {})).status).toBe(400);
        expect((await put('/api/budget/recurring/00000000-0000-0000-0000-000000000000/reminder', { reminder_days: 2 })).status).toBe(404);
    });

    it('is refused for a child account', async () => {
        const series = (await addRecurring({ label: 'Loyer', amount: 800, category: 'Logement', start_date: '2026-06-05' })).body.data;
        const child = await makeChild();
        const res = await put(`/api/budget/recurring/${series.id}/reminder`, { reminder_days: 3 }, child.token);
        expect(res.status).toBe(403);
        const row = await query('SELECT reminder_days FROM recurring_expenses WHERE id = $1', [series.id]);
        expect(row.rows[0].reminder_days).toBeNull();
    });
});

describe('/api/budget/limits/annual', () => {
    it('creates, lists, upserts and deletes annual limits (month stays NULL)', async () => {
        const created = await put('/api/budget/limits/annual', { category: 'Alimentation', annual_limit: 6000, year: 2026 });
        expect(created.status).toBe(200);
        expect(created.body.data).toMatchObject({ category: 'Alimentation', monthly_limit: 6000, month: null, year: 2026 });

        const updated = await put('/api/budget/limits/annual', { category: 'Alimentation', annual_limit: 7000, year: 2026 });
        expect(updated.status).toBe(200);
        expect(updated.body.data.monthly_limit).toBe(7000);

        await put('/api/budget/limits/annual', { category: 'Logement', annual_limit: 9600, year: 2026 });
        await put('/api/budget/limits/annual', { category: 'Alimentation', annual_limit: 5000, year: 2027 });

        const all = await get('/api/budget/limits/annual');
        expect(all.body.data).toHaveLength(3);
        expect(all.body.data.every((r: any) => r.month === null)).toBe(true);

        const y2026 = await get('/api/budget/limits/annual?year=2026');
        expect(y2026.body.data).toHaveLength(2);
        const y2025 = await get('/api/budget/limits/annual?year=2025');
        expect(y2025.body.data).toHaveLength(0);
        expect((await get('/api/budget/limits/annual?year=abc')).status).toBe(400);

        expect((await put('/api/budget/limits/annual', { category: 'X', year: 2026 })).status).toBe(400);
        expect((await put('/api/budget/limits/annual', { category: 'X', annual_limit: 10, year: 'abc' })).status).toBe(400);

        const id = created.body.data.id;
        expect((await del(`/api/budget/limits/annual/${id}`)).status).toBe(200);
        expect((await del(`/api/budget/limits/annual/${id}`)).status).toBe(404);
        expect((await get('/api/budget/limits/annual?year=2026')).body.data).toHaveLength(1);
    });

    it('leaves the monthly limits untouched: filtered GET and dashboard join never see NULL months', async () => {
        await put('/api/budget/limits/annual', { category: 'Alimentation', annual_limit: 6000, year: 2026 });
        const monthly = await post('/api/budget/limits', { category: 'Alimentation', monthly_limit: 500, month: 6, year: 2026 });
        expect(monthly.status).toBe(200);
        expect(monthly.body.data.month).toBe(6);

        const june = await get('/api/budget/limits?month=6&year=2026');
        expect(june.body.data).toHaveLength(1);
        expect(june.body.data[0].month).toBe(6);
        // The dashboard alert query joins on month equality: NULL never matches.
        const alerts = await query(
            `SELECT COUNT(*)::int AS n FROM budget_limits bl
             WHERE bl.user_id = $1 AND bl.month = 6 AND bl.year = 2026`,
            [parent.user.id]
        );
        expect(alerts.rows[0].n).toBe(1);
    });

    it('writes are refused for a child account, reads are allowed', async () => {
        const child = await makeChild();
        expect((await put('/api/budget/limits/annual', { category: 'X', annual_limit: 10, year: 2026 }, child.token)).status).toBe(403);
        expect((await del('/api/budget/limits/annual/00000000-0000-0000-0000-000000000000', child.token)).status).toBe(403);
        expect((await get('/api/budget/limits/annual', child.token)).status).toBe(200);
    });
});

describe('budget reminder job (feature 3, mécanisme B)', () => {
    const setParis = () => query("UPDATE users SET timezone = 'Europe/Paris' WHERE id = $1", [parent.user.id]);

    const reminderCount = async () =>
        (await query(
            "SELECT COUNT(*)::int AS n FROM notifications WHERE type = 'budget_reminder' AND user_id = $1",
            [parent.user.id]
        )).rows[0].n;

    it('sends once at 09:00 family time on J-X, is idempotent, and never for a passed occurrence', async () => {
        await setParis();
        const series = (await addRecurring({
            label: 'Loyer', amount: 800, category: 'Logement',
            start_date: '2026-06-12', recurrence_frequency: 'monthly',
        })).body.data;
        await put(`/api/budget/recurring/${series.id}/reminder`, { reminder_days: 2 });

        // 2026-06-10 05:00 UTC = 07:00 in Paris: before 09:00 on the reminder day → nothing yet.
        await checkBudgetReminders(new Date('2026-06-10T05:00:00Z'));
        expect(await reminderCount()).toBe(0);

        // 12:00 UTC = 14:00 in Paris, reminder day (occurrence 06-12 minus 2 days): sent.
        await checkBudgetReminders(new Date('2026-06-10T12:00:00Z'));
        expect(await reminderCount()).toBe(1);
        const notif = await query(
            "SELECT title, message, related_id FROM notifications WHERE type = 'budget_reminder' AND user_id = $1",
            [parent.user.id]
        );
        expect(notif.rows[0].title).toContain('Loyer');
        expect(notif.rows[0].message).toContain('800');
        // Intl.RelativeTimeFormat fr, numeric auto: 2 days → "après-demain".
        expect(notif.rows[0].message).toContain('après-demain');
        expect(notif.rows[0].related_id).toBe(series.id);
        const log = await query('SELECT occurrence_date, reminder_days FROM annual_reminder_log');
        expect(log.rows).toEqual([{ occurrence_date: '2026-06-12', reminder_days: 2 }]);

        // Same pass again (overlapping ticks / restart on the same day): still one.
        await checkBudgetReminders(new Date('2026-06-10T12:00:00Z'));
        await checkBudgetReminders(new Date('2026-06-10T18:00:00Z'));
        expect(await reminderCount()).toBe(1);

        // 2026-06-13: the occurrence (06-12) has passed → never sent, even as catch-up.
        await checkBudgetReminders(new Date('2026-06-13T12:00:00Z'));
        expect(await reminderCount()).toBe(1);
    });

    it('catches up after a reboot when the occurrence is still ahead (reboot during J-X)', async () => {
        await setParis();
        const series = (await addRecurring({
            label: 'Assurance', amount: 120, category: 'Assurance',
            start_date: '2026-06-14', recurrence_frequency: 'monthly',
        })).body.data;
        await put(`/api/budget/recurring/${series.id}/reminder`, { reminder_days: 5 });

        // Reminder day was 2026-06-09; the server was down. Boot on 06-13,
        // occurrence 06-14 still ahead → the reminder goes out at boot.
        await checkBudgetReminders(new Date('2026-06-13T12:00:00Z'));
        expect(await reminderCount()).toBe(1);
        const log = await query('SELECT occurrence_date, reminder_days FROM annual_reminder_log');
        expect(log.rows).toEqual([{ occurrence_date: '2026-06-14', reminder_days: 5 }]);

        // A second boot the same day does not resend.
        await checkBudgetReminders(new Date('2026-06-13T20:00:00Z'));
        expect(await reminderCount()).toBe(1);
    });

    it('does nothing for series without reminder_days', async () => {
        await setParis();
        await addRecurring({ label: 'Courses', amount: 50, category: 'Alimentation', start_date: '2026-06-10', recurrence_frequency: 'weekly' });
        await checkBudgetReminders(new Date('2026-06-10T12:00:00Z'));
        expect(await reminderCount()).toBe(0);
        expect((await query('SELECT COUNT(*)::int AS n FROM annual_reminder_log')).rows[0].n).toBe(0);
    });

    it('accepts reminder_days at creation (POST /recurring), validated like the PUT', async () => {
        const created = await addRecurring({
            label: 'Assurance', amount: 120, category: 'Assurance',
            start_date: '2026-06-14', recurrence_frequency: 'monthly',
            reminder_days: 10,
        });
        expect(created.status).toBe(200);
        expect(created.body.data.reminder_days).toBe(10);

        // Absent → no reminder (null), as before.
        const plain = await addRecurring({
            label: 'Courses', amount: 50, category: 'Alimentation',
            start_date: '2026-06-10', recurrence_frequency: 'weekly',
        });
        expect(plain.status).toBe(200);
        expect(plain.body.data.reminder_days).toBeNull();

        // Out of range / not an integer → 400, nothing created.
        for (const bad of [-1, 366, 1.5, 'abc']) {
            const res = await addRecurring({
                label: 'X', amount: 1, category: 'Divers',
                start_date: '2026-06-10', reminder_days: bad,
            });
            expect(res.status).toBe(400);
        }
        expect((await query('SELECT COUNT(*)::int AS n FROM recurring_expenses')).rows[0].n).toBe(2);
    });

    it('stays idempotent with reminder_days=365: prune is by occurrence date, not by row age (regression)', async () => {
        await setParis();
        // J = today on the family's clocks. Yearly series whose only occurrence
        // inside the expansion window [J, J+365] is at J+300; its reminder day
        // (J+300-365 = J-65) is already past, so the first pass sends it once.
        const zone = 'Europe/Paris';
        const now0 = new Date();
        const j = dayInZone(now0, zone);
        const occ = addDays(j, 300);
        const series = (await addRecurring({
            label: 'Cotisation annuelle', amount: 90, category: 'Assurance',
            start_date: occ, recurrence_frequency: 'yearly',
        })).body.data;
        await put(`/api/budget/recurring/${series.id}/reminder`, { reminder_days: 365 });

        await checkBudgetReminders(now0);
        expect(await reminderCount()).toBe(1);
        expect((await query('SELECT occurrence_date, reminder_days FROM annual_reminder_log')).rows)
            .toEqual([{ occurrence_date: occ, reminder_days: 365 }]);

        // 61 days pass since the reminder was sent (row age only).
        await query("UPDATE annual_reminder_log SET sent_at = now() - interval '61 days'");

        // The OLD purge (sent_at < now() - 60 days) would wipe the idempotence
        // row here — proven explicitly: no line survives it past 60 days...
        const oldPurge = await query("DELETE FROM annual_reminder_log WHERE sent_at < now() - interval '60 days'");
        expect(oldPurge.rowCount).toBe(1);
        expect((await query('SELECT COUNT(*)::int AS n FROM annual_reminder_log')).rows[0].n).toBe(0);
        // ...restore the row (still 61 days old), as the production state would be.
        await query(
            `INSERT INTO annual_reminder_log (recurring_expense_id, occurrence_date, reminder_days)
             VALUES ($1, $2::date, 365) ON CONFLICT DO NOTHING`,
            [series.id, occ]
        );
        await query("UPDATE annual_reminder_log SET sent_at = now() - interval '61 days'");

        // The NEW purge is by occurrence: an occurrence still ahead (occ = J+300)
        // keeps its row whatever the row age. On the old code this call deletes
        // the row and the test fails right here.
        await pruneBudgetReminderLog();
        expect((await query('SELECT COUNT(*)::int AS n FROM annual_reminder_log')).rows[0].n).toBe(1);

        // J+61: the occurrence is still ahead and still inside [J+61, J+61+365]
        // → replays send nothing new: exactly one notification, ever.
        const now61 = instantInZone(`${addDays(j, 61)}T12:00:00`, zone);
        await checkBudgetReminders(now61);
        await checkBudgetReminders(new Date(now61.getTime() + 6 * 60 * 60 * 1000));
        expect(await reminderCount()).toBe(1);
        expect((await query('SELECT COUNT(*)::int AS n FROM annual_reminder_log')).rows[0].n).toBe(1);

        // The new purge still cleans up: rows whose occurrence has passed
        // (vs the DB's CURRENT_DATE) are removed, future ones are never touched.
        await query(
            `INSERT INTO annual_reminder_log (recurring_expense_id, occurrence_date, reminder_days)
             VALUES ($1, CURRENT_DATE - interval '2 days', 365) ON CONFLICT DO NOTHING`,
            [series.id]
        );
        await pruneBudgetReminderLog();
        expect((await query('SELECT occurrence_date FROM annual_reminder_log')).rows)
            .toEqual([{ occurrence_date: occ }]);
    });
});
