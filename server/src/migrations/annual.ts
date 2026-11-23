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
    {
        // Fréquences étendues des tâches récurrentes (chantier C) : une
        // fréquence « Personnalisé » porte son intervalle dans deux colonnes
        // nullable — recurrence_custom_value (entier) + recurrence_custom_unit
        // ('days' 1-365, 'months' 1-12, bornes validées côté API). Les deux
        // sont NULL pour toute autre fréquence (validé au POST/PUT, 400 sinon).
        // Strictement additif : les tâches existantes ont les deux à NULL.
        id: 'annual/0007-tasks-custom-frequency',
        statements: [
            'ALTER TABLE tasks ADD COLUMN IF NOT EXISTS recurrence_custom_value INTEGER',
            `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS recurrence_custom_unit TEXT
             CHECK (recurrence_custom_unit IS NULL OR recurrence_custom_unit IN ('days', 'months'))`,
            // Défense anti-garbage en base : jamais un seul des deux renseigné.
            `ALTER TABLE tasks ADD CONSTRAINT tasks_custom_frequency_both_or_none
             CHECK ((recurrence_custom_value IS NULL) = (recurrence_custom_unit IS NULL))`,
        ],
    },
    {
        // Rappels push des tâches (fonctionnalité 14 du fork) : configuration
        // PAR TÂCHE, purement additive — les tâches existantes gardent
        // reminder_offset_days = NULL et reminder_overdue = false, donc aucun
        // rappel dédié ni rappel de retard pour elles (pas de pluie de push à
        // la mise en prod ; le récap du matin, lui, est global et les couvre).
        // - reminder_offset_days : J-X du rappel dédié, 0..7 (0 = jour-J) ;
        //   NULL = aucun rappel dédié.
        // - reminder_time : 'HH:MM' au quart d'heure près (aligné sur le cron
        //   */15), NULL = repli 08:00.
        // - reminder_overdue : rappel chaque jour à reminder_time tant que la
        //   tâche est en retard et non cochée.
        id: 'annual/0008-tasks-reminders',
        statements: [
            `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS reminder_offset_days INTEGER
             CHECK (reminder_offset_days IS NULL OR reminder_offset_days BETWEEN 0 AND 7)`,
            `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS reminder_time TEXT
             CHECK (
                reminder_time IS NULL
                OR (
                    reminder_time ~ '^([01][0-9]|2[0-3]):[0-9]{2}$'
                    AND substring(reminder_time from 4 for 2) IN ('00', '15', '30', '45')
                )
             )`,
            'ALTER TABLE tasks ADD COLUMN IF NOT EXISTS reminder_overdue BOOLEAN NOT NULL DEFAULT FALSE',
            // Log d'idempotence des rappels tâches (même pattern que
            // annual_reminder_log / appointment_reminder_log) : une ligne est
            // CLAIMED avant l'envoi, donc un rappel ne part qu'une fois, même
            // après reboot (le rattrapage au boot rejoue la passe du jour).
            // - kind 'due' / 'overdue' : claim par (task_id, kind, log_date) ;
            // - kind 'recap' (récap du matin) : claim par (member_id, log_date),
            //   member_id = le compte (users.id) destinataire du push.
            `CREATE TABLE IF NOT EXISTS tasks_reminder_log (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
                member_id UUID REFERENCES users(id) ON DELETE CASCADE,
                kind TEXT NOT NULL CHECK (kind IN ('due', 'overdue', 'recap')),
                log_date DATE NOT NULL,
                sent_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )`,
            'CREATE INDEX IF NOT EXISTS idx_tasks_reminder_log_sent_at ON tasks_reminder_log(sent_at)',
            `CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_reminder_log_task_kind_day
             ON tasks_reminder_log(task_id, kind, log_date) WHERE kind IN ('due', 'overdue')`,
            `CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_reminder_log_recap_member_day
             ON tasks_reminder_log(member_id, log_date) WHERE kind = 'recap'`,
        ],
    },
    {
        // Module Listes (fonctionnalité 15 du fork) : liste de listes
        // familiales (toute la famille voit tout), items cochables
        // regroupés par catégorie texte libre. Strictement additif.
        // - lists.user_id : scoping famille (comme toutes les tables
        //   familiales ; absent de la spec d'origine, ajouté ici).
        // - icon : emoji du jeu fixe LIST_ICONS (shared), CHECK en base.
        // - created_by / checked_by : profil membre (family_members.id),
        //   NULL si le compte n'est lié à aucun profil.
        // - list_items.position : ordre de création (MAX+1), pas de
        //   glisser-déposer en v1. Cascade sur la suppression de la liste.
        id: 'annual/0009-lists-module',
        statements: [
            `CREATE TABLE IF NOT EXISTS lists (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                name TEXT NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 120),
                icon TEXT NOT NULL DEFAULT '📝' CHECK (icon IN ('📝','🛒','🎒','✅','🏠','🚗','🎁','💊','📚','🧸','🍽️','🔧','🌳','🐶','✈️','💼')),
                created_by UUID REFERENCES family_members(id) ON DELETE SET NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )`,
            'CREATE INDEX IF NOT EXISTS idx_lists_user ON lists(user_id)',
            `CREATE TABLE IF NOT EXISTS list_items (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                list_id UUID NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
                text TEXT NOT NULL CHECK (char_length(trim(text)) BETWEEN 1 AND 200),
                category TEXT CHECK (category IS NULL OR char_length(category) <= 60),
                checked BOOLEAN NOT NULL DEFAULT FALSE,
                checked_by UUID REFERENCES family_members(id) ON DELETE SET NULL,
                checked_at TIMESTAMPTZ,
                position INTEGER NOT NULL,
                created_by UUID REFERENCES family_members(id) ON DELETE SET NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )`,
            'CREATE INDEX IF NOT EXISTS idx_list_items_list_position ON list_items(list_id, position)',
            'CREATE INDEX IF NOT EXISTS idx_list_items_list_category ON list_items(list_id, category)',
        ],
    },
    {
        // Shopping stores (fonctionnalité 16 du fork) : onglets « magasin » de
        // la page Courses. shopping_items.store_id NULL = onglet « Général »
        // (aucune donnée migrée : tout l'existant reste dans Général).
        // La suppression d'un magasin rapatrie ses articles dans Général via
        // ON DELETE SET NULL — jamais de perte. L'icône est dans le même jeu
        // fixe que les listes (LIST_ICONS de @openfamily/shared) ; le CHECK
        // reprend la liste en dur comme annual/0009, les deux doivent rester
        // synchronisés.
        id: 'annual/0010-shopping-stores',
        statements: [
            `CREATE TABLE IF NOT EXISTS shopping_stores (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                name TEXT NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 60),
                icon TEXT NOT NULL DEFAULT '🛒' CHECK (icon IN ('📝','🛒','🎒','✅','🏠','🚗','🎁','💊','📚','🧸','🍽️','🔧','🌳','🐶','✈️','💼')),
                position INTEGER NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )`,
            'CREATE INDEX IF NOT EXISTS idx_shopping_stores_user ON shopping_stores(user_id)',
            `ALTER TABLE shopping_items ADD COLUMN IF NOT EXISTS store_id UUID NULL
             REFERENCES shopping_stores(id) ON DELETE SET NULL`,
            'CREATE INDEX IF NOT EXISTS idx_shopping_items_store ON shopping_items(store_id)',
        ],
    },
];
