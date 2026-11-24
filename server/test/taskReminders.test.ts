import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app, query, registerWithPassword, resetState, startSuite, stopSuite } from './helpers';
import { coreMigrations } from '../src/migrations/registry';
import { annualMigrations } from '../src/migrations/annual';
import { validateRegistry } from '../src/migrations/runner';
import { checkTaskReminders, pruneTaskReminderLog } from '../src/lib/taskReminderScheduler';
import { instantInZone } from '../src/lib/timeZone';
import { normalizeTaskReminderInput } from '../src/lib/taskRecurrence';

// Fonctionnalité 14 du fork : rappels push des tâches + récap du matin.
// - migration annual/0008 (tasks.reminder_*, tasks_reminder_log, index partiels)
// - POST/PUT /api/tasks : validation stricte des 3 champs (400 hors bornes)
// - scheduler : récap 08:00 idempotent, rappel dédié J-X à l'heure choisie,
//   anti-doublon jour-J 08:00, retard quotidien jusqu'à complétion,
//   pending_approval jamais notifié, destinataire = assigné sinon parents,
//   reset paresseux rejoué avant lecture, rattrapage au boot.
//
// Fuseau forcé Pacific/Kiritimati (comme au lot D) : la session PG tourne en
// Kiritimati (PGOPTIONS) et la famille aussi (users.timezone), donc dbd()
// (CURRENT_DATE de la base) et le « aujourd'hui » du scheduler coïncident.

beforeAll(startSuite);
afterAll(stopSuite);

let parent: { token: string; user: { id: string } };

beforeEach(async () => {
    await resetState();
    parent = await registerWithPassword('parent@example.org');
    // Famille en Pacific/Kiritimati, comme la session de test.
    await query("UPDATE users SET timezone = 'Pacific/Kiritimati' WHERE id = $1", [parent.user.id]);
});

const as = (token: string) => ({ Authorization: `Bearer ${token}` });
const post = (path: string, body: unknown, token = parent.token) =>
    request(app).post(path).set(as(token)).send(body as object);
const put = (path: string, body: unknown, token = parent.token) =>
    request(app).put(path).set(as(token)).send(body as object);
const get = (path: string, token = parent.token) => request(app).get(path).set(as(token));

/** CURRENT_DATE de la base (Kiritimati en test) + offset en jours. */
const dbd = async (offsetDays: number): Promise<string> => {
    const r = await query('SELECT (CURRENT_DATE + $1::int)::text AS d', [offsetDays]);
    return r.rows[0].d as string;
};

/** Un instant dont les horloges de Kiritimati affichent ce jour-là à cette heure. */
const nowAt = async (dayOffset: number, hhmm: string): Promise<Date> =>
    instantInZone(`${await dbd(dayOffset)}T${hhmm}:00`, 'Pacific/Kiritimati');

const createTask = async (body: Record<string, unknown>): Promise<any> => {
    const res = await post('/api/tasks', { title: 'Corvée', ...body });
    expect(res.status).toBe(200);
    return res.body.data;
};

const makeChild = async (): Promise<{ token: string; user: { id: string } }> => {
    const child = await registerWithPassword('child@example.org');
    await query(
        "UPDATE users SET family_owner_id = $1, role = 'enfant', timezone = 'Pacific/Kiritimati' WHERE id = $2",
        [parent.user.id, child.user.id]
    );
    const login = await request(app)
        .post('/api/auth/login')
        .send({ email: 'child@example.org', password: 'correct-horse-1' });
    expect(login.status).toBe(200);
    return { token: login.body.data.token as string, user: child.user };
};

/** Profil membre, éventuellement lié à un compte (linked_user_id). */
const makeMember = async (linkedUserId: string | null = null, name = 'Kid'): Promise<string> => {
    const res = await query(
        'INSERT INTO family_members (user_id, name, color, linked_user_id) VALUES ($1, $2, $3, $4) RETURNING id',
        [parent.user.id, name, '#16A34A', linkedUserId]
    );
    return res.rows[0].id as string;
};

/** Une subscription push (l'envoi réel est no-op sans VAPID en test ; la notification en base est le témoin). */
const addSub = async (userId: string, tag: string): Promise<void> => {
    await query(
        'INSERT INTO push_subscriptions (user_id, endpoint, keys) VALUES ($1, $2, $3::jsonb)',
        [userId, `https://push.test/${tag}-${userId.slice(0, 8)}`, JSON.stringify({ auth: 'a', p256dh: 'b' })]
    );
};

const notificationsFor = async (userId: string): Promise<Array<{ type: string; title: string; message: string }>> => {
    const res = await query(
        'SELECT type, title, message FROM notifications WHERE user_id = $1 ORDER BY created_at, id',
        [userId]
    );
    return res.rows as any[];
};

const claims = async (): Promise<Array<{ task_id: string | null; member_id: string | null; kind: string; log_date: string }>> => {
    const res = await query(
        'SELECT task_id, member_id, kind, log_date::text AS log_date FROM tasks_reminder_log ORDER BY kind, log_date, task_id'
    );
    return res.rows as any[];
};

describe('migration annual/0008', () => {
    it('validates in the combined registry, is recorded, and added the columns + log table', async () => {
        expect(() => validateRegistry([...coreMigrations, ...annualMigrations])).not.toThrow();
        const ids = annualMigrations.map((m) => m.id);
        expect(ids).toContain('annual/0008-tasks-reminders');
        expect(ids.indexOf('annual/0008-tasks-reminders')).toBeGreaterThan(ids.indexOf('annual/0007-tasks-custom-frequency'));
        const recorded = await query(
            "SELECT id FROM openfamily_schema_migrations WHERE id = 'annual/0008-tasks-reminders'"
        );
        expect(recorded.rows.length).toBe(1);
        for (const col of ['reminder_offset_days', 'reminder_time', 'reminder_overdue']) {
            const c = await query(
                'SELECT is_nullable FROM information_schema.columns WHERE table_name = $1 AND column_name = $2',
                ['tasks', col]
            );
            expect(c.rows.length).toBe(1);
        }
        const t = await query(
            "SELECT 1 FROM information_schema.tables WHERE table_name = 'tasks_reminder_log'"
        );
        expect(t.rows.length).toBe(1);
        // Index partiels d'idempotence.
        const idx = await query(
            "SELECT indexname FROM pg_indexes WHERE tablename = 'tasks_reminder_log' ORDER BY indexname"
        );
        const names = idx.rows.map((r: any) => r.indexname);
        expect(names).toContain('idx_tasks_reminder_log_task_kind_day');
        expect(names).toContain('idx_tasks_reminder_log_recap_member_day');
        // CHECK en base : offset hors bornes et heure hors quart d'heure rejetés.
        await expect(
            query("INSERT INTO tasks (user_id, title, due_date, reminder_offset_days) VALUES ($1, 'x', CURRENT_DATE, 8)", [parent.user.id])
        ).rejects.toThrow();
        await expect(
            query("INSERT INTO tasks (user_id, title, due_date, reminder_time) VALUES ($1, 'x', CURRENT_DATE, '08:07')", [parent.user.id])
        ).rejects.toThrow();
        await query(
            "INSERT INTO tasks (user_id, title, due_date, reminder_offset_days, reminder_time, reminder_overdue) VALUES ($1, 'ok', CURRENT_DATE, 7, '23:45', true)",
            [parent.user.id]
        );
    });
});

describe('unit: normalizeTaskReminderInput', () => {
    it('accepts null / bornes / quarts d\'heure, rejects the rest', () => {
        expect(normalizeTaskReminderInput({ reminder_offset_days: null })).toEqual({ ok: true, fields: { reminder_offset_days: null } });
        expect(normalizeTaskReminderInput({ reminder_offset_days: 0 })).toEqual({ ok: true, fields: { reminder_offset_days: 0 } });
        expect(normalizeTaskReminderInput({ reminder_offset_days: 7 })).toEqual({ ok: true, fields: { reminder_offset_days: 7 } });
        expect(normalizeTaskReminderInput({ reminder_offset_days: 8 })).toEqual({ ok: false, field: 'reminder_offset_days' });
        expect(normalizeTaskReminderInput({ reminder_offset_days: -1 })).toEqual({ ok: false, field: 'reminder_offset_days' });
        expect(normalizeTaskReminderInput({ reminder_offset_days: 2.5 })).toEqual({ ok: false, field: 'reminder_offset_days' });
        expect(normalizeTaskReminderInput({ reminder_time: '08:00' })).toEqual({ ok: true, fields: { reminder_time: '08:00' } });
        expect(normalizeTaskReminderInput({ reminder_time: '23:45' })).toEqual({ ok: true, fields: { reminder_time: '23:45' } });
        expect(normalizeTaskReminderInput({ reminder_time: '' })).toEqual({ ok: true, fields: { reminder_time: null } });
        expect(normalizeTaskReminderInput({ reminder_time: '08:07' })).toEqual({ ok: false, field: 'reminder_time' });
        expect(normalizeTaskReminderInput({ reminder_time: '24:00' })).toEqual({ ok: false, field: 'reminder_time' });
        expect(normalizeTaskReminderInput({ reminder_time: '8:00' })).toEqual({ ok: false, field: 'reminder_time' });
        expect(normalizeTaskReminderInput({ reminder_overdue: true })).toEqual({ ok: true, fields: { reminder_overdue: true } });
        expect(normalizeTaskReminderInput({ reminder_overdue: 'yes' })).toEqual({ ok: false, field: 'reminder_overdue' });
        expect(normalizeTaskReminderInput({})).toEqual({ ok: true, fields: {} });
    });
});

describe('API POST/PUT /api/tasks — champs rappels', () => {
    it('POST accepte les 3 champs valides et GET les renvoie', async () => {
        const task = await createTask({
            due_date: await dbd(2),
            reminder_offset_days: 2,
            reminder_time: '18:30',
            reminder_overdue: true,
        });
        expect(task.reminder_offset_days).toBe(2);
        expect(task.reminder_time).toBe('18:30');
        expect(task.reminder_overdue).toBe(true);
        const list = await get('/api/tasks');
        const row = list.body.data.find((x: any) => x.id === task.id);
        expect(row.reminder_offset_days).toBe(2);
        expect(row.reminder_time).toBe('18:30');
        expect(row.reminder_overdue).toBe(true);
    });

    it('POST sans les champs → NULL/false (tâche pré-migration silencieuse côté dédié)', async () => {
        const task = await createTask({ due_date: await dbd(0) });
        expect(task.reminder_offset_days).toBeNull();
        expect(task.reminder_time).toBeNull();
        expect(task.reminder_overdue).toBe(false);
    });

    it('POST/PUT : 400 hors bornes (offset 8, heure 08:07, format invalide, overdue non booléen)', async () => {
        for (const bad of [8, -1, 2.5, 'x', true]) {
            const res = await post('/api/tasks', { title: 't', reminder_offset_days: bad });
            expect(res.status).toBe(400);
            expect(res.body.error).toBe('Invalid reminder_offset_days');
        }
        for (const bad of ['08:07', '25:00', '8:00', 12]) {
            const res = await post('/api/tasks', { title: 't', reminder_time: bad });
            expect(res.status).toBe(400);
            expect(res.body.error).toBe('Invalid reminder_time');
        }
        const res = await post('/api/tasks', { title: 't', reminder_overdue: 'yes' });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Invalid reminder_overdue');

        const task = await createTask({ due_date: await dbd(1), reminder_offset_days: 1, reminder_time: '09:00' });
        const bad = await put(`/api/tasks/${task.id}`, { reminder_offset_days: 9 });
        expect(bad.status).toBe(400);
        const still = await get('/api/tasks');
        expect(still.body.data.find((x: any) => x.id === task.id).reminder_offset_days).toBe(1);
    });

    it('PUT : null repasse les colonnes à NULL (bloc rappels désactivé), false pour le retard', async () => {
        const task = await createTask({
            due_date: await dbd(1),
            reminder_offset_days: 3,
            reminder_time: '07:15',
            reminder_overdue: true,
        });
        const res = await put(`/api/tasks/${task.id}`, {
            reminder_offset_days: null,
            reminder_time: null,
            reminder_overdue: false,
        });
        expect(res.status).toBe(200);
        expect(res.body.data.reminder_offset_days).toBeNull();
        expect(res.body.data.reminder_time).toBeNull();
        expect(res.body.data.reminder_overdue).toBe(false);
    });
});

describe('scheduler — récap du matin', () => {
    it('08:00 : le récap part une seule fois (idempotent), avec les tâches du jour assignées', async () => {
        await addSub(parent.user.id, 'parent');
        const member = await makeMember(parent.user.id, 'Maman');
        await createTask({ title: 'Vaisselle', due_date: await dbd(0), assigned_to: [member] });
        await createTask({ title: 'Lessive', due_date: await dbd(0), assigned_to: [member] });
        await createTask({ title: 'Demain', due_date: await dbd(1), assigned_to: [member] }); // pas aujourd'hui
        await createTask({ title: 'En retard', due_date: await dbd(-1), assigned_to: [member] }); // pas dans le récap

        const now = await nowAt(0, '08:00');
        await checkTaskReminders(now);
        await checkTaskReminders(now); // seconde passe : aucun doublon

        const notifs = await notificationsFor(parent.user.id);
        const recaps = notifs.filter((n) => n.type === 'task_recap');
        expect(recaps.length).toBe(1);
        expect(recaps[0].message).toContain('Vaisselle');
        expect(recaps[0].message).toContain('Lessive');
        expect(recaps[0].message).not.toContain('Demain');
        expect(recaps[0].message).not.toContain('En retard');
        const c = await claims();
        expect(c.filter((x) => x.kind === 'recap').length).toBe(1);
        expect(c[0].member_id).toBe(parent.user.id);
        expect(c[0].log_date).toBe(await dbd(0));
    });

    it('pas de récap avant 08:00, et rattrapage après boot (avant 09:00)', async () => {
        await addSub(parent.user.id, 'parent');
        const member = await makeMember(parent.user.id);
        await createTask({ title: 'Corvée', due_date: await dbd(0), assigned_to: [member] });

        await checkTaskReminders(await nowAt(0, '07:45'));
        expect((await notificationsFor(parent.user.id)).filter((n) => n.type === 'task_recap').length).toBe(0);

        // Boot à 08:40 : le récap de 08:00 rattrapé une fois.
        await checkTaskReminders(await nowAt(0, '08:40'));
        await checkTaskReminders(await nowAt(0, '08:50'));
        expect((await notificationsFor(parent.user.id)).filter((n) => n.type === 'task_recap').length).toBe(1);

        // Après 09:00, plus de récap pour ce jour.
        await query('DELETE FROM tasks_reminder_log');
        await query('DELETE FROM notifications');
        await checkTaskReminders(await nowAt(0, '09:30'));
        expect((await notificationsFor(parent.user.id)).filter((n) => n.type === 'task_recap').length).toBe(0);
    });

    it('membre sans tâche du jour = pas de push ; tâche du jour sans assignation → parents seuls', async () => {
        await addSub(parent.user.id, 'parent');
        const child = await makeChild();
        await addSub(child.user.id, 'child');
        const childMember = await makeMember(child.user.id, 'Léo');
        await makeMember(parent.user.id, 'Maman');
        // Tâche du jour non assignée + tâche du jour de l'enfant.
        await createTask({ title: 'Tâche famille', due_date: await dbd(0) });
        await createTask({ title: 'Tâche Léo', due_date: await dbd(0), assigned_to: [childMember] });

        await checkTaskReminders(await nowAt(0, '08:00'));

        const parentNotifs = await notificationsFor(parent.user.id);
        const childNotifs = await notificationsFor(child.user.id);
        expect(parentNotifs.filter((n) => n.type === 'task_recap').length).toBe(1);
        expect(parentNotifs[0].message).toContain('Tâche famille');
        expect(parentNotifs[0].message).not.toContain('Tâche Léo');
        expect(childNotifs.filter((n) => n.type === 'task_recap').length).toBe(1);
        expect(childNotifs[0].message).toContain('Tâche Léo');
        expect(childNotifs[0].message).not.toContain('Tâche famille'); // non assignée → parents
    });

    it('compte sans subscription push : silencieusement ignoré', async () => {
        const member = await makeMember(null); // profil sans compte lié
        await createTask({ title: 'Corvée', due_date: await dbd(0), assigned_to: [member] });
        // Aucun push_subscriptions pour qui que ce soit.
        await checkTaskReminders(await nowAt(0, '08:00'));
        expect(await claims()).toEqual([]);
        const n = await query('SELECT COUNT(*)::int AS c FROM notifications');
        expect(n.rows[0].c).toBe(0);
    });

    it('le reset paresseux est appliqué AVANT lecture : une quotidienne cochée d\'hier réapparaît dans le récap', async () => {
        await addSub(parent.user.id, 'parent');
        const member = await makeMember(parent.user.id);
        const task = await createTask({ title: 'Quotidienne', frequency: 'Quotidien', due_date: await dbd(0), assigned_to: [member] });
        // Cochée "hier" (cycle atteint aujourd'hui) directement en base.
        await query('UPDATE tasks SET is_completed = true, completed_at = now() WHERE id = $1', [task.id]);

        await checkTaskReminders(await nowAt(0, '08:00'));

        const recaps = (await notificationsFor(parent.user.id)).filter((n) => n.type === 'task_recap');
        expect(recaps.length).toBe(1);
        expect(recaps[0].message).toContain('Quotidienne');
        const row = await query('SELECT is_completed FROM tasks WHERE id = $1', [task.id]);
        expect(row.rows[0].is_completed).toBe(false);
    });
});

describe('scheduler — rappels dédiés (J-X) et anti-doublon', () => {
    it('J-1 à 18:00 : push la veille à 18:00, pas à 17:45, pas le jour-J', async () => {
        await addSub(parent.user.id, 'parent');
        const member = await makeMember(parent.user.id);
        await createTask({
            title: 'Sortir les poubelles',
            due_date: await dbd(1),
            assigned_to: [member],
            reminder_offset_days: 1,
            reminder_time: '18:00',
        });

        await checkTaskReminders(await nowAt(0, '17:45'));
        expect((await claims()).filter((c) => c.kind === 'due').length).toBe(0);

        await checkTaskReminders(await nowAt(0, '18:00'));
        await checkTaskReminders(await nowAt(0, '18:15')); // idempotent
        const due = (await claims()).filter((c) => c.kind === 'due');
        expect(due.length).toBe(1);
        const notifs = (await notificationsFor(parent.user.id)).filter((n) => n.type === 'task_reminder');
        expect(notifs.length).toBe(1);
        expect(notifs[0].title).toContain('Sortir les poubelles');

        // Le jour-J : plus de rappel 'due' (le claim du jour précédent ne couvre pas,
        // mais reminderDay != aujourd'hui → rien).
        await checkTaskReminders(await nowAt(1, '18:00'));
        expect((await claims()).filter((c) => c.kind === 'due').length).toBe(1);
    });

    it('anti-doublon : jour-J à 08:00 → aucun push dédié (le récap couvre)', async () => {
        await addSub(parent.user.id, 'parent');
        const member = await makeMember(parent.user.id);
        await createTask({
            title: 'Jour J 8h',
            due_date: await dbd(0),
            assigned_to: [member],
            reminder_offset_days: 0,
            reminder_time: '08:00',
        });
        await checkTaskReminders(await nowAt(0, '08:00'));
        const kinds = (await claims()).map((c) => c.kind);
        expect(kinds).toContain('recap');
        expect(kinds).not.toContain('due');
        const notifs = await notificationsFor(parent.user.id);
        expect(notifs.filter((n) => n.type === 'task_recap').length).toBe(1);
        expect(notifs.filter((n) => n.type === 'task_reminder').length).toBe(0);
    });

    it('jour-J à 10:00 → push dédié à 10:00, distinct du récap de 08:00', async () => {
        await addSub(parent.user.id, 'parent');
        const member = await makeMember(parent.user.id);
        await createTask({
            title: 'Jour J 10h',
            due_date: await dbd(0),
            assigned_to: [member],
            reminder_offset_days: 0,
            reminder_time: '10:00',
        });
        await checkTaskReminders(await nowAt(0, '08:00'));
        await checkTaskReminders(await nowAt(0, '10:00'));
        await checkTaskReminders(await nowAt(0, '10:15'));
        const notifs = await notificationsFor(parent.user.id);
        expect(notifs.filter((n) => n.type === 'task_recap').length).toBe(1);
        expect(notifs.filter((n) => n.type === 'task_reminder').length).toBe(1);
        expect((await claims()).filter((c) => c.kind === 'due').length).toBe(1);
    });

    it('rattrapage au boot : slot manqué du jour envoyé (due aujourd\'hui 08:15, boot 08:40)', async () => {
        await addSub(parent.user.id, 'parent');
        const member = await makeMember(parent.user.id);
        await createTask({
            title: 'Boot',
            due_date: await dbd(0),
            assigned_to: [member],
            reminder_offset_days: 0,
            reminder_time: '08:15',
        });
        await checkTaskReminders(await nowAt(0, '08:40'));
        expect((await claims()).filter((c) => c.kind === 'due').length).toBe(1);
    });

    it('destinataire : l\'assigné (compte lié au profil), à défaut tous les parents', async () => {
        await addSub(parent.user.id, 'parent');
        const child = await makeChild();
        await addSub(child.user.id, 'child');
        const childMember = await makeMember(child.user.id, 'Léo');
        // Tâche assignée à Léo, due demain, rappel J-1 à 18:00.
        await createTask({
            title: 'Devoirs',
            due_date: await dbd(1),
            assigned_to: [childMember],
            reminder_offset_days: 1,
            reminder_time: '18:00',
        });
        // Tâche non assignée, même config.
        await createTask({
            title: 'Poubelles',
            due_date: await dbd(1),
            reminder_offset_days: 1,
            reminder_time: '18:00',
        });

        await checkTaskReminders(await nowAt(0, '18:00'));

        const childNotifs = (await notificationsFor(child.user.id)).filter((n) => n.type === 'task_reminder');
        const parentNotifs = (await notificationsFor(parent.user.id)).filter((n) => n.type === 'task_reminder');
        expect(childNotifs.length).toBe(1);
        expect(childNotifs[0].title).toContain('Devoirs');
        // Non assignée → parents seuls (l'enfant ne reçoit pas celle-là).
        expect(parentNotifs.length).toBe(1);
        expect(parentNotifs[0].title).toContain('Poubelles');
    });

    it('pending_approval : jamais notifié, jamais claimé', async () => {
        await addSub(parent.user.id, 'parent');
        const member = await makeMember(parent.user.id);
        const task = await createTask({
            title: 'En attente',
            due_date: await dbd(0),
            assigned_to: [member],
            points: 10,
            reminder_offset_days: 0,
            reminder_time: '10:00',
            reminder_overdue: true,
        });
        await query('UPDATE tasks SET pending_approval = true WHERE id = $1', [task.id]);
        await checkTaskReminders(await nowAt(0, '10:00'));
        expect(await claims()).toEqual([]);
        expect(await notificationsFor(parent.user.id)).toEqual([]);
    });

    it('tâche sans reminder_offset_days (pré-migration) : aucun rappel dédié, mais présente dans le récap', async () => {
        await addSub(parent.user.id, 'parent');
        const member = await makeMember(parent.user.id);
        await createTask({ title: 'Ancienne', due_date: await dbd(0), assigned_to: [member] });
        await checkTaskReminders(await nowAt(0, '08:00'));
        await checkTaskReminders(await nowAt(0, '10:00'));
        const kinds = (await claims()).map((c) => c.kind);
        expect(kinds).toEqual(['recap']);
        const notifs = await notificationsFor(parent.user.id);
        expect(notifs.map((n) => n.type)).toEqual(['task_recap']);
    });
});

describe('scheduler — rappels de retard (overdue)', () => {
    it('push quotidien à l\'heure choisie tant que la tâche est en retard, silence après complétion', async () => {
        await addSub(parent.user.id, 'parent');
        const member = await makeMember(parent.user.id);
        const task = await createTask({
            title: 'En retard',
            due_date: await dbd(-1),
            assigned_to: [member],
            reminder_offset_days: null,
            reminder_overdue: true,
            reminder_time: '08:00',
        });

        await checkTaskReminders(await nowAt(0, '08:00'));
        await checkTaskReminders(await nowAt(0, '08:15')); // idempotent le même jour
        let overdue = (await notificationsFor(parent.user.id)).filter((n) => n.type === 'task_overdue');
        expect(overdue.length).toBe(1);
        expect(overdue[0].title).toContain('En retard');
        expect((await claims()).filter((c) => c.kind === 'overdue').length).toBe(1);

        // Le lendemain : un nouveau push de retard (nouveau log_date).
        await checkTaskReminders(await nowAt(1, '08:00'));
        overdue = (await notificationsFor(parent.user.id)).filter((n) => n.type === 'task_overdue');
        expect(overdue.length).toBe(2);

        // Cochée → silence.
        await put(`/api/tasks/${task.id}`, { is_completed: true });
        await checkTaskReminders(await nowAt(2, '08:00'));
        overdue = (await notificationsFor(parent.user.id)).filter((n) => n.type === 'task_overdue');
        expect(overdue.length).toBe(2);
        expect((await claims()).filter((c) => c.kind === 'overdue').length).toBe(2);
    });

    it('retard : repli 08:00 quand reminder_time est NULL ; pas avant l\'heure', async () => {
        await addSub(parent.user.id, 'parent');
        const member = await makeMember(parent.user.id);
        await createTask({
            title: 'Retard repli',
            due_date: await dbd(-2),
            assigned_to: [member],
            reminder_overdue: true,
        });
        await checkTaskReminders(await nowAt(0, '07:45'));
        expect((await claims()).filter((c) => c.kind === 'overdue').length).toBe(0);
        await checkTaskReminders(await nowAt(0, '08:00'));
        expect((await claims()).filter((c) => c.kind === 'overdue').length).toBe(1);
    });

    it('tâche récurrente : la complétion avance l\'échéance → le retard cesse pour ce cycle, puis reprend au suivant', async () => {
        await addSub(parent.user.id, 'parent');
        const member = await makeMember(parent.user.id);
        const task = await createTask({
            title: 'Quotidienne retard',
            frequency: 'Quotidien',
            due_date: await dbd(-1),
            assigned_to: [member],
            reminder_overdue: true,
        });
        // En retard non cochée aujourd'hui → rappel de retard.
        await checkTaskReminders(await nowAt(0, '08:00'));
        expect((await claims()).filter((c) => c.kind === 'overdue').length).toBe(1);
        // Cochée via l'API : l'échéance avance (cycle suivant) → plus en retard aujourd'hui.
        const done = await put(`/api/tasks/${task.id}`, { is_completed: true });
        expect(done.status).toBe(200);
        await checkTaskReminders(await nowAt(0, '09:00'));
        expect((await claims()).filter((c) => c.kind === 'overdue').length).toBe(1);
        // Cycle suivant (demain) : le reset remet la corvée à faire, en retard → le rappel repart.
        await checkTaskReminders(await nowAt(1, '08:00'));
        expect((await claims()).filter((c) => c.kind === 'overdue').length).toBe(2);
    });
});

describe('prune', () => {
    it('purge sur log_date (jamais sent_at), rétention 60 jours, idempotence du jour préservée', async () => {
        await addSub(parent.user.id, 'parent');
        const member = await makeMember(parent.user.id);
        await createTask({ title: 'A', due_date: await dbd(0), assigned_to: [member] });
        await checkTaskReminders(await nowAt(0, '08:00'));
        const before = await query('SELECT COUNT(*)::int AS c FROM tasks_reminder_log');
        expect(before.rows[0].c).toBe(1);
        await pruneTaskReminderLog();
        const after = await query('SELECT COUNT(*)::int AS c FROM tasks_reminder_log');
        expect(after.rows[0].c).toBe(1); // le claim d'aujourd'hui est conservé
        await query(
            "INSERT INTO tasks_reminder_log (task_id, member_id, kind, log_date) VALUES (NULL, $1, 'recap', CURRENT_DATE - 61)",
            [parent.user.id]
        );
        await pruneTaskReminderLog();
        const remaining = await query('SELECT log_date::text AS d FROM tasks_reminder_log');
        expect(remaining.rows.length).toBe(1);
        expect(remaining.rows[0].d).toBe(await dbd(0));
    });
});

describe('réarmement du rappel due au changement d\'heure (PUT, décision 24/11)', () => {
    const setupDueToday = async (time: string) => {
        await addSub(parent.user.id, 'parent');
        const member = await makeMember(parent.user.id);
        const task = await createTask({
            title: 'Réarmement',
            due_date: await dbd(0),
            assigned_to: [member],
            reminder_offset_days: 0,
            reminder_time: time,
        });
        return { task, member };
    };

    const dueClaims = async () => (await claims()).filter((c) => c.kind === 'due');
    const dueNotifs = async (userId: string) =>
        (await notificationsFor(userId)).filter((n) => n.type === 'task_reminder');

    it('T1 : rappel parti à T1, PUT change l\'heure à T2>T1 le même jour → tick T2 renvoie + log re-saisi', async () => {
        const { task } = await setupDueToday('10:00');
        await checkTaskReminders(await nowAt(0, '10:00'));
        expect((await dueClaims()).length).toBe(1);
        expect((await dueNotifs(parent.user.id)).length).toBe(1);

        const res = await put(`/api/tasks/${task.id}`, { reminder_time: '12:00' });
        expect(res.status).toBe(200);
        expect(res.body.data.reminder_time).toBe('12:00');
        // Le claim du jour cible (aujourd'hui) est purgé.
        expect((await dueClaims()).length).toBe(0);

        // Avant T2 : rien ne tire.
        await checkTaskReminders(await nowAt(0, '11:45'));
        expect((await dueClaims()).length).toBe(0);
        // À T2 : renvoi, log re-saisi, puis idempotent.
        await checkTaskReminders(await nowAt(0, '12:00'));
        await checkTaskReminders(await nowAt(0, '12:15'));
        const due = await dueClaims();
        expect(due.length).toBe(1);
        expect(due[0].log_date).toBe(await dbd(0));
        expect((await dueNotifs(parent.user.id)).length).toBe(2);
    });

    it('T2 : PUT sans changement d\'heure après envoi → pas de second envoi (clé intacte)', async () => {
        const { task } = await setupDueToday('10:00');
        await checkTaskReminders(await nowAt(0, '10:00'));
        expect((await dueClaims()).length).toBe(1);

        // Même heure envoyée explicitement.
        let res = await put(`/api/tasks/${task.id}`, { reminder_time: '10:00' });
        expect(res.status).toBe(200);
        // Champ sans rapport.
        res = await put(`/api/tasks/${task.id}`, { title: 'Renommée' });
        expect(res.status).toBe(200);
        // Aucun claim purgé.
        expect((await dueClaims()).length).toBe(1);

        await checkTaskReminders(await nowAt(0, '10:15'));
        await checkTaskReminders(await nowAt(0, '23:45'));
        expect((await dueClaims()).length).toBe(1);
        expect((await dueNotifs(parent.user.id)).length).toBe(1);
    });

    it('T3 : PUT vers une heure déjà passée → comportement réel du scheduler figé : renvoi au prochain tick (slot manqué)', async () => {
        const { task } = await setupDueToday('10:00');
        await checkTaskReminders(await nowAt(0, '10:00'));
        expect((await dueNotifs(parent.user.id)).length).toBe(1);

        // Nouvelle heure 08:30, déjà passée à 10:00.
        const res = await put(`/api/tasks/${task.id}`, { reminder_time: '08:30' });
        expect(res.status).toBe(200);
        expect((await dueClaims()).length).toBe(0); // purgé

        // WHERE réel du scheduler : reminderDay == aujourd'hui && now >= dueAt
        // → vrai dès le prochain tick, comme un rattrapage de boot.
        await checkTaskReminders(await nowAt(0, '10:15'));
        expect((await dueClaims()).length).toBe(1);
        expect((await dueNotifs(parent.user.id)).length).toBe(2);
        // Toujours pas de doublon ensuite.
        await checkTaskReminders(await nowAt(0, '10:30'));
        expect((await dueNotifs(parent.user.id)).length).toBe(2);
    });

    it('T4 : changement d\'offset déplaçant le jour cible ≠ aujourd\'hui → rien ne tire aujourd\'hui', async () => {
        await addSub(parent.user.id, 'parent');
        const member = await makeMember(parent.user.id);
        const task = await createTask({
            title: 'Offset',
            due_date: await dbd(1),
            assigned_to: [member],
            reminder_offset_days: 1,
            reminder_time: '18:00',
        });
        // Envoi J-1 (aujourd'hui) à 18:00 : claim logué sur aujourd'hui.
        await checkTaskReminders(await nowAt(0, '18:00'));
        expect((await dueClaims()).length).toBe(1);

        // Nouvel offset 0 → jour cible = demain.
        const res = await put(`/api/tasks/${task.id}`, { reminder_offset_days: 0 });
        expect(res.status).toBe(200);
        // La purge a visé le jour cible de la NOUVELLE config (demain) :
        // le claim d'aujourd'hui est intact.
        const due = await dueClaims();
        expect(due.length).toBe(1);
        expect(due[0].log_date).toBe(await dbd(0));

        // Aujourd'hui, reminderDay ≠ today → rien ne tire.
        await checkTaskReminders(await nowAt(0, '18:15'));
        await checkTaskReminders(await nowAt(0, '23:45'));
        expect((await dueNotifs(parent.user.id)).length).toBe(1);
        expect((await dueClaims()).length).toBe(1);
    });

    it('T5 : enfant éditeur réarme pareillement (mêmes droits d\'édition)', async () => {
        const child = await makeChild();
        await addSub(parent.user.id, 'parent');
        await addSub(child.user.id, 'child');
        const childMember = await makeMember(child.user.id, 'Léo');
        const task = await createTask({
            title: 'Devoirs Léo',
            due_date: await dbd(0),
            assigned_to: [childMember],
            reminder_offset_days: 0,
            reminder_time: '10:00',
        });
        await checkTaskReminders(await nowAt(0, '10:00'));
        expect((await dueNotifs(child.user.id)).length).toBe(1);

        const res = await put(`/api/tasks/${task.id}`, { reminder_time: '14:00' }, child.token);
        expect(res.status).toBe(200);
        expect(res.body.data.reminder_time).toBe('14:00');
        expect((await dueClaims()).length).toBe(0);

        await checkTaskReminders(await nowAt(0, '14:00'));
        expect((await dueClaims()).length).toBe(1);
        expect((await dueNotifs(child.user.id)).length).toBe(2);
    });

    it('le réarmement ne purge jamais les claims overdue ni recap', async () => {
        const { task } = await setupDueToday('10:00');
        await query(
            "INSERT INTO tasks_reminder_log (task_id, member_id, kind, log_date) VALUES ($1, NULL, 'overdue', $2::date)",
            [task.id, await dbd(-1)]
        );
        await query(
            "INSERT INTO tasks_reminder_log (task_id, member_id, kind, log_date) VALUES (NULL, $1, 'recap', $2::date)",
            [parent.user.id, await dbd(0)]
        );
        await checkTaskReminders(await nowAt(0, '10:00')); // claim 'due' posé
        expect((await dueClaims()).length).toBe(1);

        const res = await put(`/api/tasks/${task.id}`, { reminder_time: '12:00' });
        expect(res.status).toBe(200);
        const kinds = (await claims()).map((c) => c.kind).sort();
        expect(kinds).toEqual(['overdue', 'recap']); // seul le 'due' est purgé
    });
});
