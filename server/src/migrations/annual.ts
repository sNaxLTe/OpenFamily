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
];
