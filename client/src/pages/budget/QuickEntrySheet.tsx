import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { format } from 'date-fns';
import { ChevronDown } from 'lucide-react';
import { api } from '../../lib/api';
import { friendlyApiError } from '../../lib/friendlyError';
import { useToast } from '../../components/ui';
import { mostFrequentCategory } from '../../lib/budgetHero';
import { CategorySelect, Field, Sheet } from './budgetParts';

// E3 — quick entry sheet opened by /budget?new=1: 4 fields (amount with a
// decimal keyboard right away, category defaulting to the user's most
// frequent one, today's date, save). "Plus d'options" hands the draft over
// to the full transaction sheet. Same POST /api/budget/entries, same
// validation; non-dismissible like every editing overlay (lot B1).

interface Props {
    open: boolean;
    onClose: () => void;
    currency: string;
    onSaved: () => void;
    onMoreOptions: (draft: { amount: string; category: string; date: string }) => void;
}

const QuickEntrySheet: React.FC<Props> = ({ open, onClose, currency, onSaved, onMoreOptions }) => {
    const { t } = useTranslation(['budget', 'common']);
    const { showToast } = useToast();
    const [amount, setAmount] = useState('');
    const [category, setCategory] = useState('Autre');
    const [date, setDate] = useState(() => format(new Date(), 'yyyy-MM-dd'));
    const [error, setError] = useState('');
    const [saving, setSaving] = useState(false);
    const amountRef = useRef<HTMLInputElement>(null);

    // Reset + default category on every open. The default is the most frequent
    // expense category of the WHOLE history: GET /api/budget/entries without a
    // range returns all entries (existing endpoint, no new one).
    useEffect(() => {
        if (!open) return;
        setAmount('');
        setCategory('Autre');
        setDate(format(new Date(), 'yyyy-MM-dd'));
        setError('');
        setSaving(false);
        let cancelled = false;
        api.get<{ success: boolean; data: { category: string; is_expense?: boolean }[] }>('/api/budget/entries')
            .then((r) => {
                if (!cancelled && r.success) setCategory(mostFrequentCategory(r.data, 'Autre'));
            })
            .catch(() => { /* keep fallback */ });
        return () => { cancelled = true; };
    }, [open]);

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        const value = parseFloat(amount.replace(',', '.'));
        if (!isFinite(value) || value <= 0) {
            setError(t('budget:errors.amountInvalid'));
            return;
        }
        if (!date) {
            setError(t('budget:errors.startDateRequired'));
            return;
        }
        setSaving(true);
        try {
            // Same endpoint + payload shape as the full form's one-time branch.
            await api.post('/api/budget/entries', {
                category,
                amount: value,
                description: '',
                date,
                is_expense: true,
                add_to_calendar: false,
                paperless_document_id: null,
            });
            showToast({ title: t('budget:toast.entrySaved') });
            onSaved();
            onClose();
        } catch (err) {
            setError(friendlyApiError(err, t, 'budget:errors.save'));
            setSaving(false);
        }
    };

    return (
        <Sheet
            open={open}
            onClose={onClose}
            dismissible={false}
            title={t('budget:quick.title')}
            focusRef={amountRef}
        >
            <form onSubmit={submit} className="space-y-4">
                {error && (
                    <div role="alert" className="rounded-xl bg-danger/10 border border-danger/20 px-3 py-2 text-sm text-danger">
                        {error}
                    </div>
                )}

                {/* Montant : clavier décimal dès l'ouverture, virgule acceptée */}
                <div>
                    <label htmlFor="quick-amount" className="block text-sm font-medium text-foreground mb-1">
                        {t('budget:fields.amount', { currency })}
                    </label>
                    <input
                        id="quick-amount"
                        ref={amountRef}
                        type="text"
                        inputMode="decimal"
                        autoComplete="off"
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                        placeholder="0.00"
                        required
                        aria-required="true"
                        className="w-full px-3 py-2.5 rounded-xl border border-border bg-surface-1 text-foreground text-2xl font-semibold
                                   focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition"
                    />
                </div>

                <CategorySelect value={category} onChange={setCategory} />

                <Field
                    label={t('budget:fields.date')}
                    type="date"
                    value={date}
                    onChange={setDate}
                    required
                />

                <button
                    type="submit"
                    disabled={saving}
                    className="w-full rounded-xl bg-primary py-3 font-medium text-white transition-transform active:scale-95 disabled:opacity-50 min-h-11"
                >
                    {t('common:actions.save')}
                </button>

                {/* Plus d'options, replié par défaut : bascule vers le formulaire
                    complet (note, récurrent, Paperless…) avec le brouillon repris */}
                <details className="group rounded-xl border border-border bg-surface-2/40">
                    <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1.5 px-3 py-2.5 text-sm font-medium text-muted-foreground [&::-webkit-details-marker]:hidden">
                        <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" aria-hidden="true" />
                        {t('budget:quick.moreOptions')}
                    </summary>
                    <div className="px-3 pb-3">
                        <button
                            type="button"
                            onClick={() => onMoreOptions({ amount, category, date })}
                            className="min-h-11 w-full rounded-xl border border-border bg-card px-3 text-sm font-medium text-foreground transition-transform active:scale-95"
                        >
                            {t('budget:quick.openFullForm')}
                        </button>
                    </div>
                </details>
            </form>
        </Sheet>
    );
};

export default QuickEntrySheet;
