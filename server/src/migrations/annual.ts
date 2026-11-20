// Downstream migrations of this fork (sNaxLTe/OpenFamily, branche
// feature/annual-budget). Upstream owns the 'core/' namespace in registry.ts;
// a downstream build carries its own namespace and its own list, run after
// the core list (see db.ts). Same rules as upstream: appended at the end,
// never edited or reordered once shipped, and ADDITIVE ONLY — nothing here
// may alter or drop what the official images created, so a database migrated
// by this fork keeps working with the official 1.9.0 images (rollback =
// repoint the images; the runner only warns about unknown ids).

import type { Migration } from './runner';

export const annualMigrations: readonly Migration[] = [
    {
        // Budget reminder for a recurring series (fonctionnalité 3): how many
        // days before an occurrence the daily job pushes a notification.
        // NULL = no budget reminder (the default, so existing series behave
        // exactly as before). The other reminder mechanism — the linked
        // all-day calendar event (appointments.linked_recurring_expense_id)
        // with its own reminders — is untouched and stays independent.
        id: 'annual/0001-recurring-reminder-days',
        statements: [
            'ALTER TABLE recurring_expenses ADD COLUMN IF NOT EXISTS reminder_days INTEGER CHECK (reminder_days IS NULL OR reminder_days BETWEEN 0 AND 365)',
        ],
    },
    {
        // Annual category limits (fonctionnalité 4): a budget_limits row with
        // month = NULL is the ANNUAL limit of the category for that year,
        // alongside the existing monthly rows (month 1..12, unchanged). The
        // existing CHECK (month BETWEEN 1 AND 12) already lets NULL through
        // (a CHECK passes on unknown), so only the NOT NULL had to go. The
        // old UNIQUE(user_id, category, month, year) treats NULLs as distinct,
        // so uniqueness of the annual row comes from this partial index —
        // on (user_id, category, YEAR): a limit is per year, like the monthly
        // ones. Monthly behaviour is untouched: the dashboard alerts join on
        // bl.month = EXTRACT(MONTH …), which never matches NULL.
        id: 'annual/0002-annual-budget-limits',
        statements: [
            'ALTER TABLE budget_limits ALTER COLUMN month DROP NOT NULL',
            'CREATE UNIQUE INDEX IF NOT EXISTS idx_budget_limits_annual_unique ON budget_limits(user_id, category, year) WHERE month IS NULL',
        ],
    },
    {
        // Idempotence log of the budget reminders (fonctionnalité 3, mécanisme
        // B): one row per series, occurrence and offset, claimed before the
        // notification is sent — the same pattern as appointment_reminder_log
        // (core/0004) — so a reminder goes out once even across restarts, and
        // the boot-time catch-up pass can tell what was already sent.
        id: 'annual/0003-budget-reminder-log',
        statements: [
            `CREATE TABLE IF NOT EXISTS annual_reminder_log (
                recurring_expense_id UUID NOT NULL REFERENCES recurring_expenses(id) ON DELETE CASCADE,
                occurrence_date DATE NOT NULL,
                reminder_days INTEGER NOT NULL,
                sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                PRIMARY KEY (recurring_expense_id, occurrence_date, reminder_days)
            )`,
            'CREATE INDEX IF NOT EXISTS idx_annual_reminder_log_sent_at ON annual_reminder_log(sent_at)',
        ],
    },
    {
        // End-of-year notes of the Kakeibo mode (fonctionnalité 5): one free
        // text per family and per year. Decision taken at the chantier: an
        // additive table, like kakeibo_months, rather than a column.
        id: 'annual/0004-kakeibo-annual-notes',
        statements: [
            `CREATE TABLE IF NOT EXISTS kakeibo_annual_notes (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                year INTEGER NOT NULL,
                notes TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (user_id, year)
            )`,
            'CREATE INDEX IF NOT EXISTS idx_kakeibo_annual_notes_user ON kakeibo_annual_notes(user_id)',
        ],
    },
    {
        // Pont Paperless → Budget (fonctionnalité 13): a budget entry can be
        // linked to a Paperless document. paperless_document_id is the id in
        // the Paperless instance (server-side env config), paperless_url is
        // the document's web page, DERIVED BY THE SERVER from
        // PAPERLESS_PUBLIC_URL (fallback PAPERLESS_URL) — never taken from
        // the client, so no arbitrary URL is stored.
        // Both nullable: existing entries are untouched. Read-only bridge:
        // nothing here writes to Paperless.
        id: 'annual/0005-paperless-link',
        statements: [
            'ALTER TABLE budget_entries ADD COLUMN IF NOT EXISTS paperless_document_id INTEGER',
            'ALTER TABLE budget_entries ADD COLUMN IF NOT EXISTS paperless_url TEXT',
            'CREATE INDEX IF NOT EXISTS idx_budget_entries_paperless_document ON budget_entries(paperless_document_id)',
        ],
    },
    {
        // Auto-gestion des tâches récurrentes (post-version n°2) : ancre de la
        // récurrence — NULL (défaut, interprété au code) = 'calendar'
        // (prochaine occurrence du motif à partir de demain, à la complétion)
        // ; 'completion' = date de complétion + fréquence. Colonne nullable
        // avec CHECK : strictement additive, les tâches existantes gardent le
        // comportement calendrier.
        id: 'annual/0006-tasks-recurrence-anchor',
        statements: [
            `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS recurrence_anchor TEXT
             CHECK (recurrence_anchor IS NULL OR recurrence_anchor IN ('calendar', 'completion'))`,
        ],
    },
];
