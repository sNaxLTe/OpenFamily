import React, { useEffect, useState, useCallback } from 'react';
import { useWebSocketUpdates } from '../hooks/useWebSocketUpdates';
import { api } from '../lib/api';
import { friendlyApiError } from '../lib/friendlyError';
import { useToast } from '../components/ui';
import { useAuth } from '../contexts/AuthContext';
import { formatCurrency } from '../lib/utils';
import {
    Plus, ChevronLeft, ChevronRight, RefreshCw,
    Trash2, Edit2, TrendingUp, TrendingDown, Wallet, Eye,
    AlertTriangle, Lock, FileText, X
} from 'lucide-react';
import KakeiboView from './budget/KakeiboView';
import KakeiboAnnualView from './budget/KakeiboAnnualView';
import AnnualBudgetView from './budget/AnnualBudgetView';
import ReportExplorer from './budget/ReportExplorer';
import PaperlessPicker, { PaperlessPrefill } from './budget/PaperlessPicker';
import { Sheet, Field, CategorySelect, RecurringCard, type RecurringTransaction } from './budget/budgetParts';
import {
    PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip,
    ResponsiveContainer, Legend,
} from 'recharts';
import ChartCard from '../components/app/ChartCard';
import { format, parseISO } from 'date-fns';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { dateLocale } from '../i18n/format';

// ─── Types ────────────────────────────────────────────────────────────────────

interface BudgetEntry {
    id: string;
    category: string;
    amount: number;
    description?: string;
    date: string;
    is_expense: boolean;
    linked_calendar_event_id?: string | null;
    // Feature 13: optional link to a Paperless document (URL derived server-side).
    paperless_document_id?: number | null;
    paperless_url?: string | null;
}

interface Forecast {
    openingBalance: number;
    oneTimeIncome: number;
    oneTimeExpenses: number;
    dueRecurringIncome: number;
    dueRecurringExpenses: number;
    upcomingRecurringIncome: number;
    upcomingRecurringExpenses: number;
    currentBalance: number;
    forecastBalance: number;
}

interface CategoryStat {
    category: string;
    category_total: number;
}

interface BudgetStatistics {
    totalExpenses: number;
    totalIncome: number;
    balance: number;
    byCategory: CategoryStat[];
}

interface MonthlyStat {
    month: number;
    totalExpenses: number;
    totalIncome: number;
    recurringExpenses?: number;
    recurringIncome?: number;
    balance: number;
}

interface BudgetLimit {
    id: string;
    category: string;
    monthly_limit: number;
    month: number;
    year: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CHART_COLORS = [
    '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
    '#ec4899', '#14b8a6', '#f97316', '#6366f1', '#84cc16',
];

const toNumber = (v: unknown): number => {
    if (typeof v === 'number') return v;
    if (typeof v === 'string') { const n = parseFloat(v); return isFinite(n) ? n : 0; }
    return 0;
};

// localStorage can throw (quota exceeded, blocked in private mode…): a failed
// preference write must never break the page.
const safeGetItem = (key: string): string | null => {
    try { return localStorage.getItem(key); } catch { return null; }
};
const safeSetItem = (key: string, value: string): void => {
    try { localStorage.setItem(key, value); } catch { /* non-fatal */ }
};

// ─── Main Component ───────────────────────────────────────────────────────────

const Budget: React.FC = () => {
    const { t } = useTranslation(['budget', 'kakeibo', 'common']);
    const categoryLabel = (v: string) => t(`budget:categories.${v}`, { defaultValue: v });
    const { showToast } = useToast();
    const { user } = useAuth();
    const navigate = useNavigate();
    const currency = user?.currency || 'EUR';
    const canEdit = Boolean(user?.is_owner) || (user?.role ?? '').toLowerCase() !== 'enfant';

    // E1: four tabs — Budget (classic + analytics merged), Récurrents,
    // Kakeibo, Explorateur. Persisted per browser; the old 'classic' and
    // 'analytics' values both land on 'budget'.
    type BudgetMode = 'budget' | 'kakeibo' | 'explorer' | 'recurring';
    const [mode, setMode] = useState<BudgetMode>(() => {
        const saved = safeGetItem('openfamily.budgetMode');
        return saved === 'kakeibo' || saved === 'explorer' || saved === 'recurring'
            ? saved
            : 'budget';
    });
    const switchMode = (next: BudgetMode) => {
        setMode(next);
        safeSetItem('openfamily.budgetMode', next);
    };

    const [currentMonth, setCurrentMonth] = useState(new Date().getMonth() + 1);
    const [currentYear, setCurrentYear] = useState(new Date().getFullYear());

    // Month (default) or year view of the Budget page (feature 1). The choice
    // sticks per browser; the default stays "month".
    type ViewMode = 'month' | 'year';
    const [view, setView] = useState<ViewMode>(() =>
        safeGetItem('openfamily.budgetView') === 'year' ? 'year' : 'month'
    );
    const switchView = (next: ViewMode) => {
        setView(next);
        safeSetItem('openfamily.budgetView', next);
        // The analytics and recurring-registry tabs are month-oriented; the
        // annual view replaces them.
        if (next === 'year') {
            setMode((m) => {
                const nextMode = m === 'recurring' ? 'budget' : m;
                if (nextMode !== m) safeSetItem('openfamily.budgetMode', nextMode);
                return nextMode;
            });
        }
    };
    // In year view, only the annual blocks are shown (the explorer has its own range).
    const showAnnual = view === 'year' && mode !== 'kakeibo' && mode !== 'explorer' && mode !== 'recurring';

    const [forecast, setForecast] = useState<Forecast | null>(null);
    const [recurring, setRecurring] = useState<RecurringTransaction[]>([]);
    // Registry of recurring series ("Récurrents" tab, post-version n°2), loaded
    // only while that tab is open — never a systematic request.
    const [series, setSeries] = useState<RecurringTransaction[]>([]);
    const [seriesLoading, setSeriesLoading] = useState(false);
    const [seriesSearch, setSeriesSearch] = useState('');
    const [seriesCategory, setSeriesCategory] = useState('');
    const [showEndedSeries, setShowEndedSeries] = useState(false);
    const [entries, setEntries] = useState<BudgetEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState(false);

    const [stats, setStats] = useState<BudgetStatistics | null>(null);
    const [monthly, setMonthly] = useState<MonthlyStat[]>([]);
    const [limits, setLimits] = useState<BudgetLimit[]>([]);

    const [sheetTransaction, setSheetTransaction] = useState(false);
    const [sheetLimit, setSheetLimit] = useState(false);
    const [editingRecurring, setEditingRecurring] = useState<RecurringTransaction | null>(null);
    const [editingEntry, setEditingEntry] = useState<BudgetEntry | null>(null);

    const [transactionForm, setTransactionForm] = useState({
        description: '',
        amount: '',
        category: 'Autre',
        date: format(new Date(), 'yyyy-MM-dd'),
        is_expense: true,
        recurrence_frequency: 'none' as 'none' | RecurringTransaction['recurrence_frequency'],
        recurrence_interval: '1',
        recurrence_until: '',
        // Feature 13: Paperless document linked to this one-time entry (null = none).
        paperless_document_id: null as number | null,
    });
    // Feature 13 UI state: is Paperless configured server-side, and the picker sheet.
    const [paperlessAvailable, setPaperlessAvailable] = useState(false);
    const [sheetPaperless, setSheetPaperless] = useState(false);
    const [paperlessTitle, setPaperlessTitle] = useState('');
    const [limitForm, setLimitForm] = useState({ category: 'Alimentation', monthly_limit: '' });
    const [formError, setFormError] = useState('');
    const [transactionAddToCalendar, setTransactionAddToCalendar] = useState(false);

    // Local-date formatting: toISOString() shifts to UTC and can drop the first
    // or last day of the month depending on the user's timezone.
    const startOfMonth = useCallback(() =>
        format(new Date(currentYear, currentMonth - 1, 1), 'yyyy-MM-dd'),
        [currentYear, currentMonth]
    );
    const endOfMonth = useCallback(() =>
        format(new Date(currentYear, currentMonth, 0), 'yyyy-MM-dd'),
        [currentYear, currentMonth]
    );

    const loadAll = useCallback(async () => {
        setLoadError(false);
        try {
            const [forecastRes, recurringRes, entriesRes, statsRes, monthlyRes, limitsRes] = await Promise.all([
                api.get<{ success: boolean; data: Forecast }>(
                    `/api/budget/forecast?month=${currentMonth}&year=${currentYear}&as_of=${format(new Date(), 'yyyy-MM-dd')}`
                ),
                api.get<{ success: boolean; data: RecurringTransaction[] }>(
                    `/api/budget/recurring?month=${currentMonth}&year=${currentYear}`
                ),
                api.get<{ success: boolean; data: BudgetEntry[] }>(
                    `/api/budget/entries?start_date=${startOfMonth()}&end_date=${endOfMonth()}`
                ),
                api.get<{ success: boolean; data: BudgetStatistics }>(
                    `/api/budget/statistics?month=${currentMonth}&year=${currentYear}`
                ),
                api.get<{ success: boolean; data: MonthlyStat[] }>(
                    `/api/budget/statistics/monthly?year=${currentYear}`
                ),
                api.get<{ success: boolean; data: BudgetLimit[] }>(
                    `/api/budget/limits?month=${currentMonth}&year=${currentYear}`
                ),
            ]);
            if (forecastRes.success) setForecast(forecastRes.data);
            if (recurringRes.success) setRecurring(recurringRes.data.map((r) => ({
                ...r,
                amount: toNumber(r.amount),
                debit_day: toNumber(r.debit_day),
                recurrence_interval: toNumber(r.recurrence_interval) || 1,
            })));
            if (entriesRes.success) setEntries(entriesRes.data.map((e) => ({
                ...e,
                amount: toNumber(e.amount),
            })));
            if (statsRes.success) setStats(statsRes.data);
            if (monthlyRes.success) setMonthly(monthlyRes.data);
            if (limitsRes.success) setLimits(limitsRes.data.map((l) => ({ ...l, monthly_limit: toNumber(l.monthly_limit) })));
        } catch (err) {
            console.error('Budget load error', err);
            setLoadError(true);
        } finally {
            setLoading(false);
        }
    }, [currentMonth, currentYear, startOfMonth, endOfMonth]);

    // Feature 13: ask the server once whether Paperless is configured (the
    // endpoint leaks no URL/token); the "Depuis Paperless" button stays hidden
    // otherwise. Only parents get the button, so only they need the status.
    useEffect(() => {
        if (!canEdit) return;
        let cancelled = false;
        api.get<{ success: boolean; data: { configured: boolean } }>('/api/budget/paperless/status')
            .then((r) => { if (!cancelled && r.success) setPaperlessAvailable(Boolean(r.data.configured)); })
            .catch(() => {});
        return () => { cancelled = true; };
    }, [canEdit]);

    // Registry mode of GET /api/budget/recurring (no month/year): one entry per
    // series, with next_occurrence / annual_committed / current_occurrence.
    const loadSeries = useCallback(async () => {
        setSeriesLoading(true);
        try {
            const res = await api.get<{ success: boolean; data: RecurringTransaction[] }>(
                `/api/budget/recurring?as_of=${format(new Date(), 'yyyy-MM-dd')}`
            );
            if (res.success) {
                setSeries(res.data.map((r) => ({
                    ...r,
                    amount: toNumber(r.amount),
                    debit_day: toNumber(r.debit_day),
                    recurrence_interval: toNumber(r.recurrence_interval) || 1,
                    annual_committed: r.annual_committed != null ? toNumber(r.annual_committed) : undefined,
                })));
            }
        } catch (err) {
            console.error('Recurring registry load error', err);
        } finally {
            setSeriesLoading(false);
        }
    }, []);

    // Reload after a local mutation; the registry as well when its tab is open.
    const refreshBudget = useCallback(() => {
        void loadAll();
        if (mode === 'recurring') void loadSeries();
    }, [loadAll, loadSeries, mode]);

    useEffect(() => { void loadAll(); }, [loadAll]);
    // Load the registry only when its tab is opened (or refreshed by a WS push).
    useEffect(() => {
        if (mode === 'recurring') void loadSeries();
    }, [mode, loadSeries]);
    useWebSocketUpdates('budget', refreshBudget);

    const navigateMonth = (dir: -1 | 1) => {
        let m = currentMonth + dir;
        let y = currentYear;
        if (m < 1) { m = 12; y -= 1; }
        if (m > 12) { m = 1; y += 1; }
        setCurrentMonth(m);
        setCurrentYear(y);
    };

    const navigateYear = (dir: -1 | 1) => {
        setCurrentYear((y) => y + dir);
    };

    // Budget reminder ("J-X days") of the recurring series being edited
    // (feature 3, mechanism B). Empty string = no budget reminder.
    const [reminderDays, setReminderDays] = useState('');

    const handleTogglePoint = async (r: RecurringTransaction) => {
        if (!r.occurrence_date) return;

        const newValue = !r.is_pointed;
        setRecurring((prev) => prev.map((x) => {
            const sameOccurrence = x.occurrence_id && r.occurrence_id
                ? x.occurrence_id === r.occurrence_id
                : x.id === r.id && x.occurrence_date === r.occurrence_date;

            return sameOccurrence ? { ...x, is_pointed: newValue } : x;
        }));
        // Registry tab: the card is a series flattened with its current-month
        // occurrence — point the SAME occurrence, updated in place.
        setSeries((prev) => prev.map((x) => {
            const cur = x.current_occurrence;
            return r.occurrence_id && cur && cur.occurrence_id === r.occurrence_id
                ? { ...x, current_occurrence: { ...cur, is_pointed: newValue } }
                : x;
        }));

        try {
            await api.post(`/api/budget/recurring/${r.series_id ?? r.id}/point`, {
                occurrence_date: r.occurrence_date,
                is_pointed: newValue,
            });
        } catch {
            refreshBudget();
        }
    };

    const openNewTransaction = () => {
        setEditingRecurring(null);
        setEditingEntry(null);
        setTransactionAddToCalendar(false);
        setReminderDays('');
        setPaperlessTitle('');
        setTransactionForm({
            description: '',
            amount: '',
            category: 'Autre',
            date: format(new Date(), 'yyyy-MM-dd'),
            is_expense: true,
            recurrence_frequency: 'none',
            recurrence_interval: '1',
            recurrence_until: '',
            paperless_document_id: null,
        });
        setFormError('');
        setSheetTransaction(true);
    };

    const openEditRecurring = (r: RecurringTransaction) => {
        setEditingRecurring(r);
        setEditingEntry(null);
        setTransactionAddToCalendar(Boolean(r.linked_calendar_event_id));
        setReminderDays(r.reminder_days != null ? String(r.reminder_days) : '');
        setTransactionForm({
            description: r.label,
            amount: r.amount.toString(),
            category: r.category,
            date: r.start_date,
            is_expense: r.is_expense,
            recurrence_frequency: r.recurrence_frequency,
            recurrence_interval: r.recurrence_interval.toString(),
            recurrence_until: r.recurrence_until ?? '',
            paperless_document_id: null,
        });
        setFormError('');
        setSheetTransaction(true);
    };

    const openEditEntry = (entry: BudgetEntry) => {
        setEditingRecurring(null);
        setEditingEntry(entry);
        setTransactionAddToCalendar(Boolean(entry.linked_calendar_event_id));
        setPaperlessTitle(entry.paperless_document_id ? `#${entry.paperless_document_id}` : '');
        setTransactionForm({
            description: entry.description || '',
            amount: entry.amount.toString(),
            category: entry.category,
            date: entry.date.split('T')[0],
            is_expense: entry.is_expense,
            recurrence_frequency: 'none',
            recurrence_interval: '1',
            recurrence_until: '',
            paperless_document_id: entry.paperless_document_id ?? null,
        });
        setFormError('');
        setSheetTransaction(true);
    };

    // Feature 13: a Paperless document was picked — prefill amount / date /
    // description (ALL stay editable; category and expense/income direction
    // are NEVER deduced, the user keeps choosing them).
    const handlePaperlessSelect = (prefill: PaperlessPrefill) => {
        setSheetPaperless(false);
        setPaperlessTitle(prefill.title || `#${prefill.document_id}`);
        setTransactionForm((f) => ({
            ...f,
            amount: prefill.suggested_amount != null ? prefill.suggested_amount.toString() : f.amount,
            date: prefill.suggested_date ?? f.date,
            description: f.description || prefill.suggested_description,
            paperless_document_id: prefill.document_id,
        }));
    };

    const handleSaveTransaction = async (e: React.FormEvent) => {
        e.preventDefault();
        setFormError('');

        const amount = parseFloat(transactionForm.amount.replace(',', '.'));
        if (!isFinite(amount) || amount <= 0) {
            setFormError(t('budget:errors.amountInvalid'));
            return;
        }

        if (!transactionForm.date) {
            setFormError(t('budget:errors.startDateRequired'));
            return;
        }

        const isRecurring = transactionForm.recurrence_frequency !== 'none';
        const interval = parseInt(transactionForm.recurrence_interval, 10);

        if (isRecurring && (!Number.isInteger(interval) || interval < 1 || interval > 365)) {
            setFormError(t('budget:errors.intervalInvalid'));
            return;
        }

        if (
            isRecurring &&
            transactionForm.recurrence_until &&
            transactionForm.recurrence_until < transactionForm.date
        ) {
            setFormError(t('budget:errors.repeatUntilInvalid'));
            return;
        }

        // Feature 3, mechanism B: the J-X reminder can be set at creation too
        // — same rule as the server: integer 0-365, empty = none.
        const rawReminder = reminderDays.trim();
        const parsedReminder = rawReminder === '' ? null : parseInt(rawReminder, 10);
        if (
            isRecurring &&
            parsedReminder !== null &&
            (!Number.isInteger(parsedReminder) || parsedReminder < 0 || parsedReminder > 365)
        ) {
            setFormError(t('budget:errors.reminderInvalid'));
            return;
        }

        // Existing one-time and recurring rows stay in their current storage model.
        // New entries can choose either model from the same form.
        if (editingEntry && isRecurring) {
            setFormError(t('budget:errors.editRecurrenceType'));
            return;
        }
        if (editingRecurring && !isRecurring) {
            setFormError(t('budget:errors.editRecurrenceType'));
            return;
        }

        try {
            if (isRecurring) {
                const payload = {
                    label: transactionForm.description.trim() || transactionForm.category,
                    amount,
                    category: transactionForm.category,
                    start_date: transactionForm.date,
                    recurrence_frequency: transactionForm.recurrence_frequency,
                    recurrence_interval: interval,
                    recurrence_until: transactionForm.recurrence_until || null,
                    is_expense: transactionForm.is_expense,
                    add_to_calendar: transactionAddToCalendar,
                    // Accepted at creation since the polish lot (server validates too).
                    reminder_days: parsedReminder,
                };

                if (editingRecurring) {
                    const seriesId = editingRecurring.series_id ?? editingRecurring.id;
                    await api.put(`/api/budget/recurring/${seriesId}`, payload);
                    // Feature 3, mechanism B: the budget reminder "J-X days"
                    // lives on its own endpoint and coexists with the calendar
                    // link (mechanism A). Empty field = reminder cleared.
                    const previousReminder = editingRecurring.reminder_days ?? null;
                    if (
                        parsedReminder !== previousReminder &&
                        (parsedReminder === null ||
                            (Number.isInteger(parsedReminder) && parsedReminder >= 0 && parsedReminder <= 365))
                    ) {
                        await api.put(`/api/budget/recurring/${seriesId}/reminder`, {
                            reminder_days: parsedReminder,
                        });
                    }
                } else {
                    await api.post('/api/budget/recurring', payload);
                }
            } else {
                const payload = {
                    category: transactionForm.category,
                    amount,
                    description: transactionForm.description,
                    date: transactionForm.date,
                    is_expense: transactionForm.is_expense,
                    add_to_calendar: transactionAddToCalendar,
                    // Feature 13: the server derives paperless_url itself.
                    paperless_document_id: transactionForm.paperless_document_id,
                };

                if (editingEntry) {
                    await api.put(`/api/budget/entries/${editingEntry.id}`, payload);
                } else {
                    await api.post('/api/budget/entries', payload);
                }
            }

            setSheetTransaction(false);
            refreshBudget();
            showToast({
                title: isRecurring ? t('budget:toast.recurringSaved') : t('budget:toast.entrySaved'),
                description: !isRecurring && transactionForm.paperless_document_id
                    ? t('budget:toast.paperlessLinked')
                    : undefined,
            });
        } catch (err) {
            setFormError(friendlyApiError(err, t, 'budget:errors.save'));
        }
    };

    const handleDeleteRecurring = async (id: string) => {
        if (!confirm(t('budget:confirm.deleteRecurring'))) return;
        try {
            await api.delete(`/api/budget/recurring/${id}`);
            refreshBudget();
            showToast({ title: t('budget:toast.recurringDeleted') });
        } catch (err) {
            showToast({ title: friendlyApiError(err, t, 'budget:errors.generic') });
        }
    };

    const handleDeleteEntry = async (id: string) => {
        if (!confirm(t('budget:confirm.deleteEntry'))) return;
        try {
            await api.delete(`/api/budget/entries/${id}`);
            refreshBudget();
            showToast({ title: t('budget:toast.entryDeleted') });
        } catch (err) {
            showToast({ title: friendlyApiError(err, t, 'budget:errors.generic') });
        }
    };

    const openLimitSheet = (category?: string) => {
        const existing = category ? limits.find((l) => l.category === category) : undefined;
        setLimitForm({
            category: category || 'Alimentation',
            monthly_limit: existing ? existing.monthly_limit.toString() : '',
        });
        setFormError('');
        setSheetLimit(true);
    };

    const handleSaveLimit = async (e: React.FormEvent) => {
        e.preventDefault();
        setFormError('');
        const limit = parseFloat(limitForm.monthly_limit.replace(',', '.'));
        if (!isFinite(limit) || limit < 0) { setFormError(t('budget:errors.limitInvalid')); return; }
        try {
            await api.post('/api/budget/limits', {
                category: limitForm.category,
                monthly_limit: limit,
                month: currentMonth,
                year: currentYear,
            });
            setSheetLimit(false);
            refreshBudget();
            showToast({ title: t('budget:toast.limitSaved') });
        } catch (err) {
            setFormError(friendlyApiError(err, t, 'budget:errors.save'));
        }
    };

    // Spending per category this month, including recurring expense occurrences.
    const spentByCategory = React.useMemo(() => {
        const map: Record<string, number> = {};
        for (const e of entries) {
            if (e.is_expense) map[e.category] = (map[e.category] || 0) + e.amount;
        }
        for (const r of recurring) {
            if (r.is_expense) map[r.category] = (map[r.category] || 0) + r.amount;
        }
        return map;
    }, [entries, recurring]);

    const limitAlerts = limits
        .map((l) => ({ ...l, spent: spentByCategory[l.category] || 0 }))
        .filter((l) => l.monthly_limit > 0 && l.spent >= l.monthly_limit * 0.8);

    const expenses = entries.filter((e) => e.is_expense);
    const incomes = entries.filter((e) => !e.is_expense);
    const pointedCount = recurring.filter((r) => r.is_pointed).length;

    // Registry tab (post-version n°2): a series is "ended" when inactive or
    // when its recurrence_until is in the past. Default view = active only,
    // sorted by amount descending, with text + category filters.
    const todayStr = format(new Date(), 'yyyy-MM-dd');
    const seriesEnded = (s: RecurringTransaction) =>
        !s.is_active || Boolean(s.recurrence_until && s.recurrence_until < todayStr);
    const activeSeriesCount = series.filter((s) => !seriesEnded(s)).length;
    const committedTotal = series
        .filter((s) => !seriesEnded(s))
        .reduce((sum, s) => sum + (s.annual_committed ?? 0), 0);
    const seriesCategories = Array.from(new Set(series.map((s) => s.category))).sort();
    const visibleSeries = series
        .filter((s) => showEndedSeries || !seriesEnded(s))
        .filter((s) => !seriesCategory || s.category === seriesCategory)
        .filter((s) => {
            const q = seriesSearch.trim().toLowerCase();
            return !q || s.label.toLowerCase().includes(q);
        })
        .sort((a, b) => b.amount - a.amount);

    if (loading) {
        return (
            <div className="flex h-full items-center justify-center min-h-[50vh]" role="status" aria-live="polite">
                <div className="flex flex-col items-center gap-4">
                    <div className="spinner-brand" />
                    <p className="text-muted-foreground font-medium animate-pulse">{t('budget:loading')}</p>
                </div>
            </div>
        );
    }

    if (loadError) {
        return (
            <div className="mx-auto max-w-2xl pb-24 xl:max-w-6xl">
                <div className="m-4 rounded-xl bg-danger/10 border border-danger/20 px-4 py-3 text-sm text-danger" role="alert">
                    {t('budget:errors.load')}
                </div>
            </div>
        );
    }

    const balancePositive = (forecast?.currentBalance ?? 0) >= 0;
    const forecastPositive = (forecast?.forecastBalance ?? 0) >= 0;

    return (
        // One column on a phone. On a wide screen the sections are set in two
        // columns and the page takes the room it is given, instead of a narrow
        // strip down the middle.
        <div className="mx-auto max-w-2xl pb-24 xl:max-w-6xl">

            {/* Navigation mois / année (the explorer picks its own range) */}
            {mode !== 'explorer' && (
            <div className="flex items-center justify-between px-4 py-3 sticky top-0 bg-background/80 backdrop-blur-md z-10 border-b border-border">
                <button
                    onClick={() => (view === 'month' ? navigateMonth(-1) : navigateYear(-1))}
                    aria-label={t('budget:prevMonth')}
                    className="-m-2 p-2 rounded-full hover:bg-surface-2 active:scale-95 transition-all"
                >
                    <ChevronLeft className="w-5 h-5" />
                </button>
                <span className="text-lg font-semibold capitalize">
                    {view === 'month'
                        ? format(new Date(currentYear, currentMonth - 1), 'MMMM yyyy', { locale: dateLocale() })
                        : `${currentYear}`}
                </span>
                <button
                    onClick={() => (view === 'month' ? navigateMonth(1) : navigateYear(1))}
                    aria-label={t('budget:nextMonth')}
                    className="-m-2 p-2 rounded-full hover:bg-surface-2 active:scale-95 transition-all"
                >
                    <ChevronRight className="w-5 h-5" />
                </button>
            </div>
            )}

            {/* Toggle Mois / Année (feature 1 ; default month). Hidden for the
                explorer (own range controls) and the recurring registry (as_of
                is always today). */}
            {mode !== 'explorer' && mode !== 'recurring' && (
            <div className="px-4 pt-3">
                <div className="flex gap-1 rounded-input border border-border bg-surface-2 p-1 max-w-xs">
                    <button
                        type="button"
                        onClick={() => switchView('month')}
                        className={`flex-1 whitespace-nowrap rounded-input px-3 py-1.5 text-sm font-medium transition ${
                            view === 'month' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                        }`}
                    >
                        {t('budget:view.month')}
                    </button>
                    <button
                        type="button"
                        onClick={() => switchView('year')}
                        className={`flex-1 whitespace-nowrap rounded-input px-3 py-1.5 text-sm font-medium transition ${
                            view === 'year' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                        }`}
                    >
                        {t('budget:view.year')}
                    </button>
                </div>
            </div>
            )}

            {/* E1 tab bar: Budget / Récurrents / Kakeibo / Explorateur (4 tabs) */}
            <div className="px-4 pt-4">
                <div className="flex flex-wrap gap-1 rounded-input border border-border bg-surface-2 p-1" role="tablist" aria-label={t('budget:tabs.label')}>
                    <button
                        type="button"
                        role="tab"
                        aria-selected={mode === 'budget'}
                        onClick={() => switchMode('budget')}
                        className={`flex-1 min-h-11 whitespace-nowrap rounded-input px-3 py-1.5 text-sm font-medium transition ${
                            mode === 'budget' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                        }`}
                    >
                        {t('budget:tabs.budget')}
                    </button>
                    <button
                        type="button"
                        role="tab"
                        aria-selected={mode === 'recurring'}
                        onClick={() => switchMode('recurring')}
                        className={`flex-1 min-h-11 whitespace-nowrap rounded-input px-3 py-1.5 text-sm font-medium transition ${
                            mode === 'recurring' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                        }`}
                    >
                        {t('budget:recurringTab')}
                    </button>
                    <button
                        type="button"
                        role="tab"
                        aria-selected={mode === 'kakeibo'}
                        onClick={() => switchMode('kakeibo')}
                        className={`flex-1 min-h-11 whitespace-nowrap rounded-input px-3 py-1.5 text-sm font-medium transition ${
                            mode === 'kakeibo' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                        }`}
                    >
                        {t('kakeibo:mode.kakeibo')}
                    </button>
                    <button
                        type="button"
                        role="tab"
                        aria-selected={mode === 'explorer'}
                        onClick={() => switchMode('explorer')}
                        className={`flex-1 min-h-11 whitespace-nowrap rounded-input px-3 py-1.5 text-sm font-medium transition ${
                            mode === 'explorer' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                        }`}
                    >
                        {t('budget:explorer.tab')}
                    </button>
                </div>
            </div>

            {/* Report explorer (feature 10): read-only, its own range controls */}
            {mode === 'explorer' && (
                <div className="px-4 pt-4">
                    <ReportExplorer currency={currency} categoryLabel={categoryLabel} />
                </div>
            )}

            {/* Recurring series registry (post-version n°2): one card per series —
                active and ended — with next occurrence and pointing of the
                current-month occurrence. Read-only for children, like the rest. */}
            {mode === 'recurring' && (
                <div className="px-4 pt-4 space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs bg-surface-2 text-muted-foreground px-2 py-1 rounded-full">
                            {t('budget:recurring.registry.activeCount', { number: activeSeriesCount })}
                        </span>
                        <span className="text-xs bg-info/10 text-info px-2 py-1 rounded-full font-medium">
                            {t('budget:recurring.registry.committed', { amount: formatCurrency(committedTotal, currency) })}
                        </span>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                        <input
                            type="search"
                            value={seriesSearch}
                            onChange={(e) => setSeriesSearch(e.target.value)}
                            placeholder={t('budget:recurring.registry.searchPlaceholder')}
                            aria-label={t('budget:recurring.registry.searchPlaceholder')}
                            className="min-h-11 min-w-40 flex-1 px-3 rounded-xl border border-border bg-surface-1 text-foreground text-base placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition"
                        />
                        <select
                            value={seriesCategory}
                            onChange={(e) => setSeriesCategory(e.target.value)}
                            aria-label={t('budget:fields.category')}
                            className="min-h-11 px-3 rounded-xl border border-border bg-surface-1 text-foreground text-base focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition"
                        >
                            <option value="">{t('budget:recurring.registry.allCategories')}</option>
                            {seriesCategories.map((c) => (
                                <option key={c} value={c}>{categoryLabel(c)}</option>
                            ))}
                        </select>
                        <button
                            type="button"
                            onClick={() => setShowEndedSeries((v) => !v)}
                            aria-pressed={showEndedSeries}
                            className={`min-h-11 px-3 rounded-xl border text-sm font-medium transition ${
                                showEndedSeries
                                    ? 'bg-card text-foreground border-primary shadow-sm'
                                    : 'bg-surface-1 text-muted-foreground border-border hover:text-foreground'
                            }`}
                        >
                            {t('budget:recurring.registry.showEnded')}
                        </button>
                    </div>

                    {seriesLoading && series.length === 0 ? (
                        <div className="rounded-card border border-dashed border-border p-6 text-center">
                            <p className="text-sm text-muted-foreground">{t('budget:loading')}</p>
                        </div>
                    ) : series.length === 0 ? (
                        <div className="rounded-card border border-dashed border-border p-6 text-center space-y-2">
                            <RefreshCw className="w-8 h-8 text-muted-foreground mx-auto opacity-40" />
                            <p className="text-sm font-medium text-foreground">{t('budget:recurring.registry.emptyTitle')}</p>
                            <p className="text-sm text-muted-foreground">{t('budget:recurring.registry.emptyText')}</p>
                            {canEdit && (
                                <button
                                    type="button"
                                    onClick={openNewTransaction}
                                    className="mt-1 inline-flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-white active:scale-95 transition-transform"
                                >
                                    <Plus className="w-4 h-4" />
                                    {t('common:actions.add')}
                                </button>
                            )}
                        </div>
                    ) : visibleSeries.length === 0 ? (
                        <div className="rounded-card border border-dashed border-border p-6 text-center">
                            <p className="text-sm text-muted-foreground">{t('budget:recurring.registry.noMatch')}</p>
                        </div>
                    ) : (
                        <div className="space-y-2">
                            {visibleSeries.map((s) => {
                                const current = s.current_occurrence ?? null;
                                const flattened: RecurringTransaction = {
                                    ...s,
                                    occurrence_id: current?.occurrence_id,
                                    occurrence_date: current?.occurrence_date,
                                    is_pointed: current?.is_pointed ?? false,
                                    pointed_at: current?.pointed_at ?? null,
                                };
                                return (
                                    <RecurringCard
                                        key={s.id}
                                        r={flattened}
                                        currency={currency}
                                        canEdit={canEdit}
                                        categoryLabel={categoryLabel}
                                        onTogglePoint={handleTogglePoint}
                                        onEdit={openEditRecurring}
                                        onDelete={handleDeleteRecurring}
                                        nextOccurrence={s.next_occurrence}
                                        ended={seriesEnded(s)}
                                        endDate={s.recurrence_until ?? null}
                                    />
                                );
                            })}
                        </div>
                    )}
                </div>
            )}

            {mode === 'kakeibo' && view === 'year' && (
                <div className="px-4 pt-3 xl:mx-auto xl:max-w-3xl">
                    <KakeiboAnnualView
                        year={currentYear}
                        canEdit={canEdit}
                        currency={currency}
                        categoryLabel={categoryLabel}
                    />
                </div>
            )}

            {mode === 'kakeibo' && view === 'month' && (
                <div className="px-4 pt-3 xl:mx-auto xl:max-w-3xl">
                    <KakeiboView
                        month={currentMonth}
                        year={currentYear}
                        canEdit={canEdit}
                        currency={currency}
                        categoryLabel={categoryLabel}
                        reloadKey={entries.length + recurring.length}
                    />
                </div>
            )}

            {/* Annual view of the classic tab (feature 1 + 2 + 4) */}
            {showAnnual && (
                <AnnualBudgetView
                    year={currentYear}
                    currency={currency}
                    canEdit={canEdit}
                    categoryLabel={categoryLabel}
                />
            )}

            {((mode === 'budget' && !showAnnual) || mode === 'recurring') && canEdit && (
                <div className="px-4 pt-4 flex justify-end">
                    <button
                        type="button"
                        onClick={openNewTransaction}
                        className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-white active:scale-95 transition-transform"
                    >
                        <Plus className="w-4 h-4" />
                        {t('common:actions.add')}
                    </button>
                </div>
            )}

            {mode === 'budget' && view === 'month' && !showAnnual && (
                <div className="px-4 pt-4 [&>*]:mb-3 [&>*]:break-inside-avoid xl:columns-2 xl:gap-6">
                            {/* Répartition par catégorie */}
                            <ChartCard
                                title={t('budget:charts.expensesByCategory')}
                                subtitle={format(new Date(currentYear, currentMonth - 1), 'MMMM yyyy', { locale: dateLocale() })}
                            >
                                {stats && stats.byCategory.length > 0 ? (
                                    <ResponsiveContainer width="100%" height={240}>
                                        <PieChart>
                                            <Pie
                                                data={stats.byCategory}
                                                dataKey="category_total"
                                                nameKey="category"
                                                cx="50%"
                                                cy="50%"
                                                outerRadius={80}
                                                label={(e: any) => categoryLabel(e.category)}
                                            >
                                                {stats.byCategory.map((_, i) => (
                                                    <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                                                ))}
                                            </Pie>
                                            <Tooltip formatter={(v: number) => formatCurrency(v, currency)} />
                                        </PieChart>
                                    </ResponsiveContainer>
                                ) : (
                                    <p className="text-sm text-muted-foreground text-center py-8">{t('budget:charts.noExpenses')}</p>
                                )}
                            </ChartCard>

                            {/* Évolution mensuelle */}
                            <ChartCard title={t('budget:charts.yearEvolution')} subtitle={`${currentYear}`}>
                                <ResponsiveContainer width="100%" height={240}>
                                    <BarChart data={monthly.map((m) => ({
                                        month: format(new Date(currentYear, m.month - 1), 'MMM', { locale: dateLocale() }),
                                        expenses: m.totalExpenses,
                                        income: m.totalIncome,
                                    }))}>
                                        <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                                        <YAxis tick={{ fontSize: 11 }} width={40} />
                                        <Tooltip formatter={(v: number) => formatCurrency(v, currency)} />
                                        <Legend wrapperStyle={{ fontSize: 12 }} />
                                        <Bar dataKey="income" name={t('budget:charts.income')} fill="#10b981" radius={[4, 4, 0, 0]} />
                                        <Bar dataKey="expenses" name={t('budget:charts.expenses')} fill="#ef4444" radius={[4, 4, 0, 0]} />
                                    </BarChart>
                                </ResponsiveContainer>
                            </ChartCard>

                            {/* Plafonds par catégorie */}
                            <ChartCard
                                title={t('budget:limits.title')}
                                subtitle={t('budget:limits.subtitle')}
                                action={canEdit ? (
                                    <button
                                        onClick={() => openLimitSheet()}
                                        className="flex shrink-0 items-center gap-1 whitespace-nowrap text-sm font-medium text-primary transition-transform active:scale-95"
                                    >
                                        <Plus className="h-4 w-4 shrink-0" /> {t('budget:limits.define')}
                                    </button>
                                ) : undefined}
                            >
                                {limits.length === 0 ? (
                                    <p className="text-sm text-muted-foreground text-center py-6">
                                        {t('budget:limits.none')}
                                    </p>
                                ) : (
                                    <div className="space-y-3">
                                        {limits.map((l) => {
                                            const spent = spentByCategory[l.category] || 0;
                                            const ratio = l.monthly_limit > 0 ? Math.min(spent / l.monthly_limit, 1) : 0;
                                            const over = spent >= l.monthly_limit && l.monthly_limit > 0;
                                            const warn = ratio >= 0.8 && !over;
                                            return (
                                                <button
                                                    key={l.id}
                                                    onClick={() => canEdit && openLimitSheet(l.category)}
                                                    className="w-full text-left"
                                                    disabled={!canEdit}
                                                >
                                                    <div className="flex items-center justify-between text-sm mb-1">
                                                        <span className="font-medium">{categoryLabel(l.category)}</span>
                                                        <span className={over ? 'text-danger font-semibold' : warn ? 'text-warning' : 'text-muted-foreground'}>
                                                            {formatCurrency(spent, currency)} / {formatCurrency(l.monthly_limit, currency)}
                                                        </span>
                                                    </div>
                                                    <div className="h-2 rounded-full bg-surface-2 overflow-hidden">
                                                        <div
                                                            className={`h-full rounded-full transition-all ${over ? 'bg-danger/100' : warn ? 'bg-warning/100' : 'bg-success/100'}`}
                                                            style={{ width: `${ratio * 100}%` }}
                                                        />
                                                    </div>
                                                </button>
                                            );
                                        })}
                                    </div>
                                )}
                            </ChartCard>
                </div>
            )}

            <div className="px-4 pt-4 [&>*]:mb-3 [&>*]:break-inside-avoid xl:columns-2 xl:gap-6" style={{ display: mode === 'budget' && !showAnnual ? undefined : 'none' }}>

                {/* Bannière lecture seule (enfant) */}
                {!canEdit && (
                    <div className="rounded-card bg-warning/10 border border-warning/30 p-3 flex items-center gap-2">
                        <Lock className="w-4 h-4 text-warning flex-shrink-0" />
                        <p className="text-sm text-warning">
                            {t('budget:readOnly')}
                        </p>
                    </div>
                )}

                {/* Alertes de plafond */}
                {limitAlerts.length > 0 && (
                    <div className="rounded-card bg-danger/10 border border-danger/20 p-3 space-y-1.5">
                        <div className="flex items-center gap-2">
                            <AlertTriangle className="w-4 h-4 text-danger flex-shrink-0" />
                            <p className="text-sm font-medium text-danger">{t('budget:alerts.title')}</p>
                        </div>
                        {limitAlerts.map((l) => (
                            <p key={l.id} className="text-xs text-danger/80 pl-6">
                                {categoryLabel(l.category)} : {formatCurrency(l.spent, currency)} / {formatCurrency(l.monthly_limit, currency)}
                                {l.spent >= l.monthly_limit ? t('budget:alerts.over') : t('budget:alerts.warn')}
                            </p>
                        ))}
                    </div>
                )}


                <div className={`rounded-card p-5 ${balancePositive ? 'bg-success/10' : 'bg-danger/10'}`}>
                    <div className="flex items-center gap-2 mb-1">
                        <Wallet className={`w-4 h-4 ${balancePositive ? 'text-success' : 'text-danger'}`} />
                        <span className="text-sm font-medium text-muted-foreground">{t('budget:balance.current')}</span>
                    </div>
                    <p className={`text-4xl font-bold tracking-tight ${balancePositive ? 'text-success' : 'text-danger'}`}>
                        {formatCurrency(forecast?.currentBalance ?? 0, currency)}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                        {t('budget:balance.opening', {
                            amount: formatCurrency(forecast?.openingBalance ?? 0, currency),
                        })}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                        {t('budget:balance.pointed', { count: pointedCount })}
                        {' '}· {t('budget:balance.expenses', { count: expenses.length })}
                    </p>
                </div>

                {/* Prévisionnel */}
                {forecast && (
                    forecast.upcomingRecurringExpenses > 0 ||
                    forecast.upcomingRecurringIncome > 0
                ) && (
                    <div className={`rounded-card p-4 border-2 ${forecastPositive ? 'border-info/20 bg-info/5' : 'border-peach/20 bg-peach/5'}`}>
                        <div className="flex items-center gap-2 mb-1">
                            <Eye className={`w-4 h-4 ${forecastPositive ? 'text-info' : 'text-peach'}`} />
                            <span className="text-sm font-medium text-muted-foreground">{t('budget:forecast.title')}</span>
                        </div>
                        <p className={`text-3xl font-bold ${forecastPositive ? 'text-info' : 'text-peach'}`}>
                            {formatCurrency(forecast.forecastBalance, currency)}
                        </p>
                        <p className="text-xs text-muted-foreground mt-1">
                            {t('budget:forecast.subtitle', {
                                income: formatCurrency(forecast.upcomingRecurringIncome, currency),
                                expenses: formatCurrency(forecast.upcomingRecurringExpenses, currency),
                            })}
                        </p>
                    </div>
                )}

                {/* Prélèvements récurrents */}
                <section>
                    <div className="flex items-center justify-between mb-2 mt-4">
                        <div className="flex items-center gap-2">
                            <RefreshCw className="w-4 h-4 text-muted-foreground" />
                            <h2 className="font-semibold text-base">{t('budget:sections.recurring')}</h2>
                            {recurring.length > 0 && (
                                <span className="text-xs bg-surface-2 text-muted-foreground px-2 py-0.5 rounded-full">
                                    {pointedCount}/{recurring.length}
                                </span>
                            )}
                        </div>
                    </div>

                    {recurring.length === 0 ? (
                        <div className="rounded-card border border-dashed border-border p-6 text-center">
                            <RefreshCw className="w-8 h-8 text-muted-foreground mx-auto mb-2 opacity-40" />
                            <p className="text-sm text-muted-foreground">{t('budget:recurring.empty')}</p>
                        </div>
                    ) : (
                        <div className="space-y-2">
                            {recurring.map((r) => (
                                <RecurringCard
                                    key={r.occurrence_id ?? `${r.id}:${r.occurrence_date ?? r.debit_day}`}
                                    r={r}
                                    currency={currency}
                                    canEdit={canEdit}
                                    categoryLabel={categoryLabel}
                                    onTogglePoint={handleTogglePoint}
                                    onEdit={openEditRecurring}
                                    onDelete={handleDeleteRecurring}
                                />
                            ))}
                        </div>
                    )}
                </section>

                {/* Dépenses ponctuelles */}
                <section>
                    <div className="flex items-center justify-between mb-2 mt-4">
                        <div className="flex items-center gap-2">
                            <TrendingDown className="w-4 h-4 text-danger" />
                            <h2 className="font-semibold text-base">{t('budget:sections.expenses')}</h2>
                            {expenses.length > 0 && (
                                <span className="text-xs bg-danger/10 text-danger px-2 py-0.5 rounded-full font-medium">
                                    -{formatCurrency(expenses.reduce((s, e) => s + e.amount, 0), currency)}
                                </span>
                            )}
                        </div>
                    </div>

                    {expenses.length === 0 ? (
                        <div className="rounded-card border border-dashed border-border p-5 text-center">
                            <p className="text-sm text-muted-foreground">{t('budget:empty.expenses')}</p>
                        </div>
                    ) : (
                        <div className="space-y-2">
                            {expenses.map((entry) => (
                                <EntryRow
                                    key={entry.id}
                                    entry={entry}
                                    currency={currency}
                                    canEdit={canEdit}
                                    onEdit={openEditEntry}
                                    onDelete={handleDeleteEntry}
                                />
                            ))}
                        </div>
                    )}
                </section>

                {/* Revenus */}
                <section>
                    <div className="flex items-center justify-between mb-2 mt-4">
                        <div className="flex items-center gap-2">
                            <TrendingUp className="w-4 h-4 text-success" />
                            <h2 className="font-semibold text-base">{t('budget:sections.income')}</h2>
                            {incomes.length > 0 && (
                                <span className="text-xs bg-success/10 text-success px-2 py-0.5 rounded-full font-medium">
                                    +{formatCurrency(incomes.reduce((s, e) => s + e.amount, 0), currency)}
                                </span>
                            )}
                        </div>
                    </div>

                    {incomes.length === 0 ? (
                        <div className="rounded-card border border-dashed border-border p-5 text-center">
                            <p className="text-sm text-muted-foreground">{t('budget:empty.income')}</p>
                        </div>
                    ) : (
                        <div className="space-y-2">
                            {incomes.map((entry) => (
                                <EntryRow
                                    key={entry.id}
                                    entry={entry}
                                    currency={currency}
                                    canEdit={canEdit}
                                    onEdit={openEditEntry}
                                    onDelete={handleDeleteEntry}
                                />
                            ))}
                        </div>
                    )}
                </section>

            </div>

            {/* Unified Budget entry sheet */}
            <Sheet
                open={sheetTransaction}
                dismissible={false}
                onClose={() => setSheetTransaction(false)}
                title={
                    editingRecurring || editingEntry
                        ? t('budget:sheets.edit')
                        : t('budget:sheets.new')
                }
            >
                <form onSubmit={handleSaveTransaction} className="space-y-4">
                    {formError && (
                        <div className="rounded-xl bg-danger/10 border border-danger/20 px-3 py-2 text-sm text-danger">
                            {formError}
                        </div>
                    )}

                    <div>
                        <label className="block text-sm font-medium text-foreground mb-1">
                            {t('budget:fields.type')}
                        </label>
                        <div className="flex rounded-xl overflow-hidden border border-border">
                            <button
                                type="button"
                                onClick={() => setTransactionForm((f) => ({ ...f, is_expense: true }))}
                                className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
                                    transactionForm.is_expense
                                        ? 'bg-danger/100 text-white'
                                        : 'bg-surface-1 text-muted-foreground'
                                }`}
                            >
                                {t('budget:toggle.expense')}
                            </button>
                            <button
                                type="button"
                                onClick={() => setTransactionForm((f) => ({ ...f, is_expense: false }))}
                                className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
                                    !transactionForm.is_expense
                                        ? 'bg-success/100 text-white'
                                        : 'bg-surface-1 text-muted-foreground'
                                }`}
                            >
                                {t('budget:toggle.income')}
                            </button>
                        </div>
                    </div>

                    <Field
                        label={t('budget:fields.description')}
                        value={transactionForm.description}
                        onChange={(v) => setTransactionForm((f) => ({ ...f, description: v }))}
                        placeholder={t('budget:fields.descriptionPlaceholder')}
                    />

                    {/* Feature 13: prefill from a Paperless document (one-time entries
                        only; hidden when the server has no Paperless configured) */}
                    {!editingRecurring && paperlessAvailable && (
                        <div className="flex flex-wrap items-center gap-2">
                            <button
                                type="button"
                                onClick={() => setSheetPaperless(true)}
                                className="flex items-center gap-1.5 rounded-xl border border-primary/40 bg-primary/10 px-3 py-2 text-sm font-medium text-primary active:scale-95 transition-transform"
                            >
                                <FileText className="h-4 w-4" />
                                {t('budget:paperless.fromPaperless')}
                            </button>
                            {transactionForm.paperless_document_id !== null && (
                                <span className="flex items-center gap-1 rounded-full bg-surface-2 px-2 py-1 text-xs text-foreground">
                                    <FileText className="h-3 w-3 shrink-0 text-primary" />
                                    <span className="max-w-[10rem] truncate">
                                        {paperlessTitle || `#${transactionForm.paperless_document_id}`}
                                    </span>
                                    <button
                                        type="button"
                                        aria-label={t('budget:paperless.unlink')}
                                        title={t('budget:paperless.unlink')}
                                        onClick={() => {
                                            setTransactionForm((f) => ({ ...f, paperless_document_id: null }));
                                            setPaperlessTitle('');
                                        }}
                                        className="rounded-full -m-3.5 p-3.5 hover:bg-danger/10"
                                    >
                                        <X className="h-3 w-3 text-muted-foreground" />
                                    </button>
                                </span>
                            )}
                        </div>
                    )}

                    <Field
                        label={t('budget:fields.amount', { currency })}
                        type="number"
                        value={transactionForm.amount}
                        onChange={(v) => setTransactionForm((f) => ({ ...f, amount: v }))}
                        placeholder="0.00"
                        step="0.01"
                        min="0.01"
                        required
                    />

                    <CategorySelect
                        value={transactionForm.category}
                        onChange={(v) => setTransactionForm((f) => ({ ...f, category: v }))}
                    />

                    <Field
                        label={
                            transactionForm.recurrence_frequency === 'none'
                                ? t('budget:fields.date')
                                : t('budget:fields.startDate')
                        }
                        type="date"
                        value={transactionForm.date}
                        onChange={(v) => setTransactionForm((f) => ({ ...f, date: v }))}
                        required
                    />

                    <div>
                        <label className="block text-sm font-medium text-foreground mb-1">
                            {t('budget:fields.repeat')}
                        </label>
                        <select
                            value={transactionForm.recurrence_frequency}
                            onChange={(e) => setTransactionForm((f) => ({
                                ...f,
                                recurrence_frequency: e.target.value as typeof f.recurrence_frequency,
                            }))}
                            className="w-full px-3 py-2.5 rounded-xl border border-border bg-surface-1 text-foreground text-base
                                       focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition"
                        >
                            {!editingRecurring && (
                                <option value="none">{t('budget:recurring.frequency.none')}</option>
                            )}
                            {!editingEntry && (
                                <>
                                    <option value="daily">{t('budget:recurring.frequency.daily')}</option>
                                    <option value="weekly">{t('budget:recurring.frequency.weekly')}</option>
                                    <option value="monthly">{t('budget:recurring.frequency.monthly')}</option>
                                    <option value="yearly">{t('budget:recurring.frequency.yearly')}</option>
                                </>
                            )}
                        </select>
                    </div>

                    {transactionForm.recurrence_frequency !== 'none' && (
                        <>
                            <div>
                                <label className="block text-sm font-medium text-foreground mb-1">
                                    {t('budget:fields.every')}
                                </label>
                                <div className="flex items-center gap-3">
                                    <input
                                        type="number"
                                        value={transactionForm.recurrence_interval}
                                        onChange={(e) => setTransactionForm((f) => ({
                                            ...f,
                                            recurrence_interval: e.target.value,
                                        }))}
                                        min="1"
                                        max="365"
                                        step="1"
                                        required
                                        className="w-24 px-3 py-2.5 rounded-xl border border-border bg-surface-1 text-foreground text-base
                                                   focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition"
                                    />
                                    <span className="text-sm text-muted-foreground">
                                        {t(`budget:recurring.units.${transactionForm.recurrence_frequency}`, {
                                            count: parseInt(transactionForm.recurrence_interval, 10) || 1,
                                        })}
                                    </span>
                                </div>
                            </div>

                            <Field
                                label={t('budget:fields.repeatUntil')}
                                type="date"
                                value={transactionForm.recurrence_until}
                                onChange={(v) => setTransactionForm((f) => ({
                                    ...f,
                                    recurrence_until: v,
                                }))}
                                min={transactionForm.date}
                            />
                        </>
                    )}

                    <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-border bg-surface-2/40 p-3">
                        <input
                            type="checkbox"
                            checked={transactionAddToCalendar}
                            onChange={(e) => setTransactionAddToCalendar(e.target.checked)}
                            className="mt-0.5 h-4 w-4 rounded border-border text-primary focus:ring-primary"
                        />
                        <span>
                            <span className="block text-sm font-medium">
                                {t('budget:fields.addToCalendar')}
                            </span>
                            <span className="block text-xs text-muted-foreground">
                                {t('budget:fields.addToCalendarHint')}
                            </span>
                        </span>
                    </label>

                    {/* Rappels de la série récurrente (feature 3) : les deux
                        mécanismes coexistent — A = rappels de l'événement de
                        calendrier lié (case ci-dessus), B = rappel budget J-X. */}
                    {transactionForm.recurrence_frequency !== 'none' && (
                        <div className="space-y-3 rounded-xl border border-border bg-surface-2/40 p-3">
                            <p className="text-sm font-medium">{t('budget:reminders.title')}</p>
                            {editingRecurring?.linked_calendar_event_id && (
                                <p className="text-xs text-muted-foreground">
                                    {t('budget:reminders.calendarLinked')}{' '}
                                    <button
                                        type="button"
                                        onClick={() => { setSheetTransaction(false); navigate('/calendar'); }}
                                        className="text-primary underline"
                                    >
                                        {t('budget:reminders.calendarLink')}
                                    </button>
                                </p>
                            )}
                            <Field
                                label={t('budget:reminders.budgetLabel')}
                                type="number"
                                value={reminderDays}
                                onChange={setReminderDays}
                                placeholder={t('budget:reminders.budgetPlaceholder')}
                                min="0"
                                max="365"
                                step="1"
                            />
                            <p className="text-xs text-muted-foreground">{t('budget:reminders.budgetHint')}</p>
                        </div>
                    )}

                    <div className="flex gap-3 pt-2">
                        <button
                            type="button"
                            onClick={() => setSheetTransaction(false)}
                            className="flex-1 py-3 rounded-xl border border-border text-foreground font-medium active:scale-95 transition-transform"
                        >
                            {t('common:actions.cancel')}
                        </button>
                        <button
                            type="submit"
                            className="flex-1 py-3 rounded-xl bg-primary text-white font-medium active:scale-95 transition-transform"
                        >
                            {editingRecurring || editingEntry
                                ? t('common:actions.save')
                                : t('common:actions.add')}
                        </button>
                    </div>
                </form>
            </Sheet>

            {/* Sheet : sélection d'un document Paperless (feature 13) */}
            <Sheet
                open={sheetPaperless}
                onClose={() => setSheetPaperless(false)}
                title={t('budget:paperless.sheetTitle')}
            >
                <PaperlessPicker onSelect={handlePaperlessSelect} />
            </Sheet>

            {/* Sheet : plafond de catégorie */}
            <Sheet
                open={sheetLimit}
                dismissible={false}
                onClose={() => setSheetLimit(false)}
                title={t('budget:sheets.limit')}
            >
                <form onSubmit={handleSaveLimit} className="space-y-4">
                    {formError && (
                        <div className="rounded-xl bg-danger/10 border border-danger/20 px-3 py-2 text-sm text-danger">
                            {formError}
                        </div>
                    )}
                    <CategorySelect
                        value={limitForm.category}
                        onChange={(v) => setLimitForm((f) => ({ ...f, category: v }))}
                    />
                    <Field
                        label={t('budget:fields.limit', { currency })}
                        type="number"
                        value={limitForm.monthly_limit}
                        onChange={(v) => setLimitForm((f) => ({ ...f, monthly_limit: v }))}
                        placeholder="0.00"
                        step="0.01"
                        min="0"
                        required
                    />
                    <p className="text-xs text-muted-foreground">
                        {t('budget:fields.limitHint')}
                    </p>
                    <div className="flex gap-3 pt-2">
                        <button
                            type="button"
                            onClick={() => setSheetLimit(false)}
                            className="flex-1 py-3 rounded-xl border border-border text-foreground font-medium active:scale-95 transition-transform"
                        >
                            {t('common:actions.cancel')}
                        </button>
                        <button
                            type="submit"
                            className="flex-1 py-3 rounded-xl bg-primary text-white font-medium active:scale-95 transition-transform"
                        >
                            {t('common:actions.save')}
                        </button>
                    </div>
                </form>
            </Sheet>

        </div>
    );
};

// ─── Entry Row ────────────────────────────────────────────────────────────────

const EntryRow: React.FC<{
    entry: BudgetEntry;
    currency: string;
    canEdit?: boolean;
    onEdit: (e: BudgetEntry) => void;
    onDelete: (id: string) => void;
}> = ({ entry, currency, canEdit = true, onEdit, onDelete }) => {
    const { t } = useTranslation('budget');
    const categoryLabel = (v: string) => t(`categories.${v}`, { defaultValue: v });
    // parseISO treats date-only strings ("yyyy-MM-dd") as local midnight,
    // avoiding the previous-day shift that new Date() (UTC midnight) causes.
    const dateStr = format(parseISO(entry.date), 'dd MMM', { locale: dateLocale() });
    return (
        <div className="flex items-center gap-3 bg-surface-1 border border-border rounded-card p-3.5 shadow-sm">
            <div className="flex-1 min-w-0">
                <p className="font-medium text-base truncate">
                    {entry.description || categoryLabel(entry.category)}
                </p>
                {/* On a narrow phone the date goes under the category, both whole. */}
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2">
                    {entry.description && (
                        <>
                            <span className="whitespace-nowrap text-xs text-muted-foreground">{categoryLabel(entry.category)}</span>
                            <span className="text-xs text-muted-foreground">·</span>
                        </>
                    )}
                    <span className="whitespace-nowrap text-xs text-muted-foreground">{dateStr}</span>
                </div>
            </div>
            <span className={`text-base font-bold flex-shrink-0 ${entry.is_expense ? 'text-danger' : 'text-success'}`}>
                {entry.is_expense ? '-' : '+'}{formatCurrency(entry.amount, currency)}
            </span>
            {/* Feature 13: 📄 badge on Paperless-linked entries — opens the
                document (URL stored server-side) in a new tab */}
            {entry.paperless_url && (
                <a
                    href={entry.paperless_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={t('budget:paperless.openDocument')}
                    aria-label={t('budget:paperless.openDocument')}
                    // Tap zone widened to ~46 px by a pseudo-element so the
                    // badge itself does not grow visually (44 px target).
                    className="relative flex-shrink-0 rounded-full bg-primary/10 p-1.5 text-primary transition-colors after:absolute after:-inset-2.5 after:content-[''] hover:bg-primary/20"
                >
                    <FileText className="w-3.5 h-3.5" />
                </a>
            )}
            {canEdit && (
                <div className="flex items-center gap-1 flex-shrink-0">
                    <button
                        onClick={() => onEdit(entry)}
                        aria-label={t('common:actions.edit')}
                        className="-m-3 p-3 rounded-lg hover:bg-surface-2 transition-colors"
                    >
                        <Edit2 className="w-3.5 h-3.5 text-muted-foreground" />
                    </button>
                    <button
                        onClick={() => onDelete(entry.id)}
                        aria-label={t('common:actions.delete')}
                        className="-m-3 p-3 rounded-lg hover:bg-danger/10 transition-colors"
                    >
                        <Trash2 className="w-3.5 h-3.5 text-danger/60" />
                    </button>
                </div>
            )}
        </div>
    );
};

export default Budget;
