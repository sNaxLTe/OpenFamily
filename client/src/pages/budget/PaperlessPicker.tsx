import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileText, Search } from 'lucide-react';
import { api } from '../../lib/api';
import { friendlyApiError } from '../../lib/friendlyError';
import { intlLocale } from '../../i18n/format';

// Feature 13: Paperless → Budget picker. Shown inside the transaction sheet
// when the server reports Paperless as configured. Everything goes through
// the server proxy (/api/budget/paperless/*) — the Paperless URL/token never
// reach the client. Read-only: selecting a document only PREFILLS the form.

export interface PaperlessPrefill {
    document_id: number;
    title: string;
    correspondent: string | null;
    document_date: string | null;
    invoice_date: string | null;
    suggested_date: string | null;
    suggested_amount: number | null;
    suggested_description: string;
    document_url: string;
}

interface PaperlessDocumentSummary {
    id: number;
    title: string;
    correspondent: string | null;
    created: string | null;
    document_url: string;
}

interface Props {
    onSelect: (prefill: PaperlessPrefill) => void;
}

const formatDocDate = (d: string | null): string => {
    if (!d) return '—';
    const dt = new Date(`${d}T00:00:00`);
    return dt.toLocaleDateString(intlLocale(), { day: 'numeric', month: 'short', year: 'numeric' });
};

const PaperlessPicker: React.FC<Props> = ({ onSelect }) => {
    const { t } = useTranslation(['budget', 'common']);
    const [q, setQ] = useState('');
    const [docs, setDocs] = useState<PaperlessDocumentSummary[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [pickingId, setPickingId] = useState<number | null>(null);

    const load = useCallback(async (query: string) => {
        setLoading(true);
        setError('');
        try {
            const params = new URLSearchParams({ limit: '20' });
            if (query.trim()) params.set('q', query.trim());
            const res = await api.get<{ success: boolean; data: PaperlessDocumentSummary[]; error?: string }>(
                `/api/budget/paperless/documents?${params.toString()}`
            );
            if (res.success) setDocs(res.data);
            else setError(friendlyApiError(res.error ? new Error(res.error) : null, t, 'budget:paperless.error'));
        } catch {
            setError(t('budget:paperless.error'));
        } finally {
            setLoading(false);
        }
    }, [t]);

    // Recent documents on open.
    useEffect(() => { void load(''); }, [load]);

    const pick = async (id: number) => {
        setPickingId(id);
        setError('');
        try {
            const res = await api.get<{ success: boolean; data: PaperlessPrefill; error?: string }>(
                `/api/budget/paperless/documents/${id}/prefill`
            );
            if (res.success) onSelect(res.data);
            else setError(friendlyApiError(res.error ? new Error(res.error) : null, t, 'budget:paperless.error'));
        } catch {
            setError(t('budget:paperless.error'));
        } finally {
            setPickingId(null);
        }
    };

    return (
        <div className="space-y-3">
            <form
                className="flex gap-2"
                onSubmit={(e) => { e.preventDefault(); void load(q); }}
            >
                <input
                    type="search"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder={t('budget:paperless.searchPlaceholder')}
                    aria-label={t('budget:paperless.searchPlaceholder')}
                    className="flex-1 px-3 py-2.5 rounded-xl border border-border bg-surface-1 text-foreground text-base
                               focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition"
                />
                <button
                    type="submit"
                    className="flex items-center gap-1.5 rounded-xl bg-primary px-3 py-2.5 text-sm font-medium text-white active:scale-95 transition-transform"
                >
                    <Search className="h-4 w-4" />
                    {t('budget:paperless.search')}
                </button>
            </form>

            {error && (
                <p className="rounded-xl border border-danger/20 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>
            )}

            {loading ? (
                <p className="py-6 text-center text-sm text-muted-foreground">{t('common:states.loading')}</p>
            ) : docs.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">{t('budget:paperless.empty')}</p>
            ) : (
                <ul className="max-h-80 space-y-2 overflow-y-auto">
                    {docs.map((d) => (
                        <li key={d.id}>
                            <button
                                type="button"
                                onClick={() => void pick(d.id)}
                                disabled={pickingId !== null}
                                className="flex w-full items-center gap-3 rounded-xl border border-border bg-surface-1 p-3 text-left
                                           transition-colors hover:bg-surface-2 disabled:opacity-60"
                            >
                                <FileText className="h-4 w-4 shrink-0 text-primary" />
                                <span className="min-w-0 flex-1">
                                    <span className="block truncate text-sm font-medium text-foreground">
                                        {d.title || `#${d.id}`}
                                    </span>
                                    <span className="block text-xs text-muted-foreground">
                                        {formatDocDate(d.created)}
                                        {d.correspondent ? ` · ${d.correspondent}` : ''}
                                    </span>
                                </span>
                                {pickingId === d.id && <span className="spinner-brand" />}
                            </button>
                        </li>
                    ))}
                </ul>
            )}

            <p className="text-xs text-muted-foreground">{t('budget:paperless.prefillHint')}</p>
        </div>
    );
};

export default PaperlessPicker;
