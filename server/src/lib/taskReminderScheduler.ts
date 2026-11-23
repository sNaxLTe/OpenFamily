import cron from 'node-cron';
import { query } from '../db';
import { createLocalizedNotification, LocalizedTexts } from './notifications';
import { Language, LANGUAGES } from './languages';
import logger from './logger';
import { describeLeadTime } from './reminderScheduler';
import { addDays, dayInZone, familyTimeZone, instantInZone, serverTimeZone } from './timeZone';
import {
    resetRecurringTasksDue,
    TASK_RECAP_HOUR,
    TASK_REMINDER_DEFAULT_TIME,
} from './taskRecurrence';

// Rappels push des tâches (fonctionnalité 14 du fork) :
// - récap du matin (kind 'recap') : à 08:00 sur les horloges de la famille,
//   chaque compte avec une subscription push reçoit SES tâches du jour-J
//   (assignées à son profil membre, non complétées, hors pending_approval, hors
//   retards) ; les tâches du jour SANS assignation vont aux parents (même
//   règle que les rappels dédiés). Pas de push si aucune tâche du jour.
// - rappel dédié (kind 'due') : à J-X (reminder_offset_days, 0..7) à
//   reminder_time (quart d'heure, repli 08:00) ; un rappel jour-J à 08:00
//   n'est PAS envoyé (le récap le couvre déjà — anti-doublon).
// - rappel de retard (kind 'overdue') : reminder_overdue = vrai, échéance
//   passée, non cochée → push chaque jour à reminder_time jusqu'à complétion.
//
// Destinataires d'un rappel dédié/retard : les comptes (users) des profils
// membres assignés (family_members.linked_user_id), à défaut tous les parents
// de la famille. Les membres sans subscription push sont silencieusement
// ignorés (ils ne sont même pas destinataires).
//
// Idempotence : une ligne de tasks_reminder_log est CLAIMED avant l'envoi
// (même pattern que annual_reminder_log / appointment_reminder_log), donc un
// rappel ne part qu'une fois, même après reboot ; la passe de boot sert de
// rattrapage pour le slot manqué du jour. Le reset paresseux des récurrentes
// est rejoué AVANT lecture (même helper que GET /api/tasks) pour qu'une
// corvée cochée hier apparaisse dans le récap du jour.
//
// Les tâches récurrentes suivent leur due_date : aucun calcul de récurrence
// ici, zéro duplication de taskRecurrence.ts.

/** Fenêtre de rattrapage du récap après le boot : le récap de 08:00 est envoyé jusqu'à 09:00. */
const RECAP_CATCHUP_MS = 60 * 60 * 1000;

const pad = (value: number): string => String(value).padStart(2, '0');

const TODAY: Record<Language, string> = {
    fr: "aujourd'hui",
    en: 'today',
    pt: 'hoje',
    ru: 'сегодня',
    es: 'hoy',
    ca: 'avui',
    zh: '今天',
    de: 'heute',
};

const RECAP_TITLE: Record<Language, string> = {
    fr: '☀️ Tes tâches du jour',
    en: '☀️ Your tasks for today',
    pt: '☀️ Suas tarefas de hoje',
    ru: '☀️ Ваши задачи на сегодня',
    es: '☀️ Tus tareas de hoy',
    ca: '☀️ Les teves tasques d’avui',
    zh: '☀️ 今日待办',
    de: '☀️ Deine Aufgaben für heute',
};

/** Corps du récap : jusqu'à 3 titres, puis « +N autres ». */
const RECAP_BODY: Record<Language, (titles: string[], more: number) => string> = {
    fr: (titles, more) => (more > 0 ? `${titles.join(', ')} +${more} autre${more > 1 ? 's' : ''}` : titles.join(', ')),
    en: (titles, more) => (more > 0 ? `${titles.join(', ')} +${more} more` : titles.join(', ')),
    pt: (titles, more) => (more > 0 ? `${titles.join(', ')} +${more} outra${more > 1 ? 's' : ''}` : titles.join(', ')),
    ru: (titles, more) => (more > 0 ? `${titles.join(', ')} + ещё ${more}` : titles.join(', ')),
    es: (titles, more) => (more > 0 ? `${titles.join(', ')} +${more} más` : titles.join(', ')),
    ca: (titles, more) => (more > 0 ? `${titles.join(', ')} +${more} més` : titles.join(', ')),
    zh: (titles, more) => (more > 0 ? `${titles.join('、')}+${more} 项其他` : titles.join('、')),
    de: (titles, more) => (more > 0 ? `${titles.join(', ')} +${more} weitere` : titles.join(', ')),
};

const REMINDER_TITLE: Record<Language, (title: string) => string> = {
    fr: (title) => `🔔 Rappel : ${title}`,
    en: (title) => `🔔 Reminder: ${title}`,
    pt: (title) => `🔔 Lembrete: ${title}`,
    ru: (title) => `🔔 Напоминание: ${title}`,
    es: (title) => `🔔 Recordatorio: ${title}`,
    ca: (title) => `🔔 Recordatori: ${title}`,
    zh: (title) => `🔔 提醒：${title}`,
    de: (title) => `🔔 Erinnerung: ${title}`,
};

/** « dans 3 jours » / « in 3 days », en minuscules pour tenir dans la phrase. */
const dueWhen = (days: number, lang: Language): string => {
    if (days === 0) return TODAY[lang];
    const text = describeLeadTime(days * 24 * 60, lang);
    return text.charAt(0).toLowerCase() + text.slice(1);
};

const REMINDER_BODY: Record<Language, (offsetDays: number) => string> = {
    fr: (d) => `Échéance ${dueWhen(d, 'fr')}`,
    en: (d) => `Due ${dueWhen(d, 'en')}`,
    pt: (d) => `Vencimento ${dueWhen(d, 'pt')}`,
    ru: (d) => `Срок: ${dueWhen(d, 'ru')}`,
    es: (d) => `Vence ${dueWhen(d, 'es')}`,
    ca: (d) => `Venciment ${dueWhen(d, 'ca')}`,
    zh: (d) => `截止${dueWhen(d, 'zh')}`,
    de: (d) => `Fällig ${dueWhen(d, 'de')}`,
};

const OVERDUE_TITLE: Record<Language, (title: string) => string> = {
    fr: (title) => `⏰ En retard : ${title}`,
    en: (title) => `⏰ Overdue: ${title}`,
    pt: (title) => `⏰ Atrasada: ${title}`,
    ru: (title) => `⏰ Просрочено: ${title}`,
    es: (title) => `⏰ Atrasada: ${title}`,
    ca: (title) => `⏰ Endarrerida: ${title}`,
    zh: (title) => `⏰ 已逾期：${title}`,
    de: (title) => `⏰ Überfällig: ${title}`,
};

const OVERDUE_BODY: Record<Language, string> = {
    fr: 'Toujours à faire — rappel chaque jour jusqu’à complétion',
    en: 'Still to do — reminded every day until completed',
    pt: 'Ainda por fazer — lembrete diário até concluir',
    ru: 'Ещё не выполнено — напоминание каждый день до завершения',
    es: 'Aún por hacer — recordatorio diario hasta completarla',
    ca: 'Encara per fer — recordatori diari fins a completar-la',
    zh: '尚未完成 — 每天提醒直至完成',
    de: 'Noch offen — tägliche Erinnerung bis erledigt',
};

const recapTexts = (titles: string[], more: number): LocalizedTexts =>
    Object.fromEntries(
        LANGUAGES.map((language) => [
            language,
            {
                title: RECAP_TITLE[language].slice(0, 255),
                message: RECAP_BODY[language](titles.slice(0, 3), more).slice(0, 255),
            },
        ]),
    ) as LocalizedTexts;

const reminderTexts = (title: string, offsetDays: number): LocalizedTexts =>
    Object.fromEntries(
        LANGUAGES.map((language) => [
            language,
            {
                title: REMINDER_TITLE[language](title).slice(0, 255),
                message: REMINDER_BODY[language](offsetDays),
            },
        ]),
    ) as LocalizedTexts;

const overdueTexts = (title: string): LocalizedTexts =>
    Object.fromEntries(
        LANGUAGES.map((language) => [
            language,
            {
                title: OVERDUE_TITLE[language](title).slice(0, 255),
                message: OVERDUE_BODY[language],
            },
        ]),
    ) as LocalizedTexts;

interface TaskRow {
    id: string;
    title: string;
    /** The due date as the client typed it: the first 10 chars of the naive timestamp. */
    due_day: string;
    assigned_to: string[];
    reminder_offset_days: number | null;
    reminder_time: string | null;
    reminder_overdue: boolean;
}

interface AccountRow {
    id: string;
    is_owner: boolean;
    role: string;
}

/** Claim a log row BEFORE sending: one reminder per key, ever, even across restarts. */
const claim = async (
    kind: 'due' | 'overdue' | 'recap',
    logDate: string,
    taskId: string | null,
    memberId: string | null,
): Promise<boolean> => {
    const claimed = await query(
        `INSERT INTO tasks_reminder_log (task_id, member_id, kind, log_date)
         VALUES ($1, $2, $3, $4::date)
         ON CONFLICT DO NOTHING
         RETURNING 1`,
        [taskId, memberId, kind, logDate]
    );
    return claimed.rows.length > 0;
};

const processFamily = async (ownerId: string, now: Date): Promise<void> => {
    const zone = await familyTimeZone(ownerId);
    const today = dayInZone(now, zone);

    // Reset paresseux AVANT lecture (même helper, même WHERE que GET /api/tasks) :
    // une quotidienne cochée hier redevient « à faire » et apparaît dans le récap.
    await resetRecurringTasksDue(query, ownerId);

    const { rows: taskRows } = await query(
        `SELECT id, title, due_date, assigned_to, reminder_offset_days, reminder_time, reminder_overdue
         FROM tasks
         WHERE user_id = $1
           AND due_date IS NOT NULL
           AND is_completed = false
           AND NOT pending_approval`,
        [ownerId]
    );
    const openTasks: TaskRow[] = (taskRows as any[]).map((row) => ({
        id: String(row.id),
        title: String(row.title),
        // due_date comes back as a naive local string ('YYYY-MM-DDTHH:mm:ss'):
        // the first 10 chars are the date the client typed, no zone round-trip.
        due_day: String(row.due_date).slice(0, 10),
        assigned_to: Array.isArray(row.assigned_to) ? row.assigned_to : [],
        reminder_offset_days: row.reminder_offset_days === null ? null : Number(row.reminder_offset_days),
        reminder_time: row.reminder_time ?? null,
        reminder_overdue: Boolean(row.reminder_overdue),
    }));
    if (openTasks.length === 0) return;

    // Accounts of the family that have at least one push subscription —
    // members without a subscription are silently ignored.
    const { rows: accountRows } = await query(
        `SELECT u.id, (u.family_owner_id IS NULL) AS is_owner, COALESCE(u.role, 'parent') AS role
         FROM users u
         WHERE (u.id = $1 OR u.family_owner_id = $1)
           AND EXISTS (SELECT 1 FROM push_subscriptions ps WHERE ps.user_id = u.id)`,
        [ownerId]
    );
    const accounts = accountRows as AccountRow[];
    if (accounts.length === 0) return;

    // Which member profiles are linked to each account.
    const { rows: memberRows } = await query(
        'SELECT id, linked_user_id FROM family_members WHERE user_id = $1 AND linked_user_id IS NOT NULL',
        [ownerId]
    );
    const memberIdsByAccount = new Map<string, string[]>();
    for (const row of memberRows as Array<{ id: string; linked_user_id: string }>) {
        const list = memberIdsByAccount.get(String(row.linked_user_id)) ?? [];
        list.push(String(row.id));
        memberIdsByAccount.set(String(row.linked_user_id), list);
    }

    const isParent = (account: AccountRow): boolean => account.is_owner || account.role !== 'enfant';

    /** Recipients of a dedicated/overdue reminder: assigned accounts, else all parents. */
    const recipientsOf = (task: TaskRow): AccountRow[] => {
        const assigned = new Set(task.assigned_to);
        const direct = accounts.filter((account) =>
            (memberIdsByAccount.get(account.id) ?? []).some((memberId) => assigned.has(memberId))
        );
        return direct.length > 0 ? direct : accounts.filter(isParent);
    };

    // ─── Récap du matin (08:00, rattrapage jusqu'à 09:00 au boot) ───
    const recapDue = instantInZone(`${today}T${pad(TASK_RECAP_HOUR)}:00:00`, zone);
    if (now.getTime() >= recapDue.getTime() && now.getTime() < recapDue.getTime() + RECAP_CATCHUP_MS) {
        for (const account of accounts) {
            const ownMemberIds = memberIdsByAccount.get(account.id) ?? [];
            const own = new Set(ownMemberIds);
            const todaysTasks = openTasks.filter(
                (task) =>
                    task.due_day === today &&
                    (task.assigned_to.length === 0
                        ? isParent(account) // tâches du jour sans assignation → parents
                        : task.assigned_to.some((memberId) => own.has(memberId)))
            );
            if (todaysTasks.length === 0) continue; // pas de push si aucune tâche du jour
            if (!(await claim('recap', today, null, account.id))) continue;
            const titles = todaysTasks.map((task) => task.title);
            await createLocalizedNotification({
                userId: account.id,
                type: 'task_recap',
                relatedId: null,
                url: '/tasks',
                texts: recapTexts(titles, titles.length - Math.min(titles.length, 3)),
            });
            logger.info('task_reminder.recap_sent', { userId: ownerId, account: account.id, tasks: todaysTasks.length });
        }
    }

    // ─── Rappels dédiés (J-X à l'heure choisie) et rappels de retard ───
    for (const task of openTasks) {
        const time = task.reminder_time ?? TASK_REMINDER_DEFAULT_TIME;

        if (task.reminder_offset_days !== null) {
            const reminderDay = addDays(task.due_day, -task.reminder_offset_days);
            const dueAt = instantInZone(`${reminderDay}T${time}:00`, zone);
            // Anti-doublon : un rappel jour-J à 08:00 est couvert par le récap.
            const coveredByRecap = task.reminder_offset_days === 0 && time === TASK_REMINDER_DEFAULT_TIME;
            if (!coveredByRecap && reminderDay === today && now.getTime() >= dueAt.getTime()) {
                if (await claim('due', today, task.id, null)) {
                    for (const account of recipientsOf(task)) {
                        await createLocalizedNotification({
                            userId: account.id,
                            type: 'task_reminder',
                            relatedId: task.id,
                            url: '/tasks',
                            texts: reminderTexts(task.title, task.reminder_offset_days),
                        });
                    }
                    logger.info('task_reminder.due_sent', { taskId: task.id, reminderDay, time });
                }
            }
        }

        if (task.reminder_overdue && task.due_day < today) {
            const dueAt = instantInZone(`${today}T${time}:00`, zone);
            if (now.getTime() >= dueAt.getTime() && (await claim('overdue', today, task.id, null))) {
                for (const account of recipientsOf(task)) {
                    await createLocalizedNotification({
                        userId: account.id,
                        type: 'task_overdue',
                        relatedId: task.id,
                        url: '/tasks',
                        texts: overdueTexts(task.title),
                    });
                }
                logger.info('task_reminder.overdue_sent', { taskId: task.id, dueDay: task.due_day, time });
            }
        }
    }
};

/**
 * One pass: every task reminder due at `now`, in every family's own zone.
 * Exported for the tests; the scheduler calls it every 15 minutes and once at
 * boot (catch-up of the day's missed slot, thanks to the claims).
 */
export async function checkTaskReminders(now: Date = new Date()): Promise<void> {
    try {
        const { rows: families } = await query('SELECT DISTINCT user_id FROM tasks WHERE due_date IS NOT NULL');
        for (const row of families as Array<{ user_id: string }>) {
            // One family in error must not block the others.
            try {
                await processFamily(String(row.user_id), now);
            } catch (err) {
                logger.error('task_reminder.family_error', {
                    userId: row.user_id,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }
    } catch (err) {
        logger.error('task_reminder.error', {
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

export async function pruneTaskReminderLog(): Promise<void> {
    try {
        // Keyed on log_date, NEVER on sent_at (correctif 1101609): only a row
        // whose log_date is today can be re-claimed, so a 60-day retention on
        // log_date keeps the idempotence intact while old rows are pure history.
        await query("DELETE FROM tasks_reminder_log WHERE log_date < CURRENT_DATE - interval '60 days'");
    } catch (err) {
        logger.error('task_reminder.prune_error', {
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

export function startTaskReminderScheduler(): void {
    const tz = serverTimeZone();

    // Every 15 minutes: reminder_time is quarter-hour aligned, and the recap
    // goes out at 08:00 on each family's clocks, whatever zone the server runs in.
    cron.schedule('*/15 * * * *', () => {
        void checkTaskReminders();
    }, { timezone: tz });
    cron.schedule('18 3 * * *', () => {
        void pruneTaskReminderLog();
    }, { timezone: tz });
    // Catch-up right after boot: the day's reminders whose slot arrived while
    // the server was down go out now (the claims keep them single-shot).
    void checkTaskReminders();

    logger.info('task_reminder.scheduler_started', { timezone: tz });
}
