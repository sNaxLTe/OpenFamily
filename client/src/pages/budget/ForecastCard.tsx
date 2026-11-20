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
// Chart: the X domain is its OWN sliding window — from the reference month
// (as_of) through as_of + horizon months inclusive — so a horizon that spills
// over the civil year extends the axis into the next year(s) (horizon 24 from
// November covers up to the following October). Bars: the realized anchor
// month (same colors/categories as the annual chart) and the projected months
// (recurring + estimated one-off, lighter). Dashed line on the right axis:
// the projected cumulative balance, anchored on the opening balance at the
// end of the reference month. The summary below always covers the full horizon.

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

// SVG presentation attributes do not resolve CSS var() in Safari, so theme
// colors used inside charts are resolved to a concrete rgb() at render time
// (the app re-renders on theme change, so the resolved value stays current).
const cssVarColor = (name: string, fallback: string): string => {
    if (typeof document === 'undefined') return fallback;
    const triplet = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return triplet ? `rgb(${triplet})` : fallback;
};

interface Props {
    year: number;
    currency: string;
    monthly: MonthlyStat[];
}

// Free-text while editing: the clamp applies on blur/validation only, so a
// partial keystroke never jumps the value to the max. Empty or invalid input
// falls back to the LAST VALID value on blur, never to the max.
const parseFreeInt = (raw: string): number | null => {
    if (raw.trim() === '') return null;
    const n = parseInt(raw, 10);
    return Number.isInteger(n) ? n : null;
};

const ForecastCard: React.FC<Props> = ({ year, currency, monthly }) => {
    const { t } = useTranslation(['budget', 'common']);
    const [months, setMonths] = useState(6);
    const [monthsText, setMonthsText] = useState('6');
    const [variableMonths, setVariableMonths] = useState(6);
    const [variableText, setVariableText] = useState('6');
    const [data, setData] = useState<ForecastData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);

    const cur = (v: number) => formatCurrency(v, currency);
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

    const asOfMonthLabel = data
        ? format(new Date(`${data.as_of}T00:00:00`), 'MMMM yyyy', { locale: dateLocale() })
        : '';

    // Sliding X window: [as_of month .. as_of + horizon], 'MMM yy' labels so
    // the year rollover is visible. Anchor row = the reference month with its
    // realized bars (when the displayed year is the as_of year) and the opening
    // balance as the line anchor; then one row per projected month.
    const rows = useMemo(() => {
        if (!data) return [];
        const [asY, asM] = data.as_of.slice(0, 7).split('-').map(Number);
        const label = (y: number, m: number) =>
            format(new Date(y, m - 1, 1), 'MMM yy', { locale: dateLocale() });

        const anchorStat = year === asY ? monthly.find((m) => m.month === asM) : undefined;
        const anchorRecurring = anchorStat?.recurringExpenses ?? 0;
        const out = [{
            month: label(asY, asM),
            income: anchorStat?.totalIncome ?? 0,
            recurring: anchorStat ? anchorRecurring : 0,
            oneOff: anchorStat ? Math.max(anchorStat.totalExpenses - anchorRecurring, 0) : 0,
            pIncome: 0,
            pRecurring: 0,
            pVariable: 0,
            cumulative: data.opening_balance as number | null,
        }];
        for (const m of data.months) {
            const [y, mo] = m.month.split('-').map(Number);
            out.push({
                month: label(y, mo),
                income: 0,
                recurring: 0,
                oneOff: 0,
                pIncome: m.projected_income,
                pRecurring: m.recurring_expenses,
                pVariable: m.estimated_variable,
                cumulative: m.cumulative_balance as number | null,
            });
        }
        return out;
    }, [data, monthly, year]);

    // Summary over the FULL horizon.
    const summary = useMemo(() => {
        if (!data || data.months.length === 0) return null;
        const last = data.months[data.months.length - 1];
        const committed = data.months.reduce((s, m) => s + m.recurring_expenses, 0);
        const delta = last.cumulative_balance - data.opening_balance;
        return { projected: last.cumulative_balance, committed, delta };
    }, [data]);

    // While editing, keep the text free and only move the numeric value when
    // the keystrokes form a valid in-range integer (the fetch follows it).
    const onIntChange = (
        raw: string, min: number, max: number,
        setText: (s: string) => void, setNum: (n: number) => void
    ) => {
        setText(raw);
        const n = parseFreeInt(raw);
        if (n !== null && n >= min && n <= max) setNum(n);
    };
    // On blur, clamp into range; empty/invalid falls back to the last valid value.
    const onIntBlur = (
        raw: string, min: number, max: number, current: number,
        setText: (s: string) => void, setNum: (n: number) => void
    ) => {
        const n = parseFreeInt(raw);
        const v = n === null ? current : Math.min(max, Math.max(min, n));
        setNum(v);
        setText(String(v));
    };

    // min-h-11: 44 px touch target on the number inputs (iPhone-first).
    const inputCls = 'w-16 min-h-11 rounded-input border border-border bg-surface-1 px-2 py-1 text-xs text-foreground';
    // Resolved theme colors for the SVG (Safari does not resolve var() in SVG
    // presentation attributes — the grid used to render invisible there).
    const borderStroke = cssVarColor('--border', '#e7dccc');
    const infoStroke = cssVarColor('--info', '#7a5270');

    return (
        <ChartCard
            title={t('budget:annual.forecast.title')}
            subtitle={t('budget:annual.forecast.subtitle', { asOfMonth: asOfMonthLabel || '—' })}
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
                        value={monthsText}
                        onChange={(e) => onIntChange(e.target.value, 1, 24, setMonthsText, setMonths)}
                        onBlur={(e) => onIntBlur(e.target.value, 1, 24, months, setMonthsText, setMonths)}
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
                        value={variableText}
                        onChange={(e) => onIntChange(e.target.value, 0, 36, setVariableText, setVariableMonths)}
                        onBlur={(e) => onIntBlur(e.target.value, 0, 36, variableMonths, setVariableText, setVariableMonths)}
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
                            <CartesianGrid strokeDasharray="3 3" stroke={borderStroke} />
                            {/* Sliding window up to horizon+1 labels: minTickGap hides the
                                ones that would overlap at 390 px, keep first/last visible. */}
                            <XAxis dataKey="month" tick={{ fontSize: 11 }} interval="preserveStartEnd" minTickGap={24} />
                            <YAxis yAxisId="left" tick={{ fontSize: 11 }} width={40} />
                            <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11 }} width={48} />
                            <Tooltip
                                formatter={(v: number, name: string) => [cur(toNumber(v)), name]}
                            />
                            {/* Condensed legend: small icons + 11 px labels, wraps on 2 lines max */}
                            <Legend iconSize={10} wrapperStyle={{ fontSize: 11, paddingTop: 6 }} />
                            {/* Realized anchor (same colors/categories as the annual chart) */}
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
                                stroke={infoStroke}
                                strokeWidth={2}
                                strokeDasharray="6 4"
                                dot={false}
                                connectNulls
                            />
                        </ComposedChart>
                    </ResponsiveContainer>
                    </ChartErrorBoundary>

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
