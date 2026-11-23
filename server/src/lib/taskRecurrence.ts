import { formatDateOnly, parseDateOnly } from './budgetRecurrence';
import type { QueryFn } from '../db';

// Auto-gestion des tâches récurrentes (post-version n°2, étendu en chantier C) :
// à la complétion, l'échéance avance au cycle suivant selon l'ancre choisie —
// 'calendar' (NULL, défaut) ou 'completion'. Au démarrage du cycle suivant
// (lecture GET), la corvée redevient « à faire » (reset paresseux côté route).

export const TASK_RECURRENCE_ANCHORS = ['calendar', 'completion'] as const;
export type TaskRecurrenceAnchor = (typeof TASK_RECURRENCE_ANCHORS)[number];

// Fréquences intégrées qui rendent une tâche auto-gérée. « Une fois » (ou
// NULL) reste strictement ponctuel : jamais d'avance, jamais de reset.
export const BUILTIN_RECURRING_TASK_FREQUENCIES: readonly string[] = [
    'Quotidien',
    'Hebdomadaire',
    'Mensuel',
    'Trimestriel',
    'Quadrimestriel',
    'Semestriel',
    'Annuel',
];

// « Personnalisé » est récurrent lui aussi, mais seulement avec un intervalle
// valide (voir isValidCustomFrequency) : une tâche Personnalisé dont les
// colonnes custom sont absentes/invalides n'est JAMAIS avancée ni reset
// (défense anti-garbage).
export const RECURRING_TASK_FREQUENCIES: ReadonlySet<string> = new Set([
    ...BUILTIN_RECURRING_TASK_FREQUENCIES,
    'Personnalisé',
]);

export const isRecurringTaskFrequency = (frequency: unknown): boolean =>
    typeof frequency === 'string' && RECURRING_TASK_FREQUENCIES.has(frequency);

// ─── Fréquence personnalisée (chantier C) ────────────────────────────────────

export const CUSTOM_FREQUENCY_UNITS = ['days', 'months'] as const;
export type TaskCustomFrequencyUnit = (typeof CUSTOM_FREQUENCY_UNITS)[number];
export interface TaskCustomFrequency { value: number; unit: TaskCustomFrequencyUnit }

/** Plage valide de l'intervalle : 1-365 jours, 1-12 mois. */
export const customValueRange = (unit: TaskCustomFrequencyUnit): { min: number; max: number } =>
    unit === 'days' ? { min: 1, max: 365 } : { min: 1, max: 12 };

export const isValidCustomFrequency = (custom: unknown): custom is TaskCustomFrequency => {
    if (!custom || typeof custom !== 'object') return false;
    const { value, unit } = custom as { value?: unknown; unit?: unknown };
    if (unit !== 'days' && unit !== 'months') return false;
    if (typeof value !== 'number' || !Number.isInteger(value)) return false;
    const { min, max } = customValueRange(unit);
    return value >= min && value <= max;
};

/** Lit les colonnes custom d'une ligne tasks ; null si absentes ou invalides. */
export const customFrequencyFromRow = (
    row: { recurrence_custom_value?: unknown; recurrence_custom_unit?: unknown } | null | undefined,
): TaskCustomFrequency | null => {
    if (!row) return null;
    const custom = { value: row.recurrence_custom_value, unit: row.recurrence_custom_unit };
    if (!isValidCustomFrequency(custom)) return null;
    return { value: custom.value, unit: custom.unit };
};

/**
 * Validation des champs custom envoyés par le client :
 * - les deux vides/null → { ok: true, custom: null } (les colonnes passent à NULL) ;
 * - sinon unit 'days'|'months' + entier dans la plage (jours 1-365, mois 1-12).
 * Un seul des deux renseigné, une unité inconnue ou une valeur hors bornes → { ok: false }.
 */
export const normalizeCustomFrequencyInput = (
    value: unknown,
    unit: unknown,
): { ok: true; custom: TaskCustomFrequency | null } | { ok: false } => {
    const empty = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
    if (empty(value) && empty(unit)) return { ok: true, custom: null };
    if (empty(value) || empty(unit)) return { ok: false };
    const u = typeof unit === 'string' ? unit.trim().toLowerCase() : '';
    if (u !== 'days' && u !== 'months') return { ok: false };
    const n = typeof value === 'string' ? Number(value) : value;
    if (typeof n !== 'number' || !Number.isInteger(n)) return { ok: false };
    const { min, max } = customValueRange(u as TaskCustomFrequencyUnit);
    if (n < min || n > max) return { ok: false };
    return { ok: true, custom: { value: n, unit: u as TaskCustomFrequencyUnit } };
};

/**
 * Champ recurrence_anchor envoyé par le client : null ou chaîne vide =
 * retour au défaut (calendrier, NULL en base) ; sinon 'calendar' ou
 * 'completion' (casse-insensible). Toute autre valeur est rejetée.
 */
export const normalizeTaskAnchorInput = (
    value: unknown,
): { ok: true; anchor: TaskRecurrenceAnchor | null } | { ok: false } => {
    if (value === null) return { ok: true, anchor: null };
    const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (!v) return { ok: true, anchor: null };
    if ((TASK_RECURRENCE_ANCHORS as readonly string[]).includes(v)) {
        return { ok: true, anchor: v as TaskRecurrenceAnchor };
    }
    return { ok: false };
};

const addDays = (date: Date, days: number): Date => {
    const d = new Date(date.getTime());
    d.setUTCDate(d.getUTCDate() + days);
    return d;
};

// Règle du dernier jour (même règle que l'argent) : un jour inexistant dans
// le mois cible est ramené au dernier jour du mois — le 31 → février = 28/29,
// jamais de saut de mois.
const addMonthsClamped = (date: Date, months: number): Date => {
    const total = date.getUTCFullYear() * 12 + date.getUTCMonth() + months;
    const year = Math.floor(total / 12);
    const month = total % 12;
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return new Date(Date.UTC(year, month, Math.min(date.getUTCDate(), daysInMonth)));
};

/** Un pas de période de la fréquence, avec clamp de fin de mois. */
export const advanceTaskDueDate = (
    due: Date,
    frequency: string,
    custom?: TaskCustomFrequency | null,
): Date => {
    switch (frequency) {
        case 'Quotidien': return addDays(due, 1);
        case 'Hebdomadaire': return addDays(due, 7);
        case 'Mensuel': return addMonthsClamped(due, 1);
        case 'Trimestriel': return addMonthsClamped(due, 3);
        case 'Quadrimestriel': return addMonthsClamped(due, 4);
        case 'Semestriel': return addMonthsClamped(due, 6);
        case 'Annuel': return addMonthsClamped(due, 12);
        case 'Personnalisé':
            // Défense anti-garbage : sans intervalle valide, aucun avancement.
            if (!isValidCustomFrequency(custom)) return due;
            return custom.unit === 'days'
                ? addDays(due, custom.value)
                : addMonthsClamped(due, custom.value);
        default: return due;
    }
};

const dateOfToday = (): Date => parseDateOnly(formatDateOnly(new Date())) as Date;

/**
 * Reset paresseux des corvées récurrentes (post-version n°2, corrigé en lot D),
 * extrait tel quel de GET /api/tasks (lot fdbc2f7) pour être réutilisé par le
 * scheduler de rappels AVANT lecture — sans aucun changement de comportement :
 * une tâche récurrente complétée dont l'échéance est ATTEINTE
 * (due_date <= aujourd'hui, et non "passée") redevient « à faire » dès le
 * démarrage du cycle. C'est un UPDATE direct, JAMAIS la route d'édition :
 * jamais de reward_transactions touchées, pending_approval jamais reset,
 * les retards jamais effacés, « Une fois »/NULL strictement ponctuel, et
 * « Personnalisé » reset seulement avec un intervalle custom valide
 * (défense anti-garbage). Idempotent.
 * `q` est query() ou la query d'une transaction : même WHERE dans les deux cas.
 */
export const resetRecurringTasksDue = async (q: QueryFn, userId: string): Promise<void> => {
    await q(
        `UPDATE tasks
         SET is_completed = false, completed_at = NULL
         WHERE user_id = $1
           AND (
                frequency = ANY($2)
                OR (
                    frequency = 'Personnalisé'
                    AND recurrence_custom_unit IN ('days', 'months')
                    AND recurrence_custom_value IS NOT NULL
                    AND (
                        (recurrence_custom_unit = 'days' AND recurrence_custom_value BETWEEN 1 AND 365)
                        OR (recurrence_custom_unit = 'months' AND recurrence_custom_value BETWEEN 1 AND 12)
                    )
                )
           )
           AND is_completed
           AND NOT pending_approval
           AND due_date IS NOT NULL
           AND due_date <= CURRENT_DATE`,
        [userId, [...BUILTIN_RECURRING_TASK_FREQUENCIES]]
    );
};

// ─── Rappels push des tâches (fonctionnalité 14 du fork) ──────────────────────

/** Heure de repli quand reminder_time est NULL : celle du récap du matin. */
export const TASK_REMINDER_DEFAULT_TIME = '08:00';
/** Heure du récap global du matin, sur les horloges de la famille. */
export const TASK_RECAP_HOUR = 8;
/** Jours avant l'échéance : 0 (jour-J) à 7. */
export const TASK_REMINDER_MAX_OFFSET_DAYS = 7;

const TIME_RE = /^([01][0-9]|2[0-3]):([0-9]{2})$/;
const QUARTER_MINUTES = new Set(['00', '15', '30', '45']);

/** 'HH:MM' valide au quart d'heure près, ou null. */
export const isValidReminderTime = (value: unknown): value is string | null => {
    if (value === null) return true;
    if (typeof value !== 'string') return false;
    const match = TIME_RE.exec(value);
    return match !== null && QUARTER_MINUTES.has(match[2]);
};

export interface TaskReminderFields {
    reminder_offset_days: number | null;
    reminder_time: string | null;
    reminder_overdue: boolean;
}

/**
 * Validation stricte des trois champs de rappel envoyés par le client
 * (POST et PUT /api/tasks) — défense anti-garbage identique au lot C :
 * - reminder_offset_days : null (aucun rappel dédié) ou entier 0..7 ;
 * - reminder_time : null/'' (repli 08:00) ou 'HH:MM' au quart d'heure ;
 * - reminder_overdue : booléen.
 * `undefined` = champ absent de la requête (non modifié en PUT, défaut en
 * POST). Toute valeur hors bornes → { ok: false, field } → 400.
 */
export const normalizeTaskReminderInput = (body: {
    reminder_offset_days?: unknown;
    reminder_time?: unknown;
    reminder_overdue?: unknown;
}): { ok: true; fields: Partial<TaskReminderFields> } | { ok: false; field: string } => {
    const fields: Partial<TaskReminderFields> = {};

    if (body.reminder_offset_days !== undefined) {
        const v = body.reminder_offset_days;
        if (v === null) {
            fields.reminder_offset_days = null;
        } else {
            const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
            if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > TASK_REMINDER_MAX_OFFSET_DAYS) {
                return { ok: false, field: 'reminder_offset_days' };
            }
            fields.reminder_offset_days = n;
        }
    }

    if (body.reminder_time !== undefined) {
        const v = body.reminder_time;
        if (v === null || (typeof v === 'string' && v.trim() === '')) {
            fields.reminder_time = null;
        } else if (isValidReminderTime(v)) {
            fields.reminder_time = (v as string).trim();
        } else {
            return { ok: false, field: 'reminder_time' };
        }
    }

    if (body.reminder_overdue !== undefined) {
        if (typeof body.reminder_overdue !== 'boolean') {
            return { ok: false, field: 'reminder_overdue' };
        }
        fields.reminder_overdue = body.reminder_overdue;
    }

    return { ok: true, fields };
};

/**
 * Prochaine échéance à la complétion d'une tâche récurrente (calculée pour
 * être écrite DANS LA MÊME requête que la complétion, côté route PUT) :
 * - 'calendar' (défaut, NULL) : prochaine occurrence du motif à partir de
 *   demain — corvée hebdo due mardi, faite lundi → mardi ; faite mardi →
 *   mardi suivant. Si elle est faite en retard, le rattrapage est naturel :
 *   on avance par pas d'intervalle jusqu'à la première occurrence ≥ demain
 *   (hebdo faite 3 semaines en retard → mardi suivant ; « tous les 5 jours »
 *   en retard → première occurrence ≥ demain) ;
 * - 'completion' : date de complétion + un intervalle.
 * Renvoie null si la tâche n'est pas récurrente, n'a pas d'échéance, ou est
 * « Personnalisé » sans intervalle valide (aucun changement dans ces cas).
 */
export const nextTaskDueDateOnComplete = (
    anchor: string | null | undefined,
    dueDate: unknown,
    frequency: unknown,
    completedOn: Date = new Date(),
    custom?: TaskCustomFrequency | null,
): string | null => {
    if (!isRecurringTaskFrequency(frequency)) return null;
    if (frequency === 'Personnalisé' && !isValidCustomFrequency(custom ?? null)) return null;
    const due = parseDateOnly(dueDate);
    if (!due) return null;

    if ((anchor ?? 'calendar') === 'completion') {
        const completedDate = parseDateOnly(formatDateOnly(completedOn)) as Date;
        return formatDateOnly(advanceTaskDueDate(completedDate, String(frequency), custom ?? null));
    }

    const tomorrow = addDays(dateOfToday(), 1);
    let candidate = due;
    // Borne de sécurité : une échéance très ancienne remonte d'un coup,
    // sans boucle infinie.
    let guard = 0;
    while (candidate.getTime() < tomorrow.getTime() && guard++ < 100000) {
        candidate = advanceTaskDueDate(candidate, String(frequency), custom ?? null);
    }
    return formatDateOnly(candidate);
};
