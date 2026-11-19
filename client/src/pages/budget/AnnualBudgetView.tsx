import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { format } from 'date-fns';
import {
    BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import {
    AlertTriangle, CalendarClock, LineChart as LineChartIcon, PiggyBank, Plus, RefreshCw, Trash2,
    TrendingDown, TrendingUp, Wallet,
} from 'lucide-react';
import { api } from '../../lib/api';
import { formatCurrency } from '../../lib/utils';
import { dateLocale, intlLocale } from '../../i18n/format';
import { useWebSocketUpdates } from '../../hooks/useWebSocketUpdates';
import ChartCard from '../../components/app/ChartCard';
import { CategorySelect, Field, Sheet } from './budgetParts';
import ForecastCard from './ForecastCard';

// Annual view of the classic Budget tab (feature 1): year recap, 12-month
// chart with the recurring / one-off split, the annual recurring block
// (feature 2, read-only) and the annual category limits (feature 4).
// Data: /api/budget/statistics/annual, /statistics/monthly,
// /recurring/schedule, /entries (whole year), /limits/annual.

interface AnnualStats {
    year: number;
    totalIncome: number;
    totalExpenses: number;
    balance: number;
    savingsRate: number;
    monthlyAverage: number;
    bestMonth: { month: number; balance: number } | null;
    worstMonth: { month: number; balance: number } | null;
    previousYear: { totalIncome: number; totalExpenses: number; balance: number };
}

interface MonthlyStat {
    month: number;
    totalExpenses: number;
    totalIncome: number;
    recurringExpenses?: number;
    recurringIncome?: number;
    balance: number;
}

interface ScheduleOccurrence {
    series_id: string;
    occurrence_id: string;
    occurrence_date: string;
    label: string;
    amount: number;
    category: string;
    is_expense: boolean;
    recurrence_frequency: string;
    reminder_days?: number | null;
    linked_calendar_event_id?: string | null;
}

interface YearEntry {
    id: string;
    category: string;
    amount: number;
    date: string;
    is_expense: boolean;
}

interface AnnualLimit {
    id: string;
    category: string;
    monthly_limit: number;
    month: number | null;
    year: number;
}

const toNumber = (v: unknown): number => {
    if (typeof v === 'number') return v;
    if (typeof v === 'string') { const n = parseFloat(v); return isFinite(n) ? n : 0; }
    return 0;
};

interface Props {
    year: number;
    currency: string;
    canEdit: boolean;
    categoryLabel: (v: string) => string;
}

const AnnualBudgetView: React.FC<Props> = ({ year, currency, canEdit, categoryLabel }) => {
    const { t } = useTranslation(['budget', 'common']);
    const [annual, setAnnual] = useState<AnnualStats | null>(null);
    const [monthly, setMonthly] = useState<MonthlyStat[]>([]);
    const [schedule, setSchedule] = useState<ScheduleOccurrence[]>([]);
    const [yearEntries, setYearEntries] = useState<YearEntry[]>([]);
    const [annualLimits, setAnnualLimits] = useState<AnnualLimit[]>([]);
    const [loading, setLoading] = useState(true);

    const [filterCategory, setFilterCategory] = useState('');
    const [filterType, setFilterType] = useState<'all' | 'expense' | 'income'>('all');

    const [sheetLimit, setSheetLimit] = useState(false);
    const [limitForm, setLimitForm] = useState({ category: 'Alimentation', annual_limit: '' });
    const [formError, setFormError] = useState('');

    // Feature 11: the projection card is only mounted while this toggle is on,
    // so /api/budget/forecast is never requested while it is closed.
    const [showForecast, setShowForecast] = useState(false);

    const yearStart = `${year}-01-01`;
    const yearEnd = `${year}-12-31`;

    const load = useCallback(async () => {
        try {
            const [annualRes, monthlyRes, scheduleRes, entriesRes, limitsRes] = await Promise.all([
                api.get<{ success: boolean; data: AnnualStats }>(`/api/budget/statistics/annual?year=${year}`),
                api.get<{ success: boolean; data: MonthlyStat[] }>(`/api/budget/statistics/monthly?year=${year}`),
                api.get<{ success: boolean; data: ScheduleOccurrence[] }>(
                    `/api/budget/recurring/schedule?start_date=${yearStart}&end_date=${yearEnd}`
                ),
                api.get<{ success: boolean; data: YearEntry[] }>(
                    `/api/budget/entries?start_date=${yearStart}&end_date=${yearEnd}`
                ),
                api.get<{ success: boolean; data: AnnualLimit[] }>(`/api/budget/limits/annual?year=${year}`),
            ]);
            if (annualRes.success) setAnnual(annualRes.data);
            if (monthlyRes.success) setMonthly(monthlyRes.data);
            if (scheduleRes.success) {
                setSchedule(scheduleRes.data.map((o) => ({ ...o, amount: toNumber(o.amount) })));
            }
            if (entriesRes.success) {
                setYearEntries(entriesRes.data.map((e) => ({ ...e, amount: toNumber(e.amount) })));
            }
            if (limitsRes.success) {
                setAnnualLimits(limitsRes.data.map((l) => ({ ...l, monthly_limit: toNumber(l.monthly_limit) })));
            }
        } catch (err) {
            console.error('Annual budget load error', err);
        } finally {
            setLoading(false);
        }
    }, [year, yearStart, yearEnd]);

    useEffect(() => { setLoading(true); void load(); }, [load]);
    useWebSocketUpdates('budget', () => { void load(); });

    const cur = (v: number) => formatCurrency(v, currency);
    const monthName = (m: number) => format(new Date(year, m - 1), 'MMMM', { locale: dateLocale() });
    const monthShort = (m: number) => format(new Date(year, m - 1), 'MMM', { locale: dateLocale() });
    const today = format(new Date(), 'yyyy-MM-dd');

    // 12-month chart data: expenses split recurring / one-off, income separate.
    const chartData = useMemo(() => monthly.map((m) => ({
        month: monthShort(m.month),
        income: m.totalIncome,
        recurring: m.recurringExpenses ?? 0,
        oneOff: Math.max(m.totalExpenses - (m.recurringExpenses ?? 0), 0),
    })), [monthly, year]);

    // Recurring annual block (feature 2, read-only).
    const seriesCount = useMemo(() => new Set(schedule.map((o) => o.series_id)).size, [schedule]);
    const annualCommitted = useMemo(
        () => schedule.filter((o) => o.is_expense).reduce((s, o) => s + o.amount, 0),
        [schedule]
    );
    const upcoming = useMemo(
        () => schedule.filter((o) => o.occurrence_date >= today),
        [schedule, today]
    );
    const nextDue = upcoming[0] ?? null;
    const nextTen = upcoming.slice(0, 10);

    const scheduleCategories = useMemo(
        () => [...new Set(schedule.map((o) => o.category))].sort(),
        [schedule]
    );
    const filteredSchedule = useMemo(
        () => schedule.filter((o) =>
            (filterCategory === '' || o.category === filterCategory) &&
            (filterType === 'all' || (filterType === 'expense') === o.is_expense)
        ),
        [schedule, filterCategory, filterType]
    );
    const groupedByMonth = useMemo(() => {
        const groups = new Map<string, ScheduleOccurrence[]>();
        for (const o of filteredSchedule) {
            const key = o.occurrence_date.slice(0, 7);
            const list = groups.get(key) ?? [];
            list.push(o);
            groups.set(key, list);
        }
        return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
    }, [filteredSchedule]);

    // Annual spending per category = one-off entries + recurring occurrences
    // of the year (feature 4 progression).
    const spentByCategoryYear = useMemo(() => {
        const map: Record<string, number> = {};
        for (const e of yearEntries) {
            if (e.is_expense) map[e.category] = (map[e.category] || 0) + e.amount;
        }
        for (const o of schedule) {
            if (o.is_expense) map[o.category] = (map[o.category] || 0) + o.amount;
        }
        return map;
    }, [yearEntries, schedule]);

    const openLimitSheet = (limit?: AnnualLimit) => {
        setLimitForm({
            category: limit?.category ?? 'Alimentation',
            annual_limit: limit ? limit.monthly_limit.toString() : '',
        });
        setFormError('');
        setSheetLimit(true);
    };

    const handleSaveLimit = async (e: React.FormEvent) => {
        e.preventDefault();
        setFormError('');
        const limit = parseFloat(limitForm.annual_limit.replace(',', '.'));
        if (!isFinite(limit) || limit < 0) {
            setFormError(t('budget:errors.limitInvalid'));
            return;
        }
        try {
            await api.put('/api/budget/limits/annual', {
                category: limitForm.category,
                annual_limit: limit,
                year,
            });
            setSheetLimit(false);
            void load();
        } catch (err) {
            setFormError(err instanceof Error ? err.message : t('budget:errors.save'));
        }
    };

    const handleDeleteLimit = async (id: string) => {
        if (!confirm(t('budget:annual.limits.deleteConfirm'))) return;
        try {
            await api.delete(`/api/budget/limits/annual/${id}`);
            void load();
        } catch { /* ignore */ }
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center py-16">
                <div className="spinner-brand" />
            </div>
        );
    }

    const hasData = annual !== null && (annual.totalIncome !== 0 || annual.totalExpenses !== 0);
    const prevDelta = annual ? annual.balance - annual.previousYear.balance : 0;

    const recapItems: Array<{ label: string; value: string; icon: React.ReactNode; tone: string }> = annual ? [
        { label: t('budget:annual.recap.income'), value: cur(annual.totalIncome), icon: <TrendingUp className="w-4 h-4 text-success" />, tone: 'text-foreground' },
        { label: t('budget:annual.recap.expenses'), value: cur(annual.totalExpenses), icon: <TrendingDown className="w-4 h-4 text-danger" />, tone: 'text-foreground' },
        { label: t('budget:annual.recap.balance'), value: cur(annual.balance), icon: <Wallet className={`w-4 h-4 ${annual.balance >= 0 ? 'text-success' : 'text-danger'}`} />, tone: annual.balance >= 0 ? 'text-success' : 'text-danger' },
        { label: t('budget:annual.recap.savingsRate'), value: `${Math.round(annual.savingsRate * 100)} %`, icon: <PiggyBank className="w-4 h-4 text-primary" />, tone: 'text-foreground' },
        { label: t('budget:annual.recap.monthlyAverage'), value: cur(annual.monthlyAverage), icon: <Wallet className="w-4 h-4 text-muted-foreground" />, tone: 'text-foreground' },
        { label: t('budget:annual.recap.bestMonth'), value: annual.bestMonth ? `${monthName(annual.bestMonth.month)} · ${cur(annual.bestMonth.balance)}` : '—', icon: <TrendingUp className="w-4 h-4 text-success" />, tone: 'text-success' },
        { label: t('budget:annual.recap.worstMonth'), value: annual.worstMonth ? `${monthName(annual.worstMonth.month)} · ${cur(annual.worstMonth.balance)}` : '—', icon: <TrendingDown className="w-4 h-4 text-danger" />, tone: 'text-danger' },
        {
            label: t('budget:annual.recap.vsPrevious', { year: year - 1 }),
            value: `${prevDelta >= 0 ? '+' : ''}${cur(prevDelta)}`,
            icon: prevDelta >= 0 ? <TrendingUp className="w-4 h-4 text-success" /> : <TrendingDown className="w-4 h-4 text-danger" />,
            tone: prevDelta >= 0 ? 'text-success' : 'text-danger',
        },
    ] : [];

    return (
        <div className="px-4 pt-4 [&>*]:mb-3 [&>*]:break-inside-avoid xl:columns-2 xl:gap-6">

            {!hasData && (
                <p className="rounded-card border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
                    {t('budget:annual.noData', { year })}
                </p>
            )}

            {/* ── Recap cards ─────────────────────────────────────────────── */}
            {annual && (
                <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
                    {recapItems.map((item) => (
                        <div key={item.label} className="rounded-card border border-border bg-card p-4">
                            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                {item.icon}
                                <span className="truncate">{item.label}</span>
                            </div>
                            <p className={`mt-1 truncate text-lg font-bold ${item.tone}`}>{item.value}</p>
                        </div>
                    ))}
                </div>
            )}

            {/* ── 12-month chart, recurring / one-off split ───────────────── */}
            <ChartCard
                title={t('budget:annual.chartTitle', { year })}
                subtitle={`${year}`}
                action={(
                    <button
                        onClick={() => setShowForecast((v) => !v)}
                        aria-pressed={showForecast}
                        className={`flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
                            showForecast
                                ? 'border-primary bg-primary/10 text-primary'
                                : 'border-border text-muted-foreground hover:text-foreground'
                        }`}
                    >
                        <LineChartIcon className="h-3.5 w-3.5 shrink-0" />
                        {t('budget:annual.forecast.toggle')}
                    </button>
                )}
            >
                {chartData.some((m) => m.income !== 0 || m.recurring !== 0 || m.oneOff !== 0) ? (
                    <ResponsiveContainer width="100%" height={260}>
                        <BarChart data={chartData}>
                            <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                            <YAxis tick={{ fontSize: 11 }} width={40} />
                            <Tooltip formatter={(v: number) => cur(v)} />
                            <Legend wrapperStyle={{ fontSize: 12 }} />
                            <Bar dataKey="income" name={t('budget:annual.chartIncome')} fill="#10b981" radius={[4, 4, 0, 0]} />
                            <Bar dataKey="recurring" name={t('budget:annual.chartRecurring')} stackId="expenses" fill="#ef4444" />
                            <Bar dataKey="oneOff" name={t('budget:annual.chartOneOff')} stackId="expenses" fill="#f59e0b" radius={[4, 4, 0, 0]} />
                        </BarChart>
                    </ResponsiveContainer>
                ) : (
                    <p className="py-8 text-center text-sm text-muted-foreground">{t('budget:annual.noData', { year })}</p>
                )}
            </ChartCard>

            {/* ── Projection card (feature 11, read-only) ─────────────────── */}
            {showForecast && (
                <ForecastCard year={year} currency={currency} monthly={monthly} />
            )}

            {/* ── Recurring annual block (feature 2, read-only) ───────────── */}
            <section>
                <div className="mb-2 mt-4 flex flex-wrap items-center gap-2">
                    <div className="flex items-center gap-2">
                        <RefreshCw className="w-4 h-4 text-muted-foreground" />
                        <h2 className="text-base font-semibold">{t('budget:annual.recurring.title', { year })}</h2>
                    </div>
                    <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted-foreground">
                        {t('budget:annual.recurring.seriesCount', { count: seriesCount })}
                    </span>
                    <span className="rounded-full bg-danger/10 px-2 py-0.5 text-xs font-medium text-danger">
                        {t('budget:annual.recurring.committed', { amount: cur(annualCommitted) })}
                    </span>
                </div>

                {nextDue && (
                    <div className="rounded-card border border-info/20 bg-info/5 p-4">
                        <div className="flex items-center gap-2">
                            <CalendarClock className="w-4 h-4 text-info" />
                            <span className="text-sm font-medium text-muted-foreground">{t('budget:annual.recurring.nextDue')}</span>
                        </div>
                        <div className="mt-1 flex items-center justify-between gap-3">
                            <p className="min-w-0 flex-1 truncate text-base font-medium">
                                {nextDue.label} · {categoryLabel(nextDue.category)}
                            </p>
                            <span className={`whitespace-nowrap text-base font-bold ${nextDue.is_expense ? 'text-danger' : 'text-success'}`}>
                                {nextDue.is_expense ? '-' : '+'}{cur(nextDue.amount)}
                            </span>
                        </div>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                            {new Date(`${nextDue.occurrence_date}T00:00:00`).toLocaleDateString(intlLocale(), {
                                weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
                            })}
                        </p>
                    </div>
                )}

                {nextTen.length > 0 && (
                    <div className="rounded-card border border-border bg-card p-4">
                        <h3 className="text-sm font-semibold text-foreground">{t('budget:annual.recurring.nextTen')}</h3>
                        <div className="mt-2 space-y-1.5">
                            {nextTen.map((o) => (
                                <div key={o.occurrence_id} className="flex items-center gap-2 text-sm">
                                    <span className="w-16 shrink-0 whitespace-nowrap text-xs text-muted-foreground">
                                        {new Date(`${o.occurrence_date}T00:00:00`).toLocaleDateString(intlLocale(), { day: 'numeric', month: 'short' })}
                                    </span>
                                    <span className="min-w-0 flex-1 truncate text-foreground">{o.label}</span>
                                    <span className={`shrink-0 font-medium ${o.is_expense ? 'text-danger' : 'text-success'}`}>
                                        {o.is_expense ? '-' : '+'}{cur(o.amount)}
                                    </span>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* Full schedule grouped by month, with filters */}
                <div className="rounded-card border border-border bg-card p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <h3 className="text-sm font-semibold text-foreground">{t('budget:annual.recurring.schedule', { year })}</h3>
                        <div className="flex gap-2">
                            <select
                                value={filterCategory}
                                onChange={(e) => setFilterCategory(e.target.value)}
                                className="rounded-input border border-border bg-surface-1 px-2 py-1 text-xs text-foreground"
                                aria-label={t('budget:annual.recurring.filterCategory')}
                            >
                                <option value="">{t('budget:annual.recurring.allCategories')}</option>
                                {scheduleCategories.map((c) => (
                                    <option key={c} value={c}>{categoryLabel(c)}</option>
                                ))}
                            </select>
                            <select
                                value={filterType}
                                onChange={(e) => setFilterType(e.target.value as typeof filterType)}
                                className="rounded-input border border-border bg-surface-1 px-2 py-1 text-xs text-foreground"
                                aria-label={t('budget:annual.recurring.filterType')}
                            >
                                <option value="all">{t('budget:annual.recurring.all')}</option>
                                <option value="expense">{t('budget:annual.recurring.expenses')}</option>
                                <option value="income">{t('budget:annual.recurring.incomes')}</option>
                            </select>
                        </div>
                    </div>

                    {groupedByMonth.length === 0 ? (
                        <p className="py-4 text-center text-sm text-muted-foreground">{t('budget:annual.recurring.empty')}</p>
                    ) : (
                        <div className="mt-3 space-y-3">
                            {groupedByMonth.map(([monthKey, occurrences]) => (
                                <div key={monthKey}>
                                    <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                        {format(new Date(`${monthKey}-02T00:00:00`), 'MMMM yyyy', { locale: dateLocale() })}
                                    </p>
                                    <div className="space-y-1">
                                        {occurrences.map((o) => (
                                            <div key={o.occurrence_id} className="flex items-center gap-2 rounded-lg bg-surface-1 px-2.5 py-1.5 text-sm">
                                                <span className="w-8 shrink-0 text-center text-xs text-muted-foreground">
                                                    {Number(o.occurrence_date.slice(8, 10))}
                                                </span>
                                                <span className="min-w-0 flex-1 truncate text-foreground">{o.label}</span>
                                                <span className="shrink-0 text-xs text-muted-foreground">{categoryLabel(o.category)}</span>
                                                <span className={`shrink-0 font-medium ${o.is_expense ? 'text-danger' : 'text-success'}`}>
                                                    {o.is_expense ? '-' : '+'}{cur(o.amount)}
                                                </span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </section>

            {/* ── Annual limits (feature 4) ───────────────────────────────── */}
            <ChartCard
                title={t('budget:annual.limits.title')}
                subtitle={t('budget:annual.limits.subtitle')}
                action={canEdit ? (
                    <button
                        onClick={() => openLimitSheet()}
                        className="flex shrink-0 items-center gap-1 whitespace-nowrap text-sm font-medium text-primary transition-transform active:scale-95"
                    >
                        <Plus className="h-4 w-4 shrink-0" /> {t('budget:annual.limits.define')}
                    </button>
                ) : undefined}
            >
                {annualLimits.length === 0 ? (
                    <p className="py-6 text-center text-sm text-muted-foreground">{t('budget:annual.limits.none')}</p>
                ) : (
                    <div className="space-y-3">
                        {annualLimits.map((l) => {
                            const spent = spentByCategoryYear[l.category] || 0;
                            const ratio = l.monthly_limit > 0 ? Math.min(spent / l.monthly_limit, 1) : 0;
                            const over = l.monthly_limit > 0 && spent >= l.monthly_limit;
                            const warn = !over && ratio >= 0.8;
                            return (
                                <div key={l.id} className="w-full text-left">
                                    <div className="mb-1 flex items-center justify-between gap-2 text-sm">
                                        <button
                                            onClick={() => canEdit && openLimitSheet(l)}
                                            disabled={!canEdit}
                                            className="min-w-0 flex-1 truncate text-left font-medium disabled:cursor-default"
                                        >
                                            {categoryLabel(l.category)}
                                        </button>
                                        <span className={`shrink-0 ${over ? 'font-semibold text-danger' : warn ? 'text-warning' : 'text-muted-foreground'}`}>
                                            {cur(spent)} / {cur(l.monthly_limit)}
                                            {warn && <AlertTriangle className="ml-1 inline h-3.5 w-3.5 text-warning" />}
                                        </span>
                                        {canEdit && (
                                            <button
                                                onClick={() => void handleDeleteLimit(l.id)}
                                                title={t('budget:annual.limits.delete')}
                                                aria-label={t('budget:annual.limits.delete')}
                                                className="shrink-0 rounded-lg p-1 hover:bg-danger/10 transition-colors"
                                            >
                                                <Trash2 className="h-3.5 w-3.5 text-danger/60" />
                                            </button>
                                        )}
                                    </div>
                                    <div className="h-2 overflow-hidden rounded-full bg-surface-2">
                                        <div
                                            className={`h-full rounded-full transition-all ${over ? 'bg-danger/100' : warn ? 'bg-warning/100' : 'bg-success/100'}`}
                                            style={{ width: `${ratio * 100}%` }}
                                        />
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </ChartCard>

            {/* Sheet : plafond annuel */}
            <Sheet
                open={sheetLimit}
                onClose={() => setSheetLimit(false)}
                title={t('budget:annual.limits.sheet')}
            >
                <form onSubmit={handleSaveLimit} className="space-y-4">
                    {formError && (
                        <div className="rounded-xl border border-danger/20 bg-danger/10 px-3 py-2 text-sm text-danger">
                            {formError}
                        </div>
                    )}
                    <CategorySelect
                        value={limitForm.category}
                        onChange={(v) => setLimitForm((f) => ({ ...f, category: v }))}
                    />
                    <Field
                        label={t('budget:annual.limits.field', { currency })}
                        type="number"
                        value={limitForm.annual_limit}
                        onChange={(v) => setLimitForm((f) => ({ ...f, annual_limit: v }))}
                        placeholder="0.00"
                        step="0.01"
                        min="0"
                        required
                    />
                    <p className="text-xs text-muted-foreground">
                        {t('budget:annual.limits.hint', { year })}
                    </p>
                    <div className="flex gap-3 pt-2">
                        <button
                            type="button"
                            onClick={() => setSheetLimit(false)}
                            className="flex-1 rounded-xl border border-border py-3 font-medium text-foreground transition-transform active:scale-95"
                        >
                            {t('common:actions.cancel')}
                        </button>
                        <button
                            type="submit"
                            className="flex-1 rounded-xl bg-primary py-3 font-medium text-white transition-transform active:scale-95"
                        >
                            {t('common:actions.save')}
                        </button>
                    </div>
                </form>
            </Sheet>

        </div>
    );
};

export default AnnualBudgetView;
