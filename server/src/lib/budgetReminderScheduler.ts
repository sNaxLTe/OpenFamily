import cron from 'node-cron';
import { query } from '../db';
import { createLocalizedNotification, LocalizedTexts } from './notifications';
import { Language, LANGUAGES } from './languages';
import logger from './logger';
import { describeLeadTime } from './reminderScheduler';
import { addDays, dayInZone, familyTimeZone, instantInZone, serverTimeZone } from './timeZone';
import { expandRecurringTransactions } from './budgetRecurrence';

// Budget reminders (fonctionnalité 3, mécanisme B): a recurring series with
// reminder_days = X is notified X days before each occurrence, at
// BUDGET_REMINDER_HOUR on the family's own clocks (the same convention as
// all-day appointment reminders). The other mechanism — the linked all-day
// calendar event and its reminders — is untouched.
//
// Delivery follows the appointment_reminder_log / birthday_notice_log pattern:
// one row per (series, occurrence, offset) in annual_reminder_log, claimed
// BEFORE the notification is sent, so a reminder goes out exactly once even
// across restarts; the boot pass is the catch-up after a reboot (a reminder
// whose day arrived while the server was down is sent as long as the
// occurrence itself has not passed).

/** The hour of the day, on the family's clocks, at which budget reminders go out. */
export const BUDGET_REMINDER_HOUR = 9;

const TITLE: Record<Language, (label: string) => string> = {
    fr: (label) => `⏰ Rappel budget : ${label}`,
    en: (label) => `⏰ Budget reminder: ${label}`,
    pt: (label) => `⏰ Lembrete de orçamento: ${label}`,
    ru: (label) => `⏰ Напоминание о бюджете: ${label}`,
    es: (label) => `⏰ Recordatorio de presupuesto: ${label}`,
    ca: (label) => `⏰ Recordatori de pressupost: ${label}`,
    zh: (label) => `⏰ 预算提醒：${label}`,
    de: (label) => `⏰ Budget-Erinnerung: ${label}`,
};

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

const BODY: Record<Language, (label: string, amount: string, when: string) => string> = {
    fr: (label, amount, when) => `${label} : ${amount} prévu ${when}`,
    en: (label, amount, when) => `${label}: ${amount} due ${when}`,
    pt: (label, amount, when) => `${label}: ${amount} previsto para ${when}`,
    ru: (label, amount, when) => `${label}: ${amount} — ${when}`,
    es: (label, amount, when) => `${label}: ${amount} — ${when}`,
    ca: (label, amount, when) => `${label}: ${amount} — ${when}`,
    zh: (label, amount, when) => `${label}：${amount}（${when}）`,
    de: (label, amount, when) => `${label}: ${amount} — ${when}`,
};

/** "dans 3 jours" / "in 3 days", lower-cased to sit inside the sentence. */
const whenText = (days: number, lang: Language): string => {
    if (days === 0) return TODAY[lang];
    const text = describeLeadTime(days * 24 * 60, lang);
    return text.charAt(0).toLowerCase() + text.slice(1);
};

const textsFor = (label: string, amount: string, days: number): LocalizedTexts =>
    Object.fromEntries(
        LANGUAGES.map((language) => [
            language,
            {
                title: TITLE[language](label).slice(0, 255),
                message: BODY[language](label, amount, whenText(days, language)),
            },
        ]),
    ) as LocalizedTexts;

const pad = (value: number): string => String(value).padStart(2, '0');

/**
 * One pass: every reminder due at `now`, in every family's own zone. Exported
 * for the tests; the scheduler calls it every 15 minutes and once at boot.
 */
export async function checkBudgetReminders(now: Date = new Date()): Promise<void> {
    try {
        const { rows: series } = await query(
            `SELECT re.id, re.user_id, re.label, re.amount, re.reminder_days,
                    re.start_date, re.debit_day, re.recurrence_frequency,
                    re.recurrence_interval, re.recurrence_until, re.is_active
             FROM recurring_expenses re
             WHERE re.reminder_days IS NOT NULL
               AND re.is_active = true`
        );
        if (series.length === 0) return;

        const byFamily = new Map<string, any[]>();
        for (const row of series) {
            const list = byFamily.get(row.user_id) ?? [];
            list.push(row);
            byFamily.set(row.user_id, list);
        }

        for (const [userId, familySeries] of byFamily) {
            const zone = await familyTimeZone(userId);
            const today = dayInZone(now, zone);

            for (const item of familySeries) {
                const days = Number(item.reminder_days);
                // Only occurrences from today up to today+days can have their
                // reminder day reached while the occurrence is still ahead.
                const occurrences = expandRecurringTransactions(
                    [item],
                    today,
                    addDays(today, days)
                );

                for (const occurrence of occurrences) {
                    const occurrenceDate: string = occurrence.occurrence_date;
                    const reminderDay = addDays(occurrenceDate, -days);
                    const due = instantInZone(
                        `${reminderDay}T${pad(BUDGET_REMINDER_HOUR)}:00:00`,
                        zone
                    );
                    // Not yet 09:00 on the reminder day — the next pass will take it.
                    if (now.getTime() < due.getTime()) continue;

                    // Claimed before sending: one reminder per occurrence and
                    // offset, ever, even across restarts and overlapping passes.
                    const claimed = await query(
                        `INSERT INTO annual_reminder_log (recurring_expense_id, occurrence_date, reminder_days)
                         VALUES ($1, $2::date, $3)
                         ON CONFLICT DO NOTHING
                         RETURNING 1`,
                        [item.id, occurrenceDate, days]
                    );
                    if (claimed.rows.length === 0) continue;

                    const amount = String(Number(occurrence.amount ?? item.amount));
                    const accounts = await query(
                        'SELECT id FROM users WHERE id = $1 OR family_owner_id = $1',
                        [userId]
                    );
                    for (const account of accounts.rows as Array<{ id: string }>) {
                        await createLocalizedNotification({
                            userId: account.id,
                            type: 'budget_reminder',
                            relatedId: item.id,
                            url: '/budget',
                            texts: textsFor(String(item.label), amount, days),
                        });
                    }
                    logger.info('budget.reminder_sent', {
                        recurringExpenseId: item.id,
                        occurrenceDate,
                        reminderDays: days,
                        accounts: accounts.rows.length,
                    });
                }
            }
        }
    } catch (err) {
        logger.error('budget.reminder_error', {
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

async function pruneBudgetReminderLog(): Promise<void> {
    try {
        await query("DELETE FROM annual_reminder_log WHERE sent_at < now() - interval '60 days'");
    } catch (err) {
        logger.error('budget.reminder_prune_error', {
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

export function startBudgetReminderScheduler(): void {
    const tz = serverTimeZone();

    // Every 15 minutes: a reminder is due at 09:00 on each family's clocks,
    // whatever zone the server runs in.
    cron.schedule('*/15 * * * *', () => {
        void checkBudgetReminders();
    }, { timezone: tz });
    cron.schedule('18 3 * * *', () => {
        void pruneBudgetReminderLog();
    }, { timezone: tz });
    // Catch-up right after boot: reminders whose day arrived while the server
    // was down go out now, unless the occurrence has already passed.
    void checkBudgetReminders();

    logger.info('budget_reminder.scheduler_started', { timezone: tz });
}
