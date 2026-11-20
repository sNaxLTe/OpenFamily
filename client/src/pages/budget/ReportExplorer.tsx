import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { format } from 'date-fns';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, Cell } from 'recharts';
import { Bookmark, Trash2, BarChart3, Table2 } from 'lucide-react';
import { api } from '../../lib/api';
import { friendlyApiError } from '../../lib/friendlyError';
import { useAuth } from '../../contexts/AuthContext';
import { useCategories } from '../../hooks/useCategories';
import { cn, formatCurrency } from '../../lib/utils';
import { dateLocale } from '../../i18n/format';
import ChartCard from '../../components/app/ChartCard';
import ChartErrorBoundary from '../../components/app/ChartErrorBoundary';
import { Card, CardContent, Select } from '../../components/ui';

// ─── Feature 10 UI: the "Explorateur" tab of the Budget module ──────────────
// A read-only ad-hoc report over GET /api/budget/report: range (preset or
// fixed dates), type, split, recurring toggle and optional category/member
// filters. Results as a ChartCard (bars) or a table, plus a summary. Saved
// configurations live in localStorage per account — zero migration.

type RangePreset = 'this_year' | 'last_12_months' | 'last_year' | 'custom';
type ReportType = 'expenses' | 'income' | 'net';
type Split = 'month' | 'category' | 'member';

interface ReportConfig {
    preset: RangePreset;
    startDate: string;
    endDate: string;
    type: ReportType;
    split: Split;
    includeRecurring: boolean;
    categories: string[];
    members: string[];
}

interface ReportRow {
    key: string | null;
    label: string | null;
    total: number;
    count: number;
    average: number;
    recurring_total: number;
}

interface ReportData {
    range: { preset: string; start_date: string; end_date: string };
    params: { type: ReportType; split: Split; include_recurring: boolean; categories: string[]; members: string[] };
    summary: { total: number; count: number; average: number; recurring_total: number };
    rows: ReportRow[];
}

interface SavedPreset {
    name: string;
    config: ReportConfig;
}

interface FamilyMember {
    id: string;
    name: string;
    color: string;
}

const CHART_COLORS = [
    '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
    '#ec4899', '#14b8a6', '#f97316', '#6366f1', '#84cc16',
];

// Bar colours per report type: recurring strong, one-off light.
const TYPE_COLORS: Record<ReportType, { recurring: string; oneOff: string }> = {
    expenses: { recurring: '#dc2626', oneOff: '#fca5a5' },
    income: { recurring: '#059669', oneOff: '#6ee7b7' },
    net: { recurring: '#2563eb', oneOff: '#93c5fd' },
};

const DEFAULT_CONFIG = (): ReportConfig => ({
    preset: 'this_year',
    startDate: format(new Date(new Date().getFullYear(), 0, 1), 'yyyy-MM-dd'),
    endDate: format(new Date(), 'yyyy-MM-dd'),
    type: 'expenses',
    split: 'month',
    includeRecurring: true,
    categories: [],
    members: [],
});

// The same pill switch as the kiosk settings and the bottom bar card.
const Switch: React.FC<{ checked: boolean; onChange: () => void; label: string }> = ({ checked, onChange, label }) => (
    <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={onChange}
        className={cn(
            'relative h-7 w-12 shrink-0 rounded-full transition-colors',
            checked ? 'bg-primary' : 'border border-border bg-surface-2'
        )}
    >
        <span className={cn(
            'absolute top-1 h-5 w-5 rounded-full bg-white shadow transition-all',
            checked ? 'left-6' : 'left-1'
        )} />
    </button>
);

// min-h-11: 44 px touch target on selects/inputs (iPhone-first).
const selectCls = 'min-h-11 rounded-input border border-border bg-surface-1 px-2 py-1.5 text-xs text-foreground';

interface ReportExplorerProps {
    currency: string;
    categoryLabel: (v: string) => string;
}

const ReportExplorer: React.FC<ReportExplorerProps> = ({ currency, categoryLabel }) => {
    const { t } = useTranslation(['budget', 'common']);
    const { user } = useAuth();
    const { categories: familyCategories } = useCategories();
    const budgetCategories = familyCategories.budget;

    const [config, setConfig] = useState<ReportConfig>(DEFAULT_CONFIG);
    const [data, setData] = useState<ReportData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [showTable, setShowTable] = useState(false);
    const [members, setMembers] = useState<FamilyMember[]>([]);

    // Saved report configurations, per account, on this device (v1: no table).
    const presetsKey = `openfamily.reportPresets.${user?.id ?? 'anon'}`;
    const [savedPresets, setSavedPresets] = useState<SavedPreset[]>(() => {
        try {
            const raw = JSON.parse(localStorage.getItem(presetsKey) ?? '[]');
            return Array.isArray(raw) ? raw.filter((p) => p && typeof p.name === 'string' && p.config) : [];
        } catch {
            return [];
        }
    });
    const [selectedPreset, setSelectedPreset] = useState('');
    const [naming, setNaming] = useState(false);
    const [presetName, setPresetName] = useState('');

    const persistPresets = (next: SavedPreset[]) => {
        setSavedPresets(next);
        try {
            localStorage.setItem(presetsKey, JSON.stringify(next));
        } catch {
            // Storage refused (private window): the presets last for this visit.
        }
    };

    useEffect(() => {
        let cancelled = false;
        api.get<{ success: boolean; data: FamilyMember[] }>('/api/family')
            .then((r) => { if (!cancelled && r.success) setMembers(r.data); })
            .catch(() => {});
        return () => { cancelled = true; };
    }, []);

    // The report itself: refetched on every config change.
    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setError('');
        const q = new URLSearchParams();
        q.set('range_preset', config.preset);
        if (config.preset === 'custom') {
            q.set('start_date', config.startDate);
            q.set('end_date', config.endDate);
        }
        // The client's local "today" resolves the presets the way the user sees them.
        q.set('as_of', format(new Date(), 'yyyy-MM-dd'));
        q.set('type', config.type);
        q.set('split', config.split);
        q.set('include_recurring', String(config.includeRecurring));
        if (config.categories.length > 0) q.set('categories', config.categories.join(','));
        if (config.members.length > 0) q.set('members', config.members.join(','));

        api.get<{ success: boolean; data: ReportData; error?: string }>(`/api/budget/report?${q.toString()}`)
            .then((r) => {
                if (cancelled) return;
                if (r.success) setData(r.data);
                else setError(friendlyApiError(r.error ? new Error(r.error) : null, t, 'budget:explorer.results.error'));
            })
            .catch(() => { if (!cancelled) setError(t('budget:explorer.results.error')); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [config]);

    const set = (patch: Partial<ReportConfig>) => {
        setSelectedPreset('');
        setConfig((c) => ({ ...c, ...patch }));
    };

    // Changing the split resets the view to the chart and (via the key on the
    // chart below) remounts it: recharts keeps internal state between renders,
    // and switching a mounted BarChart between layouts crashes the whole render
    // tree (blank page). A fresh mount per split mode avoids that entirely.
    const setSplit = (split: Split) => {
        setSelectedPreset('');
        setShowTable(false);
        setConfig((c) => (c.split === split ? c : { ...c, split }));
    };

    const toggleInList = (list: string[], value: string) =>
        list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

    const saveCurrent = () => {
        const name = presetName.trim();
        if (!name) return;
        const next = [...savedPresets.filter((p) => p.name !== name), { name, config }];
        persistPresets(next);
        setSelectedPreset(name);
        setPresetName('');
        setNaming(false);
    };

    const applyPreset = (name: string) => {
        const found = savedPresets.find((p) => p.name === name);
        if (!found) return;
        setSelectedPreset(name);
        setConfig(found.config);
    };

    const deletePreset = () => {
        if (!selectedPreset) return;
        persistPresets(savedPresets.filter((p) => p.name !== selectedPreset));
        setSelectedPreset('');
    };

    // Rows are named with the split the DATA was computed with
    // (data.params.split), not the split currently selected in the control:
    // between a config change and the refetch, the old rows are still on
    // screen, and parsing category/member keys as 'YYYY-MM' months produced an
    // Invalid Date — date-fns format() then throws RangeError and, without an
    // error boundary, unmounts the whole page (blank screen). The month branch
    // below also refuses to format anything that is not a real YYYY-MM key.
    const viewSplit: Split = data?.params?.split ?? config.split;

    // Chart rows: months as YYYY-MM keys, category/member rows as names.
    const chartData = useMemo(() => {
        if (!data) return [];
        return data.rows.map((row) => {
            let name: string;
            if (viewSplit === 'month') {
                const parts = String(row.key ?? '').split('-');
                const y = Number(parts[0]);
                const m = Number(parts[1]);
                name = Number.isFinite(y) && Number.isFinite(m) && m >= 1 && m <= 12
                    ? format(new Date(y, m - 1, 1), 'MMM yy', { locale: dateLocale() })
                    : String(row.key ?? row.label ?? '');
            } else if (viewSplit === 'category') {
                name = categoryLabel(String(row.key ?? ''));
            } else {
                name = row.label ?? t('budget:explorer.results.unassigned');
            }
            return {
                name,
                total: row.total,
                recurring: row.recurring_total,
                oneOff: row.total - row.recurring_total,
            };
        });
    }, [data, viewSplit, categoryLabel, t]);

    const hasRows = Boolean(data && data.rows.some((r) => r.count > 0));
    const recurringPct = data && data.summary.total !== 0
        ? Math.round((data.summary.recurring_total / data.summary.total) * 100)
        : 0;
    const colors = TYPE_COLORS[config.type];
    const rangeSubtitle = data
        ? t('budget:explorer.rangeResolved', { start: data.range.start_date, end: data.range.end_date })
        : '';

    const summaryItems = data ? [
        { label: t('budget:explorer.summary.total'), value: formatCurrency(data.summary.total, currency) },
        { label: t('budget:explorer.summary.average'), value: formatCurrency(data.summary.average, currency) },
        { label: t('budget:explorer.summary.count'), value: String(data.summary.count) },
        {
            label: t('budget:explorer.summary.recurringShare'),
            value: `${formatCurrency(data.summary.recurring_total, currency)} (${recurringPct} %)`,
        },
    ] : [];

    const presetOptions = [
        { value: '', label: t('budget:explorer.presets.none') },
        ...savedPresets.map((p) => ({ value: p.name, label: p.name })),
    ];

    return (
        <div className="space-y-4">
            {/* ── Control band ─────────────────────────────────────────── */}
            <Card>
                <CardContent className="p-4 space-y-3">
                    <div className="flex flex-wrap items-end gap-2">
                        <div className="min-w-[10rem] flex-1">
                            <p className="mb-1 text-micro font-medium text-muted-foreground">{t('budget:explorer.range.label')}</p>
                            <Select
                                value={config.preset}
                                onValueChange={(v) => set({ preset: v as RangePreset })}
                                options={[
                                    { value: 'this_year', label: t('budget:explorer.range.thisYear') },
                                    { value: 'last_12_months', label: t('budget:explorer.range.last12Months') },
                                    { value: 'last_year', label: t('budget:explorer.range.lastYear') },
                                    { value: 'custom', label: t('budget:explorer.range.custom') },
                                ]}
                                className="w-full"
                            />
                        </div>
                        {config.preset === 'custom' && (
                            <>
                                <label className="flex flex-col gap-1">
                                    <span className="text-micro font-medium text-muted-foreground">{t('budget:explorer.range.from')}</span>
                                    <input
                                        type="date"
                                        value={config.startDate}
                                        onChange={(e) => set({ startDate: e.target.value })}
                                        className={selectCls}
                                    />
                                </label>
                                <label className="flex flex-col gap-1">
                                    <span className="text-micro font-medium text-muted-foreground">{t('budget:explorer.range.to')}</span>
                                    <input
                                        type="date"
                                        value={config.endDate}
                                        onChange={(e) => set({ endDate: e.target.value })}
                                        className={selectCls}
                                    />
                                </label>
                            </>
                        )}
                        <div className="min-w-[8rem] flex-1">
                            <p className="mb-1 text-micro font-medium text-muted-foreground">{t('budget:explorer.type.label')}</p>
                            <Select
                                value={config.type}
                                onValueChange={(v) => set({ type: v as ReportType })}
                                options={[
                                    { value: 'expenses', label: t('budget:explorer.type.expenses') },
                                    { value: 'income', label: t('budget:explorer.type.income') },
                                    { value: 'net', label: t('budget:explorer.type.net') },
                                ]}
                                className="w-full"
                            />
                        </div>
                        <div className="min-w-[8rem] flex-1">
                            <p className="mb-1 text-micro font-medium text-muted-foreground">{t('budget:explorer.split.label')}</p>
                            <Select
                                value={config.split}
                                onValueChange={(v) => setSplit(v as Split)}
                                options={[
                                    { value: 'month', label: t('budget:explorer.split.month') },
                                    { value: 'category', label: t('budget:explorer.split.category') },
                                    { value: 'member', label: t('budget:explorer.split.member') },
                                ]}
                                className="w-full"
                            />
                        </div>
                        <div className="flex items-center gap-2 pb-1">
                            <span className="text-micro font-medium text-muted-foreground">{t('budget:explorer.includeRecurring')}</span>
                            <Switch
                                checked={config.includeRecurring}
                                onChange={() => set({ includeRecurring: !config.includeRecurring })}
                                label={t('budget:explorer.includeRecurring')}
                            />
                        </div>
                    </div>

                    {/* Optional category / member filters as toggle chips */}
                    <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-micro font-medium text-muted-foreground mr-1">{t('budget:explorer.filters.categories')}</span>
                        <button
                            type="button"
                            onClick={() => set({ categories: [] })}
                            className={cn(
                                'inline-flex min-h-11 items-center rounded-full border px-2.5 py-1 text-xs transition-colors',
                                config.categories.length === 0
                                    ? 'border-primary bg-primary-soft text-primary'
                                    : 'border-border bg-surface-1 text-muted-foreground hover:text-foreground'
                            )}
                        >
                            {t('budget:explorer.filters.all')}
                        </button>
                        {budgetCategories.map((c) => {
                            const on = config.categories.includes(c);
                            return (
                                <button
                                    key={c}
                                    type="button"
                                    onClick={() => set({ categories: toggleInList(config.categories, c) })}
                                    className={cn(
                                        'inline-flex min-h-11 items-center rounded-full border px-2.5 py-1 text-xs transition-colors',
                                        on
                                            ? 'border-primary bg-primary-soft text-primary'
                                            : 'border-border bg-surface-1 text-muted-foreground hover:text-foreground'
                                    )}
                                >
                                    {categoryLabel(c)}
                                </button>
                            );
                        })}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-micro font-medium text-muted-foreground mr-1">{t('budget:explorer.filters.members')}</span>
                        <button
                            type="button"
                            onClick={() => set({ members: [] })}
                            className={cn(
                                'inline-flex min-h-11 items-center rounded-full border px-2.5 py-1 text-xs transition-colors',
                                config.members.length === 0
                                    ? 'border-primary bg-primary-soft text-primary'
                                    : 'border-border bg-surface-1 text-muted-foreground hover:text-foreground'
                            )}
                        >
                            {t('budget:explorer.filters.allMembers')}
                        </button>
                        {members.map((m) => {
                            const on = config.members.includes(m.id);
                            return (
                                <button
                                    key={m.id}
                                    type="button"
                                    onClick={() => set({ members: toggleInList(config.members, m.id) })}
                                    className={cn(
                                        'flex min-h-11 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors',
                                        on
                                            ? 'border-primary bg-primary-soft text-primary'
                                            : 'border-border bg-surface-1 text-muted-foreground hover:text-foreground'
                                    )}
                                >
                                    <span className="h-2 w-2 rounded-full" style={{ background: m.color }} />
                                    {m.name}
                                </button>
                            );
                        })}
                    </div>

                    {/* Saved configurations (localStorage, per account, v1) */}
                    <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
                        <span className="text-micro font-medium text-muted-foreground">{t('budget:explorer.presets.label')}</span>
                        <Select
                            value={selectedPreset}
                            onValueChange={(v) => (v ? applyPreset(v) : setSelectedPreset(''))}
                            options={presetOptions}
                            className="min-w-[10rem] flex-1"
                        />
                        {naming ? (
                            <>
                                <input
                                    type="text"
                                    value={presetName}
                                    onChange={(e) => setPresetName(e.target.value)}
                                    placeholder={t('budget:explorer.presets.name')}
                                    className="w-40 min-h-11 rounded-input border border-border bg-surface-1 px-2 py-1.5 text-xs text-foreground"
                                />
                                <button
                                    type="button"
                                    onClick={saveCurrent}
                                    className="min-h-11 rounded-input bg-primary px-2.5 py-1.5 text-xs font-medium text-white"
                                >
                                    {t('common:actions.save')}
                                </button>
                                <button
                                    type="button"
                                    onClick={() => { setNaming(false); setPresetName(''); }}
                                    className="min-h-11 rounded-input px-2 py-1.5 text-xs text-muted-foreground hover:bg-surface-2"
                                >
                                    {t('common:actions.cancel')}
                                </button>
                            </>
                        ) : (
                            <button
                                type="button"
                                onClick={() => setNaming(true)}
                                className="flex min-h-11 items-center gap-1 rounded-input border border-border bg-surface-1 px-2.5 py-1.5 text-xs text-foreground hover:bg-surface-2"
                            >
                                <Bookmark className="h-3.5 w-3.5" />
                                {t('budget:explorer.presets.save')}
                            </button>
                        )}
                        {selectedPreset && (
                            <button
                                type="button"
                                onClick={deletePreset}
                                aria-label={t('budget:explorer.presets.delete')}
                                className="min-h-11 min-w-11 rounded-input p-1.5 text-destructive hover:bg-destructive/10"
                            >
                                <Trash2 className="h-4 w-4" />
                            </button>
                        )}
                    </div>
                </CardContent>
            </Card>

            {/* ── Summary ──────────────────────────────────────────────── */}
            {data && (
                <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
                    {summaryItems.map((item) => (
                        <div key={item.label} className="rounded-card border border-border bg-card p-4">
                            <p className="truncate text-xs text-muted-foreground">{item.label}</p>
                            <p className="mt-1 truncate text-lg font-bold text-foreground">{item.value}</p>
                        </div>
                    ))}
                </div>
            )}

            {/* ── Results: ChartCard bars or table ─────────────────────── */}
            <ChartCard
                title={t('budget:explorer.results.title')}
                subtitle={rangeSubtitle}
                action={
                    <button
                        type="button"
                        onClick={() => setShowTable((v) => !v)}
                        className="flex shrink-0 items-center gap-1 whitespace-nowrap text-sm font-medium text-primary transition-transform active:scale-95"
                    >
                        {showTable ? <BarChart3 className="h-4 w-4" /> : <Table2 className="h-4 w-4" />}
                        {showTable ? t('budget:explorer.results.chart') : t('budget:explorer.results.table')}
                    </button>
                }
            >
                <ChartErrorBoundary>
                {loading ? (
                    <p className="py-8 text-center text-sm text-muted-foreground">{t('common:states.loading')}</p>
                ) : error ? (
                    <p className="py-8 text-center text-sm text-danger">{error}</p>
                ) : !hasRows ? (
                    <p className="py-8 text-center text-sm text-muted-foreground">{t('budget:explorer.results.empty')}</p>
                ) : showTable ? (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                                    <th className="py-2 pr-3 font-medium">{t(`budget:explorer.split.${viewSplit}`)}</th>
                                    {/* Short column headers (explorer.cols.*) so the 5 columns
                                        fit on one line at 390 px — decision 20/11. */}
                                    <th className="py-2 pr-3 text-right font-medium">{t('budget:explorer.cols.total')}</th>
                                    <th className="py-2 pr-3 text-right font-medium">{t('budget:explorer.cols.count')}</th>
                                    <th className="py-2 pr-3 text-right font-medium">{t('budget:explorer.cols.average')}</th>
                                    <th className="py-2 text-right font-medium">{t('budget:explorer.cols.recurring')}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {chartData.map((row, i) => (
                                    <tr key={`${row.name}-${i}`} className="border-b border-border/60 last:border-0">
                                        <td className="max-w-[10rem] truncate py-2 pr-3">{row.name}</td>
                                        <td className="py-2 pr-3 text-right tabular-nums">{formatCurrency(row.total, currency)}</td>
                                        <td className="py-2 pr-3 text-right tabular-nums">{data!.rows[i].count}</td>
                                        <td className="py-2 pr-3 text-right tabular-nums">{formatCurrency(data!.rows[i].average, currency)}</td>
                                        <td className="py-2 text-right tabular-nums">{formatCurrency(row.recurring, currency)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                ) : config.split === 'month' ? (
                    // key remounts the chart on split change: recharts cannot
                    // switch a mounted BarChart between layouts safely.
                    <ResponsiveContainer key={`chart-${config.split}`} width="100%" height={260}>
                        <BarChart data={chartData}>
                            <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                            <YAxis tick={{ fontSize: 11 }} width={40} />
                            <Tooltip formatter={(v: number) => formatCurrency(v, currency)} />
                            <Legend wrapperStyle={{ fontSize: 12 }} />
                            <Bar dataKey="recurring" name={t('budget:explorer.results.recurring')} stackId="total" fill={colors.recurring} radius={[0, 0, 0, 0]} />
                            <Bar dataKey="oneOff" name={t('budget:explorer.results.oneOff')} stackId="total" fill={colors.oneOff} radius={[4, 4, 0, 0]} />
                        </BarChart>
                    </ResponsiveContainer>
                ) : (
                    <ResponsiveContainer key={`chart-${config.split}`} width="100%" height={Math.max(240, chartData.length * 34)}>
                        <BarChart data={chartData} layout="vertical" margin={{ left: 8, right: 16 }}>
                            <XAxis type="number" tick={{ fontSize: 11 }} />
                            <YAxis type="category" dataKey="name" width={110} tick={{ fontSize: 11 }} />
                            <Tooltip formatter={(v: number) => formatCurrency(v, currency)} />
                            <Bar dataKey="total" name={t('budget:explorer.summary.total')} radius={[0, 4, 4, 0]}>
                                {chartData.map((_, i) => (
                                    <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                                ))}
                            </Bar>
                        </BarChart>
                    </ResponsiveContainer>
                )}
                </ChartErrorBoundary>
            </ChartCard>
        </div>
    );
};

export default ReportExplorer;
