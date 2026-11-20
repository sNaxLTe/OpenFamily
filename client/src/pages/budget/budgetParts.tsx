import React, { useEffect, useRef } from 'react';
import { Calendar, Check, Edit2, Trash2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useCategories } from '../../hooks/useCategories';
import { useHistoryAwareOverlay } from '../../lib/useHistoryAwareOverlay';
import { formatCurrency } from '../../lib/utils';
import { intlLocale } from '../../i18n/format';

// One recurring series (or one of its occurrences in the month view). The
// registry mode of GET /api/budget/recurring adds next_occurrence /
// annual_committed / current_occurrence on top of the plain series fields.
export interface RecurringTransaction {
    id: string;
    series_id?: string;
    occurrence_id?: string;
    occurrence_date?: string;
    label: string;
    amount: number;
    category: string;
    debit_day: number;
    start_date: string;
    recurrence_frequency: 'daily' | 'weekly' | 'monthly' | 'yearly';
    recurrence_interval: number;
    recurrence_until?: string | null;
    is_active: boolean;
    is_expense: boolean;
    is_pointed: boolean;
    pointed_at?: string | null;
    linked_calendar_event_id?: string | null;
    reminder_days?: number | null;
    next_occurrence?: string | null;
    annual_committed?: number;
    current_occurrence?: {
        occurrence_id: string;
        occurrence_date: string;
        is_pointed: boolean;
        pointed_at?: string | null;
    } | null;
}

// Form building blocks shared by the Budget page and its annual view, so both
// render exactly the same sheets, fields and category pickers.

export const Sheet: React.FC<{ open: boolean; onClose: () => void; title: string; children: React.ReactNode }> = ({
    open, onClose, title, children
}) => {
    const { t } = useTranslation('common');
    const titleRef = useRef<HTMLHeadingElement>(null);

    // History-aware: browser back / iOS swipe-back closes the sheet instead
    // of leaving the app (standalone PWA). Covers every sheet of the Budget
    // module, since they all render through this component.
    useHistoryAwareOverlay(open, onClose);

    // Accessibility: Escape closes the sheet, and focus lands on the title
    // when it opens (screen readers announce the dialog through its label).
    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', onKey);
        titleRef.current?.focus();
        return () => window.removeEventListener('keydown', onKey);
    }, [open, onClose]);

    if (!open) return null;
    return (
        <div className="fixed inset-0 z-50 flex flex-col justify-end" onClick={onClose}>
            <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
            <div
                role="dialog"
                aria-modal="true"
                aria-label={title}
                className="relative bg-background rounded-t-2xl shadow-2xl max-h-[90vh] overflow-y-auto"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center justify-between p-4 border-b border-border">
                    <h2 ref={titleRef} tabIndex={-1} className="text-lg font-semibold outline-none">{title}</h2>
                    <button
                        onClick={onClose}
                        aria-label={t('common:actions.close')}
                        className="p-3 rounded-full hover:bg-surface-2 transition-colors"
                    >
                        <X className="w-5 h-5" />
                    </button>
                </div>
                <div className="p-4">{children}</div>
            </div>
        </div>
    );
};

export const Field: React.FC<{
    label: string;
    type?: string;
    value: string;
    onChange: (v: string) => void;
    placeholder?: string;
    required?: boolean;
    min?: string;
    max?: string;
    step?: string;
}> = ({ label, type = 'text', value, onChange, placeholder, required, min, max, step }) => (
    <div>
        <label className="block text-sm font-medium text-foreground mb-1">{label}</label>
        <input
            type={type}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            required={required}
            min={min}
            max={max}
            step={step}
            className="w-full px-3 py-2.5 rounded-xl border border-border bg-surface-1 text-foreground text-base
                       focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition"
        />
    </div>
);

export const CategorySelect: React.FC<{ value: string; onChange: (v: string) => void }> = ({ value, onChange }) => {
    const { t } = useTranslation('budget');
    // Family-customizable list (Settings → Categories). If the current value is no
    // longer in the list (legacy row, renamed category), keep it selectable so the
    // form doesn't silently change the entry's category.
    const { categories: familyCategories } = useCategories();
    const list = !value || familyCategories.budget.includes(value)
        ? familyCategories.budget
        : [value, ...familyCategories.budget];
    return (
        <div>
            <label className="block text-sm font-medium text-foreground mb-1">{t('budget:fields.category')}</label>
            <select
                value={value}
                onChange={(e) => onChange(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl border border-border bg-surface-1 text-foreground text-base
                           focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition"
            >
                {list.map((c) => <option key={c} value={c}>{t(`budget:categories.${c}`, { defaultValue: c })}</option>)}
            </select>
        </div>
    );
};

// Recurring card, shared VERBATIM by the classic month view and the
// "Récurrents" registry tab (post-version n°2): same look, same point/edit/
// delete actions. Optional props only decorate the registry mode.
export const RecurringCard: React.FC<{
    r: RecurringTransaction;
    currency: string;
    canEdit: boolean;
    categoryLabel: (v: string) => string;
    onTogglePoint: (r: RecurringTransaction) => void;
    onEdit: (r: RecurringTransaction) => void;
    onDelete: (id: string) => void;
    nextOccurrence?: string | null; // registry: next occurrence date
    ended?: boolean;                // registry: ended series → greyed card
    endDate?: string | null;        // registry: recurrence_until, displayed when ended
}> = ({ r, currency, canEdit, categoryLabel, onTogglePoint, onEdit, onDelete, nextOccurrence, ended, endDate }) => {
    const { t } = useTranslation('budget');
    return (
        <div
            className={`flex items-start gap-3 rounded-card p-4 transition-all
                ${r.is_pointed ? 'bg-surface-1 opacity-60' : 'bg-surface-1 border border-border shadow-sm'}
                ${ended ? 'opacity-50 saturate-50' : ''}`}
        >
            <button
                onClick={() => onTogglePoint(r)}
                disabled={!canEdit || !r.occurrence_date}
                className={`mt-0.5 flex-shrink-0 w-7 h-7 rounded-full border-2 flex items-center justify-center
                    transition-all active:scale-90 disabled:opacity-50
                    ${r.is_pointed ? 'bg-success/100 border-success' : 'border-border hover:border-success/50'}`}
                title={r.is_pointed ? t('budget:recurring.markOff') : t('budget:recurring.markOn')}
                aria-label={r.is_pointed ? t('budget:recurring.markOff') : t('budget:recurring.markOn')}
            >
                {r.is_pointed && <Check className="w-4 h-4 text-white" strokeWidth={3} />}
            </button>

            {/* Two lines at every width: what and how much, then
                when and how often with the actions. Side by side,
                the details were squeezed into one-letter columns
                on a phone. */}
            <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-3">
                    <p className={`min-w-0 break-words font-medium text-base ${r.is_pointed || ended ? 'line-through text-muted-foreground' : ''}`}>
                        {r.label}
                    </p>
                    <span className={`whitespace-nowrap text-base font-bold ${
                        r.is_pointed || ended
                            ? 'text-muted-foreground'
                            : r.is_expense
                                ? 'text-danger'
                                : 'text-success'
                    }`}>
                        {r.is_expense ? '-' : '+'}{formatCurrency(r.amount, currency)}
                    </span>
                </div>
                <div className="mt-1 flex items-center justify-between gap-2">
                    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                        <span className="whitespace-nowrap">{categoryLabel(r.category)}</span>
                        <span aria-hidden>·</span>
                        <span className="flex items-center gap-1 whitespace-nowrap">
                            <Calendar className="w-3 h-3" />
                            {r.occurrence_date
                                ? new Date(`${r.occurrence_date}T00:00:00`).toLocaleDateString(intlLocale(), {
                                    month: 'short',
                                    day: 'numeric',
                                })
                                : `${t('budget:recurring.dayPrefix')} ${r.debit_day}`}
                        </span>
                        <span aria-hidden>·</span>
                        <span className="whitespace-nowrap">
                            {t(`budget:recurring.frequency.${r.recurrence_frequency}`)}
                        </span>
                        {nextOccurrence && (
                            <>
                                <span aria-hidden>·</span>
                                <span className="whitespace-nowrap">
                                    {t('budget:recurring.registry.nextOn', {
                                        date: new Date(`${nextOccurrence}T00:00:00`).toLocaleDateString(intlLocale(), {
                                            day: 'numeric',
                                            month: 'short',
                                            year: 'numeric',
                                        }),
                                    })}
                                </span>
                            </>
                        )}
                        {ended && endDate && (
                            <>
                                <span aria-hidden>·</span>
                                <span className="whitespace-nowrap font-medium">
                                    {t('budget:recurring.registry.endedOn', {
                                        date: new Date(`${endDate}T00:00:00`).toLocaleDateString(intlLocale(), {
                                            day: 'numeric',
                                            month: 'short',
                                            year: 'numeric',
                                        }),
                                    })}
                                </span>
                            </>
                        )}
                    </div>
                    {canEdit && (
                        <div className="-mr-1.5 flex flex-shrink-0 items-center">
                            <button
                                onClick={() => onEdit(r)}
                                title={t('common:actions.edit')}
                                aria-label={t('common:actions.edit')}
                                className="flex min-h-11 min-w-11 items-center justify-center rounded-lg hover:bg-surface-2 transition-colors"
                            >
                                <Edit2 className="w-3.5 h-3.5 text-muted-foreground" />
                            </button>
                            <button
                                onClick={() => onDelete(r.series_id ?? r.id)}
                                title={t('common:actions.delete')}
                                aria-label={t('common:actions.delete')}
                                className="flex min-h-11 min-w-11 items-center justify-center rounded-lg hover:bg-danger/10 transition-colors"
                            >
                                <Trash2 className="w-3.5 h-3.5 text-danger/60" />
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};
