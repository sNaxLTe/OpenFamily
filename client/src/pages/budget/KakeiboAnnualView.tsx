import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { format } from 'date-fns';
import { Check, PiggyBank, Target, TrendingUp } from 'lucide-react';
import { api } from '../../lib/api';
import { formatCurrency } from '../../lib/utils';
import { dateLocale } from '../../i18n/format';
import { useWebSocketUpdates } from '../../hooks/useWebSocketUpdates';
import { PILLAR_META, type Pillar } from './KakeiboView';

// Annual Kakeibo (feature 5): savings balance of the year (sum of the monthly
// goals vs what was actually saved), expenses rolled up by pillar over the
// year, month-by-month detail, and the editable end-of-year notes.
// Data: GET /api/kakeibo/annual?year= ; notes: PUT /api/kakeibo/annual/notes.

interface CategoryLine { category: string; amount: number; pillar: Pillar; }
interface MonthlyLine { month: number; savings_goal: number; realized: number; }
interface KakeiboAnnual {
    year: number;
    goalsTotal: number;
    realizedTotal: number;
    savingsGoalReached: boolean;
    byPillar: Record<Pillar, number>;
    byCategory: CategoryLine[];
    monthly: MonthlyLine[];
    notes: string | null;
}

const PILLARS: Pillar[] = ['survival', 'wants', 'culture', 'extra'];

interface Props {
    year: number;
    canEdit: boolean;
    currency: string;
    categoryLabel: (v: string) => string;
}

const KakeiboAnnualView: React.FC<Props> = ({ year, canEdit, currency, categoryLabel }) => {
    const { t } = useTranslation(['kakeibo', 'common']);
    const [data, setData] = useState<KakeiboAnnual | null>(null);
    const [loading, setLoading] = useState(true);
    const [notesDraft, setNotesDraft] = useState('');
    const [savingNotes, setSavingNotes] = useState(false);

    const load = useCallback(async () => {
        try {
            const res = await api.get<{ success: boolean; data: KakeiboAnnual }>(
                `/api/kakeibo/annual?year=${year}`
            );
            if (res.success) {
                setData(res.data);
                setNotesDraft(res.data.notes ?? '');
            }
        } catch (err) {
            console.error('Failed to load annual kakeibo:', err);
        } finally {
            setLoading(false);
        }
    }, [year]);

    useEffect(() => { setLoading(true); void load(); }, [load]);
    useWebSocketUpdates('budget', () => { void load(); });

    const cur = (v: number) => formatCurrency(v, currency);
    const pillarLabel = (p: Pillar) => t(`kakeibo:pillars.${p}`);

    const saveNotes = async () => {
        setSavingNotes(true);
        try {
            await api.put('/api/kakeibo/annual/notes', { year, notes: notesDraft });
            await load();
        } finally {
            setSavingNotes(false);
        }
    };

    if (loading || !data) {
        return (
            <div className="flex items-center justify-center py-16">
                <div className="spinner-brand" />
            </div>
        );
    }

    const goalPct = data.goalsTotal > 0
        ? Math.min(100, Math.round((data.realizedTotal / data.goalsTotal) * 100))
        : 0;
    const hasData = data.monthly.some((m) => m.savings_goal !== 0 || m.realized !== 0);

    return (
        <div className="space-y-3">
            {!hasData && (
                <p className="rounded-card border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
                    {t('kakeibo:annual.noData', { year })}
                </p>
            )}

            {/* ── Savings balance of the year ─────────────────────────────── */}
            <div className="rounded-card bg-gradient-to-br from-primary/90 to-primary p-5 text-primary-foreground shadow-card">
                <p className="text-xs uppercase tracking-wide opacity-80">{t('kakeibo:annual.title', { year })}</p>
                <div className="mt-2 flex items-end justify-between gap-3">
                    <div>
                        <p className="text-xs opacity-80">{t('kakeibo:annual.realized')}</p>
                        <p className="text-4xl font-bold tracking-tight">{cur(data.realizedTotal)}</p>
                    </div>
                    <div className="text-right">
                        <p className="text-xs opacity-80">{t('kakeibo:annual.goalsTotal')}</p>
                        <p className="text-2xl font-bold">{cur(data.goalsTotal)}</p>
                    </div>
                </div>
                <div className="mt-4">
                    <div className="mb-1 flex justify-between text-xs opacity-90">
                        <span>{data.goalsTotal > 0 ? `${goalPct}%` : '—'}</span>
                        <span>
                            {data.savingsGoalReached
                                ? t('kakeibo:annual.reached')
                                : t('kakeibo:annual.missed', { amount: cur(Math.max(data.goalsTotal - data.realizedTotal, 0)) })}
                        </span>
                    </div>
                    <div className="h-2.5 w-full overflow-hidden rounded-full bg-white/25">
                        <div
                            className="h-full rounded-full bg-white transition-all"
                            style={{ width: `${goalPct}%` }}
                        />
                    </div>
                </div>
            </div>

            {/* ── Pillars over the year ───────────────────────────────────── */}
            <div className="rounded-card border border-border bg-card p-4">
                <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <PiggyBank className="h-4 w-4 text-primary" /> {t('kakeibo:annual.pillarsTitle')}
                </h3>
                <div className="mt-3 grid grid-cols-2 gap-2">
                    {PILLARS.map((p) => {
                        const amount = data.byPillar[p] || 0;
                        const total = PILLARS.reduce((s, q) => s + (data.byPillar[q] || 0), 0);
                        const pct = total > 0 ? Math.round((amount / total) * 100) : 0;
                        return (
                            <div key={p} className={`rounded-card ${PILLAR_META[p].soft} p-3`}>
                                <div className="flex items-center gap-2">
                                    <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: PILLAR_META[p].color }} />
                                    <span className="text-xs font-medium text-foreground">{pillarLabel(p)}</span>
                                </div>
                                <p className="mt-1 text-lg font-bold text-foreground">{cur(amount)}</p>
                                <p className="text-xs text-muted-foreground">{pct}%</p>
                            </div>
                        );
                    })}
                </div>
                <div className="mt-4 space-y-1.5">
                    {data.byCategory.map((line) => (
                        <div key={line.category} className="flex items-center gap-2 text-sm">
                            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: PILLAR_META[line.pillar].color }} />
                            <span className="flex-1 text-foreground">{categoryLabel(line.category)}</span>
                            <span className="text-muted-foreground">{cur(line.amount)}</span>
                        </div>
                    ))}
                    {data.byCategory.length === 0 && (
                        <p className="py-3 text-center text-sm text-muted-foreground">{t('kakeibo:noExpenses')}</p>
                    )}
                </div>
            </div>

            {/* ── Month by month ──────────────────────────────────────────── */}
            <div className="rounded-card border border-border bg-card p-4">
                <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <Target className="h-4 w-4 text-primary" /> {t('kakeibo:annual.monthlyTitle')}
                </h3>
                <div className="mt-3 space-y-1.5">
                    <div className="flex gap-2 text-xs font-medium text-muted-foreground">
                        <span className="flex-1">{t('kakeibo:annual.month')}</span>
                        <span className="w-24 text-right">{t('kakeibo:annual.goal')}</span>
                        <span className="w-24 text-right">{t('kakeibo:annual.realizedCol')}</span>
                    </div>
                    {data.monthly.map((m) => (
                        <div key={m.month} className="flex items-center gap-2 text-sm">
                            <span className="flex-1 capitalize text-foreground">
                                {format(new Date(year, m.month - 1), 'MMMM', { locale: dateLocale() })}
                            </span>
                            <span className="w-24 text-right text-muted-foreground">{cur(m.savings_goal)}</span>
                            <span className={`w-24 text-right font-medium ${m.realized >= m.savings_goal ? 'text-success' : 'text-foreground'}`}>
                                {cur(m.realized)}
                            </span>
                        </div>
                    ))}
                </div>
            </div>

            {/* ── End-of-year notes ───────────────────────────────────────── */}
            <div className={`rounded-card border p-4 ${data.savingsGoalReached ? 'border-success/30 bg-success/5' : 'border-border bg-card'}`}>
                <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <TrendingUp className="h-4 w-4 text-primary" /> {t('kakeibo:annual.notesTitle')}
                </h3>
                <div className="mt-3">
                    <textarea
                        value={notesDraft}
                        disabled={!canEdit}
                        onChange={(e) => setNotesDraft(e.target.value)}
                        placeholder={t('kakeibo:annual.notesPlaceholder')}
                        rows={4}
                        className="w-full resize-none rounded-input border border-border bg-surface-1 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
                    />
                    {canEdit && notesDraft !== (data.notes ?? '') && (
                        <button onClick={() => void saveNotes()} disabled={savingNotes} className="btn-primary btn-sm mt-2 inline-flex items-center gap-1">
                            <Check className="h-4 w-4" /> {t('common:save', { defaultValue: 'Save' })}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
};

export default KakeiboAnnualView;
