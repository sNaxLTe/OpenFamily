import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app, query, registerWithPassword, resetState, startSuite, stopSuite } from './helpers';
import { coreMigrations } from '../src/migrations/registry';
import { annualMigrations } from '../src/migrations/annual';
import { validateRegistry } from '../src/migrations/runner';
import {
    advanceTaskDueDate,
    customFrequencyFromRow,
    isValidCustomFrequency,
    nextTaskDueDateOnComplete,
    normalizeCustomFrequencyInput,
} from '../src/lib/taskRecurrence';
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

// ─── Chantier C : fréquences étendues (Semestriel, Personnalisé) ────────────

describe('migration annual/0007', () => {
    it('validates in the combined registry, is recorded, and added the nullable custom columns', async () => {
        expect(() => validateRegistry([...coreMigrations, ...annualMigrations])).not.toThrow();
        const ids = annualMigrations.map((m) => m.id);
        expect(ids).toContain('annual/0007-tasks-custom-frequency');
        const recorded = await query(
            "SELECT id FROM openfamily_schema_migrations WHERE id = 'annual/0007-tasks-custom-frequency'"
        );
        expect(recorded.rows.length).toBe(1);
        const cols = await query(
            "SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'tasks' AND column_name IN ('recurrence_custom_value', 'recurrence_custom_unit') ORDER BY column_name"
        );
        expect(cols.rows.length).toBe(2);
        expect(cols.rows.every((c: any) => c.is_nullable === 'YES')).toBe(true);
    });
});

describe('unit: Semestriel / Personnalisé', () => {
    it('semestriel = +6 mois avec clamp de fin de mois (31 août → 28 février)', () => {
        expect(formatDateOnly(advanceTaskDueDate(parseDateOnly('2026-08-31')!, 'Semestriel'))).toBe('2027-02-28');
        expect(formatDateOnly(advanceTaskDueDate(parseDateOnly('2028-08-31')!, 'Semestriel'))).toBe('2029-02-28');
        expect(formatDateOnly(advanceTaskDueDate(parseDateOnly('2026-01-15')!, 'Semestriel'))).toBe('2026-07-15');
    });

    it('personnalisé jours/mois : un pas = intervalle, clamp pour les mois depuis le 31', () => {
        expect(formatDateOnly(advanceTaskDueDate(parseDateOnly('2026-05-10')!, 'Personnalisé', { value: 5, unit: 'days' }))).toBe('2026-05-15');
        // Tous les 2 mois depuis le 31 → 28/29/30/31 selon le mois cible.
        expect(formatDateOnly(advanceTaskDueDate(parseDateOnly('2025-12-31')!, 'Personnalisé', { value: 2, unit: 'months' }))).toBe('2026-02-28');
        expect(formatDateOnly(advanceTaskDueDate(parseDateOnly('2028-12-31')!, 'Personnalisé', { value: 2, unit: 'months' }))).toBe('2029-02-28');
        expect(formatDateOnly(advanceTaskDueDate(parseDateOnly('2026-03-31')!, 'Personnalisé', { value: 2, unit: 'months' }))).toBe('2026-05-31');
        expect(formatDateOnly(advanceTaskDueDate(parseDateOnly('2026-04-30')!, 'Personnalisé', { value: 2, unit: 'months' }))).toBe('2026-06-30');
    });

    it('personnalisé sans intervalle valide n\'avance jamais (défense anti-garbage)', () => {
        expect(formatDateOnly(advanceTaskDueDate(parseDateOnly('2026-05-10')!, 'Personnalisé', null))).toBe('2026-05-10');
        expect(formatDateOnly(advanceTaskDueDate(parseDateOnly('2026-05-10')!, 'Personnalisé', { value: 9999, unit: 'days' }))).toBe('2026-05-10');
        expect(nextTaskDueDateOnComplete(null, '2026-05-10', 'Personnalisé', parseDateOnly(d(0))!, null)).toBeNull();
        expect(nextTaskDueDateOnComplete('completion', '2026-05-10', 'Personnalisé', parseDateOnly(d(0))!, { value: 0, unit: 'days' })).toBeNull();
    });

    it('validation des inputs custom : bornes jours 1-365 / mois 1-12, unité requise', () => {
        expect(normalizeCustomFrequencyInput(null, null)).toEqual({ ok: true, custom: null });
        expect(normalizeCustomFrequencyInput('', '')).toEqual({ ok: true, custom: null });
        expect(normalizeCustomFrequencyInput(5, 'days')).toEqual({ ok: true, custom: { value: 5, unit: 'days' } });
        expect(normalizeCustomFrequencyInput('12', 'Months')).toEqual({ ok: true, custom: { value: 12, unit: 'months' } });
        expect(normalizeCustomFrequencyInput(365, 'days').ok).toBe(true);
        expect(normalizeCustomFrequencyInput(366, 'days').ok).toBe(false);
        expect(normalizeCustomFrequencyInput(0, 'days').ok).toBe(false);
        expect(normalizeCustomFrequencyInput(13, 'months').ok).toBe(false);
        expect(normalizeCustomFrequencyInput(5, 'weeks').ok).toBe(false);
        expect(normalizeCustomFrequencyInput(5, null).ok).toBe(false);
        expect(normalizeCustomFrequencyInput(null, 'days').ok).toBe(false);
        expect(normalizeCustomFrequencyInput(2.5, 'days').ok).toBe(false);
        expect(isValidCustomFrequency({ value: 5, unit: 'days' })).toBe(true);
        expect(isValidCustomFrequency({ value: 5, unit: 'hours' })).toBe(false);
        expect(customFrequencyFromRow({ recurrence_custom_value: 3, recurrence_custom_unit: 'months' })).toEqual({ value: 3, unit: 'months' });
        expect(customFrequencyFromRow({ recurrence_custom_value: null, recurrence_custom_unit: null })).toBeNull();
        expect(customFrequencyFromRow({ recurrence_custom_value: 500, recurrence_custom_unit: 'days' })).toBeNull();
    });

    it('avance calendrier personnalisée : rattrapage naturel si cochée en retard (tous les 5 jours)', () => {
        const completed = parseDateOnly(d(0))!;
        // Due il y a 12 jours, tous les 5 jours → occurrences -12, -7, -2, +3 →
        // première occurrence >= demain (+1) = +3.
        expect(nextTaskDueDateOnComplete('calendar', d(-12), 'Personnalisé', completed, { value: 5, unit: 'days' }))
            .toBe(d(3));
        // Hebdo cochée 3 semaines en retard → occurrences -21, -14, -7, 0, +7 →
        // première >= demain (+1) = +7 (mardi suivant).
        expect(nextTaskDueDateOnComplete('calendar', d(-21), 'Hebdomadaire', completed)).toBe(d(7));
    });

    it('avance complétion personnalisée : date de complétion + intervalle', () => {
        expect(nextTaskDueDateOnComplete('completion', d(-12), 'Personnalisé', parseDateOnly(d(0))!, { value: 5, unit: 'days' }))
            .toBe(d(5));
        expect(nextTaskDueDateOnComplete('completion', d(-1), 'Personnalisé', parseDateOnly('2025-12-31')!, { value: 2, unit: 'months' }))
            .toBe('2026-02-28');
        expect(nextTaskDueDateOnComplete('completion', d(-1), 'Semestriel', parseDateOnly('2026-08-31')!))
            .toBe('2027-02-28');
    });
});

describe('POST /api/tasks — validation Personnalisé', () => {
    it('exige valeur + unité pour Personnalisé, et les interdit ailleurs', async () => {
        const bad1 = await post('/api/tasks', { title: 'X', frequency: 'Personnalisé' });
        expect(bad1.status).toBe(400);
        const bad2 = await post('/api/tasks', { title: 'X', frequency: 'Personnalisé', recurrence_custom_value: 5 });
        expect(bad2.status).toBe(400);
        const bad3 = await post('/api/tasks', { title: 'X', frequency: 'Personnalisé', recurrence_custom_value: 366, recurrence_custom_unit: 'days' });
        expect(bad3.status).toBe(400);
        const bad4 = await post('/api/tasks', { title: 'X', frequency: 'Personnalisé', recurrence_custom_value: 13, recurrence_custom_unit: 'months' });
        expect(bad4.status).toBe(400);
        const bad5 = await post('/api/tasks', { title: 'X', frequency: 'Personnalisé', recurrence_custom_value: 5, recurrence_custom_unit: 'weeks' });
        expect(bad5.status).toBe(400);
        // Colonnes custom renseignées avec une autre fréquence → 400.
        const bad6 = await post('/api/tasks', { title: 'X', frequency: 'Mensuel', recurrence_custom_value: 5, recurrence_custom_unit: 'days' });
        expect(bad6.status).toBe(400);

        const ok = await createTask({ frequency: 'Personnalisé', recurrence_custom_value: 5, recurrence_custom_unit: 'days' });
        expect(ok.frequency).toBe('Personnalisé');
        expect(ok.recurrence_custom_value).toBe(5);
        expect(ok.recurrence_custom_unit).toBe('days');
        const plain = await createTask({ frequency: 'Semestriel' });
        expect(plain.recurrence_custom_value).toBeNull();
        expect(plain.recurrence_custom_unit).toBeNull();
    });
});

describe('PUT /api/tasks/:id — Personnalisé et Semestriel', () => {
    it('semestriel : la complétion avance de 6 mois (clamp fin de mois)', async () => {
        const t = await createTask({ frequency: 'Semestriel', due_date: d(-1) });
        const res = await put(`/api/tasks/${t.id}`, { is_completed: true });
        expect(res.status).toBe(200);
        expect(dayOf(res.body.data.due_date))
            .toBe(formatDateOnly(advanceTaskDueDate(parseDateOnly(d(-1))!, 'Semestriel')));
    });

    it('personnalisé tous les 5 jours : avance calendrier (rattrapage) et complétion', async () => {
        const cal = await createTask({ frequency: 'Personnalisé', recurrence_custom_value: 5, recurrence_custom_unit: 'days', due_date: d(-12) });
        const r1 = await put(`/api/tasks/${cal.id}`, { is_completed: true });
        expect(dayOf(r1.body.data.due_date)).toBe(d(3));

        const comp = await createTask({
            frequency: 'Personnalisé', recurrence_custom_value: 5, recurrence_custom_unit: 'days',
            recurrence_anchor: 'completion', due_date: d(-12),
        });
        const r2 = await put(`/api/tasks/${comp.id}`, { is_completed: true });
        expect(dayOf(r2.body.data.due_date)).toBe(d(5));
    });

    it('édition d\'une Personnalisé : nouvelles valeurs rechargées, PUT partiel sans custom ne casse rien', async () => {
        const t = await createTask({ frequency: 'Personnalisé', recurrence_custom_value: 5, recurrence_custom_unit: 'days' });
        const r1 = await put(`/api/tasks/${t.id}`, { recurrence_custom_value: 2, recurrence_custom_unit: 'months' });
        expect(r1.status).toBe(200);
        expect(r1.body.data.recurrence_custom_value).toBe(2);
        expect(r1.body.data.recurrence_custom_unit).toBe('months');
        // PUT qui ne touche ni à la fréquence ni au custom : colonnes conservées.
        const r2 = await put(`/api/tasks/${t.id}`, { title: 'Renommée' });
        expect(r2.body.data.recurrence_custom_value).toBe(2);
        expect(r2.body.data.recurrence_custom_unit).toBe('months');
        // Valeurs hors bornes → 400.
        const bad = await put(`/api/tasks/${t.id}`, { recurrence_custom_value: 400, recurrence_custom_unit: 'days' });
        expect(bad.status).toBe(400);
    });

    it('passage de Personnalisé à « Une fois » remet les colonnes custom à NULL', async () => {
        const t = await createTask({ frequency: 'Personnalisé', recurrence_custom_value: 5, recurrence_custom_unit: 'days' });
        const res = await put(`/api/tasks/${t.id}`, { frequency: 'Une fois' });
        expect(res.status).toBe(200);
        expect(res.body.data.frequency).toBe('Une fois');
        expect(res.body.data.recurrence_custom_value).toBeNull();
        expect(res.body.data.recurrence_custom_unit).toBeNull();
        // Et la tâche ponctuelle n'est plus avancée à la complétion.
        const done = await put(`/api/tasks/${t.id}`, { is_completed: true, due_date: d(-3) });
        expect(dayOf(done.body.data.due_date)).toBe(d(-3));
    });

    it('custom renseigné avec une fréquence non-Personnalisé → 400', async () => {
        const t = await createTask({ frequency: 'Mensuel', due_date: d(5) });
        const bad = await put(`/api/tasks/${t.id}`, { recurrence_custom_value: 5, recurrence_custom_unit: 'days' });
        expect(bad.status).toBe(400);
    });
});

describe('GET /api/tasks — whitelist de reset étendue (C)', () => {
    const forceElapsed = async (id: string) => {
        await query('UPDATE tasks SET due_date = $2 WHERE id = $1', [id, d(-1)]);
    };

    it('reset une tâche Semestriel et une tâche Personnalisé valide', async () => {
        const semi = await createTask({ frequency: 'Semestriel', due_date: d(-10) });
        await put(`/api/tasks/${semi.id}`, { is_completed: true });
        await forceElapsed(semi.id);
        const custom = await createTask({
            frequency: 'Personnalisé', recurrence_custom_value: 5, recurrence_custom_unit: 'days', due_date: d(-10),
        });
        await put(`/api/tasks/${custom.id}`, { is_completed: true });
        await forceElapsed(custom.id);

        const list = await get('/api/tasks');
        const byId = new Map(list.body.data.map((x: any) => [x.id, x]));
        expect(byId.get(semi.id).is_completed).toBe(false);
        expect(byId.get(custom.id).is_completed).toBe(false);
    });

    it('ne reset JAMAIS une tâche Personnalisé dont les colonnes custom sont invalides/absentes', async () => {
        // Lignes garbage insérées en direct (l'API refuserait, 400).
        const garbage1 = await query(
            `INSERT INTO tasks (user_id, title, frequency, due_date, is_completed)
             VALUES ($1, 'garbage-null', 'Personnalisé', $2, true) RETURNING id`,
            [parent.user.id, d(-1)]
        );
        const garbage2 = await query(
            `INSERT INTO tasks (user_id, title, frequency, due_date, is_completed, recurrence_custom_value, recurrence_custom_unit)
             VALUES ($1, 'garbage-range', 'Personnalisé', $2, true, 9999, 'days') RETURNING id`,
            [parent.user.id, d(-1)]
        );
        const list = await get('/api/tasks');
        const byId = new Map(list.body.data.map((x: any) => [x.id, x]));
        expect(byId.get(garbage1.rows[0].id).is_completed).toBe(true);
        expect(byId.get(garbage2.rows[0].id).is_completed).toBe(true);
    });

    it('une tâche Personnalisé garbage n\'est jamais avancée non plus (PUT de complétion)', async () => {
        const g = await query(
            `INSERT INTO tasks (user_id, title, frequency, due_date, is_completed)
             VALUES ($1, 'garbage-null', 'Personnalisé', $2, false) RETURNING id`,
            [parent.user.id, d(-10)]
        );
        // L'API refuse de passer en Personnalisé sans custom : on force la
        // fréquence en direct, puis on tente la complétion via l'API.
        await query("UPDATE tasks SET frequency = 'Personnalisé' WHERE id = $1", [g.rows[0].id]);
        const res = await put(`/api/tasks/${g.rows[0].id}`, { is_completed: true });
        // 400 (fréquence effective Personnalisé sans custom valide) OU avance
        // refusée : dans les deux cas l'échéance ne bouge pas.
        if (res.status === 200) {
            expect(dayOf(res.body.data.due_date)).toBe(d(-10));
        } else {
            expect(res.status).toBe(400);
        }
    });
});

// ─── Lot D : reset au démarrage du cycle (jour-J, due_date <= aujourd'hui) ───
// Les offsets JS d() sont en UTC mais la session de test force la base en
// Pacific/Kiritimati : pour les échéances relatives à "aujourd'hui" côté
// base, utiliser dbd() (CURRENT_DATE de la base) — la frontière testée est
// ainsi déterministe quel que soit le fuseau.
const dbd = async (offsetDays: number): Promise<string> => {
    const r = await query('SELECT (CURRENT_DATE + $1::int)::text AS d', [offsetDays]);
    return r.rows[0].d as string;
};

describe('lot D — reset au démarrage du cycle (jour-J)', () => {
    const setDue = async (id: string, due: string) => {
        await query('UPDATE tasks SET due_date = $2 WHERE id = $1', [id, due]);
    };
    const rowOf = (list: any, id: string) => list.body.data.find((x: any) => x.id === id);

    it('échéance = aujourd\'hui (base) → repasse « à faire » aujourd\'hui, pas de retard artificiel', async () => {
        const t = await createTask({ frequency: 'Hebdomadaire', due_date: d(-10) });
        await put(`/api/tasks/${t.id}`, { is_completed: true });
        const today = await dbd(0);
        await setDue(t.id, today); // le cycle démarre aujourd'hui
        const list = await get('/api/tasks');
        const row = rowOf(list, t.id);
        expect(row.is_completed).toBe(false);
        expect(row.completed_at).toBeNull();
        expect(dayOf(row.due_date)).toBe(today);
    });

    it('quotidienne cochée hier → échéance avancée à demain ; encore cochée tant que demain n\'est pas atteint, « à faire » au jour-J', async () => {
        const t = await createTask({ frequency: 'Quotidien', due_date: d(-1) });
        const done = await put(`/api/tasks/${t.id}`, { is_completed: true });
        expect(dayOf(done.body.data.due_date)).toBe(d(1)); // avance : première occurrence >= demain (JS/UTC)
        // Échéance à demain (base) → non atteinte → reste cochée.
        await setDue(t.id, await dbd(1));
        let list = await get('/api/tasks');
        expect(rowOf(list, t.id).is_completed).toBe(true);
        // Jour-J (échéance = aujourd'hui base) → « à faire » immédiatement.
        const today = await dbd(0);
        await setDue(t.id, today);
        list = await get('/api/tasks');
        const row = rowOf(list, t.id);
        expect(row.is_completed).toBe(false);
        expect(dayOf(row.due_date)).toBe(today);
    });

    it('hebdo cochée → « à faire » le jour-J du cycle suivant (pas un jour après)', async () => {
        const t = await createTask({ frequency: 'Hebdomadaire', due_date: d(-7) });
        const done = await put(`/api/tasks/${t.id}`, { is_completed: true });
        expect(dayOf(done.body.data.due_date)).toBe(d(7)); // avance à la semaine prochaine
        await setDue(t.id, await dbd(0)); // jour-J du nouveau cycle
        const list = await get('/api/tasks');
        expect(rowOf(list, t.id).is_completed).toBe(false);
    });

    it('complétée en avance : reste cochée tant que l\'échéance n\'est pas atteinte, reset au jour-J', async () => {
        const t = await createTask({ frequency: 'Hebdomadaire', due_date: d(3) });
        await put(`/api/tasks/${t.id}`, { is_completed: true });
        let list = await get('/api/tasks');
        expect(rowOf(list, t.id).is_completed).toBe(true); // échéance future
        await setDue(t.id, await dbd(1)); // demain (base) : pas encore atteint
        list = await get('/api/tasks');
        expect(rowOf(list, t.id).is_completed).toBe(true);
        await setDue(t.id, await dbd(0)); // aujourd'hui (base) = jour-J
        list = await get('/api/tasks');
        expect(rowOf(list, t.id).is_completed).toBe(false);
    });

    it('idempotence au jour-J : deux GET successifs → un seul reset, état stable', async () => {
        const t = await createTask({ frequency: 'Mensuel', due_date: d(-40) });
        await put(`/api/tasks/${t.id}`, { is_completed: true });
        await setDue(t.id, await dbd(0));
        const first = await get('/api/tasks');
        const second = await get('/api/tasks');
        expect(rowOf(first, t.id).is_completed).toBe(false);
        expect(rowOf(second, t.id).is_completed).toBe(false);
        expect(rowOf(second, t.id).completed_at).toBeNull();
    });

    it('les cas en retard des tests existants restent valides (hier <= aujourd\'hui base)', async () => {
        const t = await createTask({ frequency: 'Hebdomadaire', due_date: d(-10) });
        await put(`/api/tasks/${t.id}`, { is_completed: true });
        await setDue(t.id, await dbd(-1)); // hier
        const list = await get('/api/tasks');
        expect(rowOf(list, t.id).is_completed).toBe(false);
    });
});
