import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app, query, registerWithPassword, resetState, startSuite, stopSuite } from './helpers';
import { coreMigrations } from '../src/migrations/registry';
import { annualMigrations } from '../src/migrations/annual';
import { validateRegistry } from '../src/migrations/runner';
import { advanceTaskDueDate, nextTaskDueDateOnComplete } from '../src/lib/taskRecurrence';
import { formatDateOnly, parseDateOnly } from '../src/lib/budgetRecurrence';

// Post-version n°2, partie B1 : auto-gestion des tâches récurrentes.
// - migration annual/0006 (tasks.recurrence_anchor, additif)
// - avance de l'échéance à la complétion, dans la même écriture (PUT /tasks)
// - reset paresseux au GET /api/tasks (jamais via la route d'édition,
//   jamais sur pending_approval, jamais sur les retards, « Une fois » intact)

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

/** Date-only (UTC, comme le serveur) décalée de n jours. */
const d = (offsetDays: number): string => formatDateOnly(new Date(Date.now() + offsetDays * 86400000));
const dayOf = (value: unknown): string => String(value).slice(0, 10);

const createTask = async (body: Record<string, unknown>): Promise<any> => {
    const res = await post('/api/tasks', { title: 'Corvée', ...body });
    expect(res.status).toBe(200);
    return res.body.data;
};

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

const makeMember = async (): Promise<string> => {
    const res = await query(
        "INSERT INTO family_members (user_id, name, color) VALUES ($1, 'Kid', '#16A34A') RETURNING id",
        [parent.user.id]
    );
    return res.rows[0].id as string;
};

describe('migration annual/0006', () => {
    it('validates in the combined registry, is recorded, and added the nullable column', async () => {
        expect(() => validateRegistry([...coreMigrations, ...annualMigrations])).not.toThrow();
        const ids = annualMigrations.map((m) => m.id);
        expect(ids).toContain('annual/0006-tasks-recurrence-anchor');
        const recorded = await query(
            "SELECT id FROM openfamily_schema_migrations WHERE id = 'annual/0006-tasks-recurrence-anchor'"
        );
        expect(recorded.rows.length).toBe(1);
        const col = await query(
            "SELECT is_nullable FROM information_schema.columns WHERE table_name = 'tasks' AND column_name = 'recurrence_anchor'"
        );
        expect(col.rows.length).toBe(1);
        expect(col.rows[0].is_nullable).toBe('YES');
    });
});

describe('unit: advanceTaskDueDate / nextTaskDueDateOnComplete', () => {
    it('clamps the day to the last day of the target month (31 → February)', () => {
        expect(formatDateOnly(advanceTaskDueDate(parseDateOnly('2026-01-31')!, 'Mensuel'))).toBe('2026-02-28');
        // Année bissextile : 29 février existe en 2028.
        expect(formatDateOnly(advanceTaskDueDate(parseDateOnly('2028-01-31')!, 'Mensuel'))).toBe('2028-02-29');
        expect(formatDateOnly(advanceTaskDueDate(parseDateOnly('2028-02-29')!, 'Annuel'))).toBe('2029-02-28');
        expect(formatDateOnly(advanceTaskDueDate(parseDateOnly('2026-03-31')!, 'Trimestriel'))).toBe('2026-06-30');
        expect(formatDateOnly(advanceTaskDueDate(parseDateOnly('2026-03-31')!, 'Quadrimestriel'))).toBe('2026-07-31');
        expect(formatDateOnly(advanceTaskDueDate(parseDateOnly('2026-05-10')!, 'Hebdomadaire'))).toBe('2026-05-17');
        expect(formatDateOnly(advanceTaskDueDate(parseDateOnly('2026-05-10')!, 'Quotidien'))).toBe('2026-05-11');
    });

    it('calendar anchor: next occurrence of the pattern from tomorrow', () => {
        const completed = parseDateOnly(d(0))!;
        // Due yesterday, hebdo, completed today → next cycle (+7 from the due date).
        expect(nextTaskDueDateOnComplete(null, d(-1), 'Hebdomadaire', completed)).toBe(d(6));
        // Due tomorrow, completed today → unchanged (completed in advance).
        expect(nextTaskDueDateOnComplete('calendar', d(1), 'Hebdomadaire', completed)).toBe(d(1));
        // Due today, completed today → next week (tomorrow has passed the due date).
        expect(nextTaskDueDateOnComplete('calendar', d(0), 'Hebdomadaire', completed)).toBe(d(7));
        // Monthly due yesterday, completed today → one monthly step (clamped),
        // i.e. the first occurrence of the pattern from tomorrow.
        expect(nextTaskDueDateOnComplete('calendar', d(-1), 'Mensuel', completed))
            .toBe(formatDateOnly(advanceTaskDueDate(parseDateOnly(d(-1))!, 'Mensuel')));
    });

    it('completion anchor: completion date + one period', () => {
        const completed = parseDateOnly(d(0))!;
        expect(nextTaskDueDateOnComplete('completion', d(-1), 'Hebdomadaire', completed)).toBe(d(7));
        expect(nextTaskDueDateOnComplete('completion', d(10), 'Quotidien', completed)).toBe(d(1));
        expect(nextTaskDueDateOnComplete('completion', jan31(), 'Mensuel', parseDateOnly('2026-02-10')!)).toBe('2026-03-10');
        function jan31() { return '2026-01-31'; }
    });

    it('completion anchor clamps the completion date too (Jan 31 + 1 month → Feb 28)', () => {
        expect(nextTaskDueDateOnComplete('completion', d(-1), 'Mensuel', parseDateOnly('2026-01-31')!)).toBe('2026-02-28');
        expect(nextTaskDueDateOnComplete('completion', d(-1), 'Annuel', parseDateOnly('2028-02-29')!)).toBe('2029-02-28');
    });

    it('never advances a one-shot or undated task', () => {
        const completed = parseDateOnly(d(0))!;
        expect(nextTaskDueDateOnComplete(null, d(-1), 'Une fois', completed)).toBeNull();
        expect(nextTaskDueDateOnComplete(null, d(-1), null, completed)).toBeNull();
        expect(nextTaskDueDateOnComplete(null, null, 'Hebdomadaire', completed)).toBeNull();
    });
});

describe('POST /api/tasks accepts recurrence_anchor', () => {
    it('stores a valid anchor, defaults to NULL, rejects anything else', async () => {
        const a = await createTask({ recurrence_anchor: 'completion' });
        expect(a.recurrence_anchor).toBe('completion');
        const b = await createTask({});
        expect(b.recurrence_anchor).toBeNull();
        const c = await createTask({ recurrence_anchor: null });
        expect(c.recurrence_anchor).toBeNull();
        const bad = await post('/api/tasks', { title: 'X', recurrence_anchor: 'bogus' });
        expect(bad.status).toBe(400);
    });
});

describe('PUT /api/tasks/:id advances the due date on completion (same write)', () => {
    it('calendar anchor: weekly due yesterday → +7 days from the due date', async () => {
        const t = await createTask({ frequency: 'Hebdomadaire', due_date: d(-1) });
        const res = await put(`/api/tasks/${t.id}`, { is_completed: true });
        expect(res.status).toBe(200);
        expect(dayOf(res.body.data.due_date)).toBe(d(6));
        expect(res.body.data.is_completed).toBe(true);
    });

    it('calendar anchor: completed in advance keeps the due date', async () => {
        const t = await createTask({ frequency: 'Hebdomadaire', due_date: d(3) });
        const res = await put(`/api/tasks/${t.id}`, { is_completed: true });
        expect(dayOf(res.body.data.due_date)).toBe(d(3));
    });

    it('completion anchor: due date = completion date + period', async () => {
        const t = await createTask({ frequency: 'Hebdomadaire', due_date: d(-1), recurrence_anchor: 'completion' });
        const res = await put(`/api/tasks/${t.id}`, { is_completed: true });
        expect(dayOf(res.body.data.due_date)).toBe(d(7));
    });

    it('an explicit due_date in the same PUT wins over the automatic advance', async () => {
        const t = await createTask({ frequency: 'Hebdomadaire', due_date: d(-1) });
        const res = await put(`/api/tasks/${t.id}`, { is_completed: true, due_date: '2030-01-15' });
        expect(dayOf(res.body.data.due_date)).toBe('2030-01-15');
    });

    it('one-shot tasks are never advanced', async () => {
        const t = await createTask({ frequency: 'Une fois', due_date: d(-1) });
        const res = await put(`/api/tasks/${t.id}`, { is_completed: true });
        expect(dayOf(res.body.data.due_date)).toBe(d(-1));
    });

    it('repeated is_completed=true PUTs do not advance twice', async () => {
        const t = await createTask({ frequency: 'Quotidien', due_date: d(-1) });
        const first = await put(`/api/tasks/${t.id}`, { is_completed: true });
        // Quotidien due hier, cochée aujourd'hui → prochaine occurrence à
        // partir de demain = demain.
        expect(dayOf(first.body.data.due_date)).toBe(d(1));
        const second = await put(`/api/tasks/${t.id}`, { is_completed: true });
        expect(dayOf(second.body.data.due_date)).toBe(d(1));
    });

    it('PUT updates recurrence_anchor, validates it, and accepts null (back to calendar)', async () => {
        const t = await createTask({ frequency: 'Mensuel', due_date: d(5) });
        const upd = await put(`/api/tasks/${t.id}`, { recurrence_anchor: 'Completion' });
        expect(upd.status).toBe(200);
        expect(upd.body.data.recurrence_anchor).toBe('completion');
        const bad = await put(`/api/tasks/${t.id}`, { recurrence_anchor: 'nope' });
        expect(bad.status).toBe(400);
        const reset = await put(`/api/tasks/${t.id}`, { recurrence_anchor: null });
        expect(reset.body.data.recurrence_anchor).toBeNull();
    });
});

describe('GET /api/tasks lazily resets elapsed recurring cycles', () => {
    it('resets a completed recurring task whose due date has passed (idempotent)', async () => {
        const t = await createTask({ frequency: 'Hebdomadaire', due_date: d(-10) });
        await put(`/api/tasks/${t.id}`, { is_completed: true });
        // Simule l'écoulement du cycle (reboot/vacances) : échéance passée.
        await query('UPDATE tasks SET due_date = $2 WHERE id = $1', [t.id, d(-1)]);

        const first = await get('/api/tasks');
        const row1 = first.body.data.find((x: any) => x.id === t.id);
        expect(row1.is_completed).toBe(false);
        expect(row1.completed_at).toBeNull();

        const second = await get('/api/tasks');
        const row2 = second.body.data.find((x: any) => x.id === t.id);
        expect(row2.is_completed).toBe(false);
        expect(row2.completed_at).toBeNull();
    });

    it('never resets pending_approval (parent arbitration stays possible)', async () => {
        const child = await makeChild();
        const memberId = await makeMember();
        const t = await createTask({
            frequency: 'Hebdomadaire', due_date: d(-10), points: 5, assigned_to: [memberId],
        });
        const done = await put(`/api/tasks/${t.id}`, { is_completed: true }, child.token);
        expect(done.body.data.pending_approval).toBe(true);
        expect(done.body.data.is_completed).toBe(true);
        await query('UPDATE tasks SET due_date = $2 WHERE id = $1', [t.id, d(-1)]);

        const list = await get('/api/tasks');
        const row = list.body.data.find((x: any) => x.id === t.id);
        expect(row.is_completed).toBe(true);
        expect(row.pending_approval).toBe(true);
    });

    it('keeps the reward_transactions of the elapsed cycle (direct UPDATE only)', async () => {
        const memberId = await makeMember();
        const t = await createTask({
            frequency: 'Hebdomadaire', due_date: d(-10), points: 5, assigned_to: [memberId],
        });
        await put(`/api/tasks/${t.id}`, { is_completed: true });
        const before = await query('SELECT COUNT(*)::int AS n FROM reward_transactions WHERE task_id = $1', [t.id]);
        expect(before.rows[0].n).toBe(1);

        await query('UPDATE tasks SET due_date = $2 WHERE id = $1', [t.id, d(-1)]);
        const list = await get('/api/tasks');
        const row = list.body.data.find((x: any) => x.id === t.id);
        expect(row.is_completed).toBe(false);

        const after = await query('SELECT COUNT(*)::int AS n FROM reward_transactions WHERE task_id = $1', [t.id]);
        expect(after.rows[0].n).toBe(1);
    });

    it('never erases overdue (uncompleted) tasks and leaves one-shot/NULL frequencies alone', async () => {
        const overdue = await createTask({ frequency: 'Hebdomadaire', due_date: d(-2) });
        const oneShot = await createTask({ frequency: 'Une fois', due_date: d(-5) });
        await put(`/api/tasks/${oneShot.id}`, { is_completed: true });
        const noFreq = await createTask({ due_date: d(-5) });
        await put(`/api/tasks/${noFreq.id}`, { is_completed: true });

        const list = await get('/api/tasks');
        const byId = new Map(list.body.data.map((x: any) => [x.id, x]));
        expect(byId.get(overdue.id).is_completed).toBe(false);
        expect(dayOf(byId.get(overdue.id).due_date)).toBe(d(-2));
        expect(byId.get(oneShot.id).is_completed).toBe(true);
        expect(byId.get(noFreq.id).is_completed).toBe(true);
    });

    it('a completed recurring task with a FUTURE due date stays completed (reset at next cycle)', async () => {
        const t = await createTask({ frequency: 'Hebdomadaire', due_date: d(3) });
        await put(`/api/tasks/${t.id}`, { is_completed: true });
        const list = await get('/api/tasks');
        const row = list.body.data.find((x: any) => x.id === t.id);
        expect(row.is_completed).toBe(true);
        expect(dayOf(row.due_date)).toBe(d(3));
    });
});
