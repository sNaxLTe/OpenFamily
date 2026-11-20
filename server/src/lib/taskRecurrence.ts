import { formatDateOnly, parseDateOnly } from './budgetRecurrence';

// Auto-gestion des tâches récurrentes (post-version n°2) : à la complétion,
// l'échéance avance au cycle suivant selon l'ancre choisie — 'calendar'
// (NULL, défaut) ou 'completion'. Au démarrage du cycle suivant (lecture
// GET), la corvée redevient « à faire » (reset paresseux côté route).

export const TASK_RECURRENCE_ANCHORS = ['calendar', 'completion'] as const;
export type TaskRecurrenceAnchor = (typeof TASK_RECURRENCE_ANCHORS)[number];

// Fréquences qui rendent une tâche auto-gérée. « Une fois » (ou NULL) reste
// strictement ponctuel : jamais d'avance, jamais de reset.
export const RECURRING_TASK_FREQUENCIES: ReadonlySet<string> = new Set([
    'Quotidien',
    'Hebdomadaire',
    'Mensuel',
    'Trimestriel',
    'Quadrimestriel',
    'Annuel',
]);

export const isRecurringTaskFrequency = (frequency: unknown): boolean =>
    typeof frequency === 'string' && RECURRING_TASK_FREQUENCIES.has(frequency);

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
export const advanceTaskDueDate = (due: Date, frequency: string): Date => {
    switch (frequency) {
        case 'Quotidien': return addDays(due, 1);
        case 'Hebdomadaire': return addDays(due, 7);
        case 'Mensuel': return addMonthsClamped(due, 1);
        case 'Trimestriel': return addMonthsClamped(due, 3);
        case 'Quadrimestriel': return addMonthsClamped(due, 4);
        case 'Annuel': return addMonthsClamped(due, 12);
        default: return due;
    }
};

const dateOfToday = (): Date => parseDateOnly(formatDateOnly(new Date())) as Date;

/**
 * Prochaine échéance à la complétion d'une tâche récurrente (calculée pour
 * être écrite DANS LA MÊME requête que la complétion, côté route PUT) :
 * - 'calendar' (défaut, NULL) : prochaine occurrence du motif à partir de
 *   demain — corvée hebdo due mardi, faite lundi → mardi ; faite mardi →
 *   mardi suivant ;
 * - 'completion' : date de complétion + une période.
 * Renvoie null si la tâche n'est pas récurrente ou n'a pas d'échéance
 * (aucun changement dans ce cas).
 */
export const nextTaskDueDateOnComplete = (
    anchor: string | null | undefined,
    dueDate: unknown,
    frequency: unknown,
    completedOn: Date = new Date(),
): string | null => {
    if (!isRecurringTaskFrequency(frequency)) return null;
    const due = parseDateOnly(dueDate);
    if (!due) return null;

    if ((anchor ?? 'calendar') === 'completion') {
        const completedDate = parseDateOnly(formatDateOnly(completedOn)) as Date;
        return formatDateOnly(advanceTaskDueDate(completedDate, String(frequency)));
    }

    const tomorrow = addDays(dateOfToday(), 1);
    let candidate = due;
    // Borne de sécurité : une échéance très ancienne remonte d'un coup,
    // sans boucle infinie.
    let guard = 0;
    while (candidate.getTime() < tomorrow.getTime() && guard++ < 100000) {
        candidate = advanceTaskDueDate(candidate, String(frequency));
    }
    return formatDateOnly(candidate);
};
