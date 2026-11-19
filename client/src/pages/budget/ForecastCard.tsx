import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { format } from 'date-fns';
import {
    ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, CartesianGrid,
} from 'recharts';
import { TrendingDown, TrendingUp, LineChart as LineChartIcon } from 'lucide-react';
import { api } from '../../lib/api';
import { formatCurrency } from '../../lib/utils';
import { dateLocale } from '../../i18n/format';
import ChartCard from '../../components/app/ChartCard';
import ChartErrorBoundary from '../../components/app/ChartErrorBoundary';

// Projection card (feature 11) of the annual Budget view: consumes
// GET /api/budget/forecast?months=N&variable_months=M&as_of=YYYY-MM-DD.
// The card is mounted only when the "Projection" toggle is on, so no request
// is made while it is closed. Read-only: every account of the family (children
// included) may open it, like the statistics.
//
// Chart: realized bars for the months of the displayed year up to the
// reference month (same colors/categories as the annual chart), projected
// bars (recurring + estimated one-off) for the horizon months that fall
// inside the displayed year, and a dashed cumulative-balance line on the
// right axis. The summary below always covers the full requested horizon.

interface ForecastMonth {
    month: string; // 'YYYY-MM'
    recurring_expenses: number;
    recurring_income: number;
    estimated_variable: number;
    estimated_variable_income: number;
    projected_expenses: number;
    projected_income: number;
    monthly_balance: number;
    cumulative_balance: number;
}

interface ForecastData {
    generated_at: string;
    as_of: string; // 'YYYY-MM-DD', the client's local today sent as as_of
    horizon: number;
    variable_months: number;
    opening_balance: number;
    months: ForecastMonth[];
}

interface MonthlyStat {
    month: number;
    totalExpenses: number;
    totalIncome: number;
    recurringExpenses?: number;
    balance: number;
}

const toNumber = (v: unknown): number => {
    if (typeof v === 'number') return v;
    if (typeof v === 'string') { const n = parseFloat(v); return isFinite(n) ? n : 0; }
    return 0;
};

interface Props {
    year: number;
    currency: string;
    monthly: MonthlyStat[];
}

const pad2 = (n: number) => String(n).padStart(2, '0');

const ForecastCard: React.FC<Props> = ({ year, currency, monthly }) => {
    const { t } = useTranslation(['budget', 'common']);
    const [months, setMonths] = useState(6);
    const [variableMonths, setVariableMonths] = useState(6);
    const [data, setData] = useState<ForecastData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);

    const cur = (v: number) => formatCurrency(v, currency);
    const monthShort = (m: number) => format(new Date(year, m - 1), 'MMM', { locale: dateLocale() });
    // The client sends its local "today" so the reference month follows the
    // family's clocks, not the server's (same convention as /forecast month mode).
    const asOfParam = format(new Date(), 'yyyy-MM-dd');

    const load = useCallback(async () => {
        setLoading(true);
        setError(false);
        try {
            const res = await api.get<{ success: boolean; data: ForecastData }>(
                `/api/budget/forecast?months=${months}&variable_months=${variableMonths}&as_of=${asOfParam}`
            );
            if (res.success) {
                setData({
                    ...res.data,
                    opening_balance: toNumber(res.data.opening_balance),
                    months: res.data.months.map((m) => ({
                        ...m,
                        recurring_expenses: toNumber(m.recurring_expenses),
                        recurring_income: toNumber(m.recurring_income),
                        estimated_variable: toNumber(m.estimated_variable),
                        estimated_variable_income: toNumber(m.estimated_variable_income),
                        projected_expenses: toNumber(m.projected_expenses),
                        projected_income: toNumber(m.projected_income),
                        monthly_balance: toNumber(m.monthly_balance),
                        cumulative_balance: toNumber(m.cumulative_balance),
                    })),
                });
            } else {
                setError(true);
            }
        } catch {
            setError(true);
        } finally {
            setLoading(false);
        }
    }, [months, variableMonths, asOfParam]);

    // Load on mount (the card only exists while the toggle is on) and whenever
    // a control changes — no full page reload, just this card's request.
    useEffect(() => {
        const handle = setTimeout(() => { void load(); }, 250);
        return () => clearTimeout(handle);
    }, [load]);

    const asOfMonthKey = data?.as_of.slice(0, 7) ?? '';
    const asOfMonthLabel = data
        ? format(new Date(`${data.as_of}T00:00:00`), 'MMMM yyyy', { locale: dateLocale() })
        : '';

    // Horizon months indexed by 'YYYY-MM' (clamped to the displayed year below).
    const projectedByMonth = useMemo(() => {
        const map = new Map<string, ForecastMonth>();
        for (const m of data?.months ?? []) map.set(m.month, m);
        return map;
    }, [data]);

    // One row per month of the displayed year: realized bars up to the
    // reference month, projected bars for the horizon months of this year,
    // cumulative line anchored on the reference month and over the horizon.
    const rows = useMemo(() => {
        const asOfYear = Number(asOfMonthKey.slice(0, 4));
        return monthly.map((m) => {
            const key = `${year}-${pad2(m.month)}`;
            const realized = asOfMonthKey === ''
                ? false
                : (year < asOfYear || (year === asOfYear && key <= asOfMonthKey));
            const proj = projectedByMonth.get(key);
            const recurring = m.recurringExpenses ?? 0;
            return {
                month: monthShort(m.month),
                income: realized ? m.totalIncome : 0,
                recurring: realized ? recurring : 0,
                oneOff: realized ? Math.max(m.totalExpenses - recurring, 0) : 0,
                pIncome: proj ? proj.projected_income : 0,
                pRecurring: proj ? proj.recurring_expenses : 0,
                pVariable: proj ? proj.estimated_variable : 0,
                // Anchor the line at the end of the reference month.
                cumulative: proj ? proj.cumulative_balance
                    : (realized && key === asOfMonthKey && data ? data.opening_balance : null),
            };
        });
    }, [monthly, year, projectedByMonth, asOfMonthKey, data]);

    const hasProjected = rows.some((r) => r.pIncome !== 0 || r.pRecurring !== 0 || r.pVariable !== 0 || r.cumulative !== null);

    // Summary over the FULL horizon (not clamped to the displayed year).
    const summary = useMemo(() => {
        if (!data || data.months.length === 0) return null;
        const last = data.months[data.months.length - 1];
        const committed = data.months.reduce((s, m) => s + m.recurring_expenses, 0);
        const delta = last.cumulative_balance - data.opening_balance;
        return { projected: last.cumulative_balance, committed, delta };
    }, [data]);

    const clampInt = (v: string, min: number, max: number, fallback: number) => {
        const n = parseInt(v, 10);
        if (!isFinite(n)) return fallback;
        return Math.min(max, Math.max(min, n));
    };

    const inputCls = 'w-16 rounded-input border border-border bg-surface-1 px-2 py-1 text-xs text-foreground';

    return (
        <ChartCard
            title={t('budget:annual.forecast.title')}
            subtitle={t('budget:annual.forecast.subtitle', { year, asOfMonth: asOfMonthLabel || '—' })}
            action={<LineChartIcon className="h-4 w-4 shrink-0 text-primary" />}
        >
            {/* Controls: horizon, estimate window, reference month */}
            <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
                <label className="flex items-center gap-1.5">
                    <span>{t('budget:annual.forecast.horizon')}</span>
                    <input
                        type="number"
                        min={1}
                        max={24}
                        value={months}
                        onChange={(e) => setMonths(clampInt(e.target.value, 1, 24, 6))}
                        className={inputCls}
                        aria-label={t('budget:annual.forecast.horizon')}
                    />
                </label>
                <label className="flex items-center gap-1.5">
                    <span>{t('budget:annual.forecast.variableWindow')}</span>
                    <input
                        type="number"
                        min={0}
                        max={36}
                        value={variableMonths}
                        onChange={(e) => setVariableMonths(clampInt(e.target.value, 0, 36, 6))}
                        className={inputCls}
                        aria-label={t('budget:annual.forecast.variableWindow')}
                    />
                </label>
                {data && (
                    <span className="rounded-full bg-surface-2 px-2 py-0.5">
                        {t('budget:annual.forecast.asOf', { month: asOfMonthLabel })}
                    </span>
                )}
            </div>

            {/* Assumptions banner */}
            <p className="mb-3 rounded-lg border border-info/20 bg-info/5 px-3 py-2 text-xs text-muted-foreground">
                {t('budget:annual.forecast.assumptions', {
                    variableMonths: data?.variable_months ?? variableMonths,
                    asOfMonth: asOfMonthLabel || '—',
                })}
            </p>

            {loading ? (
                <div className="flex items-center justify-center py-10">
                    <div className="spinner-brand" />
                    <span className="ml-2 text-sm text-muted-foreground">{t('budget:annual.forecast.loading')}</span>
                </div>
            ) : error || !data ? (
                <p className="py-8 text-center text-sm text-muted-foreground">{t('budget:annual.forecast.error')}</p>
            ) : (
                <>
                    <ChartErrorBoundary>
                    <ResponsiveContainer width="100%" height={280}>
                        <ComposedChart data={rows}>
                            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                            <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                            <YAxis yAxisId="left" tick={{ fontSize: 11 }} width={40} />
                            <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11 }} width={48} />
                            <Tooltip
                                formatter={(v: number, name: string) => [cur(toNumber(v)), name]}
                            />
                            <Legend wrapperStyle={{ fontSize: 12 }} />
                            {/* Realized (same colors/categories as the annual chart) */}
                            <Bar yAxisId="left" dataKey="income" name={t('budget:annual.chartIncome')} fill="#10b981" radius={[4, 4, 0, 0]} />
                            <Bar yAxisId="left" dataKey="recurring" name={t('budget:annual.chartRecurring')} stackId="exp" fill="#ef4444" />
                            <Bar yAxisId="left" dataKey="oneOff" name={t('budget:annual.chartOneOff')} stackId="exp" fill="#f59e0b" radius={[4, 4, 0, 0]} />
                            {/* Projected: same categories, lighter */}
                            <Bar yAxisId="left" dataKey="pIncome" name={t('budget:annual.forecast.chartProjectedIncome')} fill="#10b981" opacity={0.45} radius={[4, 4, 0, 0]} />
                            <Bar yAxisId="left" dataKey="pRecurring" name={t('budget:annual.forecast.chartProjectedRecurring')} stackId="pexp" fill="#ef4444" opacity={0.45} />
                            <Bar yAxisId="left" dataKey="pVariable" name={t('budget:annual.forecast.chartProjectedVariable')} stackId="pexp" fill="#f59e0b" opacity={0.45} radius={[4, 4, 0, 0]} />
                            {/* Cumulative balance, dashed, right axis */}
                            <Line
                                yAxisId="right"
                                type="monotone"
                                dataKey="cumulative"
                                name={t('budget:annual.forecast.chartCumulative')}
                                stroke="#6366f1"
                                strokeWidth={2}
                                strokeDasharray="6 4"
                                dot={false}
                                connectNulls
                            />
                        </ComposedChart>
                    </ResponsiveContainer>
                    </ChartErrorBoundary>

                    {!hasProjected && (
                        <p className="mt-2 text-center text-xs text-muted-foreground">
                            {t('budget:annual.forecast.subtitle', { year, asOfMonth: asOfMonthLabel })}
                        </p>
                    )}

                    {/* Summary over the full horizon */}
                    {summary && (
                        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
                            <div className="rounded-card border border-border bg-surface-1 p-3">
                                <p className="text-xs text-muted-foreground">{t('budget:annual.forecast.summaryProjected')}</p>
                                <p className={`mt-0.5 text-base font-bold ${summary.projected >= 0 ? 'text-success' : 'text-danger'}`}>
                                    {cur(summary.projected)}
                                </p>
                            </div>
                            <div className="rounded-card border border-border bg-surface-1 p-3">
                                <p className="text-xs text-muted-foreground">{t('budget:annual.forecast.summaryCommitted')}</p>
                                <p className="mt-0.5 text-base font-bold text-danger">-{cur(summary.committed)}</p>
                            </div>
                            <div className="rounded-card border border-border bg-surface-1 p-3">
                                <p className="text-xs text-muted-foreground">{t('budget:annual.forecast.summaryDelta')}</p>
                                <p className={`mt-0.5 flex items-center gap-1 text-base font-bold ${summary.delta >= 0 ? 'text-success' : 'text-danger'}`}>
                                    {summary.delta >= 0
                                        ? <TrendingUp className="h-4 w-4" />
                                        : <TrendingDown className="h-4 w-4" />}
                                    {summary.delta >= 0 ? '+' : ''}{cur(summary.delta)}
                                </p>
                            </div>
                        </div>
                    )}
                </>
            )}
        </ChartCard>
    );
};

export default ForecastCard;
