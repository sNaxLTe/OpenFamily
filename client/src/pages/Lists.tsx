import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
    Plus, Check, ChevronDown, ChevronUp, ChevronLeft, MoreVertical, Pin, PinOff, Pencil, Trash2, X, ListChecks,
} from 'lucide-react';
import { Card, CardContent, Button, Input, Select, useToast } from '../components/ui';
import { useAuth } from '../contexts/AuthContext';
import { useWebSocketUpdates } from '../hooks/useWebSocketUpdates';
import { api } from '../lib/api';
import { cn } from '../lib/utils';
import { friendlyApiError } from '../lib/friendlyError';
import { useHistoryAwareOverlay } from '../lib/useHistoryAwareOverlay';
import { LIST_ICONS, LIST_NAME_MAX, LIST_ITEM_TEXT_MAX, LIST_CATEGORY_MAX } from '@openfamily/shared';

/**
 * Module Listes (fonctionnalité 15 du fork) : liste de listes familiales.
 * - épingles, état des accordéons et visibilité des cochés : localStorage par
 *   compte et par appareil (pas de synchro serveur en v1) ;
 * - gestion des listes/catégories : parents seuls (caché ici, 403 au serveur) ;
 * - items : tous les membres ; coche grise et descend en bas de sa catégorie ;
 * - temps réel via le canal WebSocket 'lists'.
 */

interface ListSummary {
    id: string;
    name: string;
    icon: string;
    created_by?: string | null;
    created_at?: string | null;
    counts: { total: number; unchecked: number; done: number };
}

interface ListItem {
    id: string;
    list_id: string;
    text: string;
    category: string | null;
    checked: boolean;
    checked_by?: string | null;
    checked_at?: string | null;
    position: number;
    created_by?: string | null;
    created_at?: string | null;
}

interface CategoryCount {
    name: string | null;
    total: number;
    unchecked: number;
    firstPosition: number;
}

const NO_CATEGORY = '__none__';
const NEW_CATEGORY = '__new__';

// ─── localStorage helpers (per account, per device) ──────────────────────────

const readJson = <T,>(key: string, fallback: T): T => {
    try {
        const raw = localStorage.getItem(key);
        return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
        return fallback;
    }
};
const writeJson = (key: string, value: unknown): void => {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch {
        /* private mode: the choice lasts for this visit */
    }
};

const pinsKey = (userId: string | undefined) => `openfamily.listPins.${userId}`;
const collapsedKey = (userId: string | undefined, listId: string) =>
    `openfamily.listCollapsedCats.${userId}.${listId}`;
const showCheckedKey = (userId: string | undefined, listId: string) =>
    `openfamily.listShowChecked.${userId}.${listId}`;

const getPins = (userId: string | undefined): string[] => {
    const pins = readJson<string[]>(pinsKey(userId), []);
    return Array.isArray(pins) ? pins.filter((p) => typeof p === 'string') : [];
};
const togglePin = (userId: string | undefined, listId: string): string[] => {
    const pins = getPins(userId);
    const next = pins.includes(listId)
        ? pins.filter((p) => p !== listId)
        : [listId, ...pins.filter((p) => p !== listId)]; // most recently pinned first
    writeJson(pinsKey(userId), next);
    return next;
};

// ─── Small building blocks ────────────────────────────────────────────────────

/** History-aware bottom sheet (same pattern as the Budget module's Sheet).
 *  dismissible=false on editing sheets: outside tap ignored, back/swipe-back
 *  consumed silently; X and Escape still close. */
const Sheet: React.FC<{
    open: boolean; onClose: () => void; title: string; children: React.ReactNode;
    dismissible?: boolean;
}> = ({
    open, onClose, title, children, dismissible = true,
}) => {
    const { t } = useTranslation('common');
    const titleRef = useRef<HTMLHeadingElement>(null);
    useHistoryAwareOverlay(open, onClose, { closeOnPop: dismissible });
    // onClose changes identity on every parent render: keep it in a ref and
    // depend only on `open`, so this effect runs ONCE when the sheet opens.
    // Otherwise titleRef.focus() would re-fire on every keystroke and steal
    // the focus from the input being typed in (keyboard closes on iOS).
    const onCloseRef = useRef(onClose);
    useEffect(() => { onCloseRef.current = onClose; });
    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCloseRef.current(); };
        window.addEventListener('keydown', onKey);
        titleRef.current?.focus();
        return () => window.removeEventListener('keydown', onKey);
    }, [open]);
    if (!open) return null;
    return (
        <div className="fixed inset-0 z-50 flex flex-col justify-end" onClick={dismissible ? onClose : undefined}>
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

/** A "…" menu: a ≥ 44 px button opening a popover of ≥ 44 px actions. */
const Menu: React.FC<{
    label: string;
    items: Array<{ key: string; label: string; icon?: React.ReactNode; danger?: boolean; onClick: () => void }>;
}> = ({ label, items }) => {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!open) return;
        const onDoc = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener('mousedown', onDoc);
        return () => document.removeEventListener('mousedown', onDoc);
    }, [open]);
    return (
        <div className="relative" ref={ref}>
            <button
                type="button"
                aria-label={label}
                aria-expanded={open}
                onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
                className="flex min-h-11 min-w-11 items-center justify-center rounded-full hover:bg-surface-2 transition-colors"
            >
                <MoreVertical className="h-5 w-5 text-muted-foreground" />
            </button>
            {open && (
                <div
                    className="absolute right-0 z-40 mt-1 w-56 rounded-card border border-border bg-popover shadow-surface-hover overflow-hidden"
                    onClick={(e) => e.stopPropagation()}
                >
                    {items.map((item) => (
                        <button
                            key={item.key}
                            type="button"
                            onClick={() => { setOpen(false); item.onClick(); }}
                            className={cn(
                                'flex min-h-11 w-full items-center gap-2 px-3 text-left text-body-sm hover:bg-surface-2 transition-colors',
                                item.danger && 'text-destructive'
                            )}
                        >
                            {item.icon}
                            {item.label}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
};

/** The fixed icon grid, every cell a ≥ 44 px target. */
const IconGrid: React.FC<{ value: string; onChange: (icon: string) => void }> = ({ value, onChange }) => (
    <div className="grid grid-cols-8 gap-2">
        {LIST_ICONS.map((icon) => (
            <button
                key={icon}
                type="button"
                aria-label={icon}
                aria-pressed={value === icon}
                onClick={() => onChange(icon)}
                className={cn(
                    'flex min-h-11 min-w-11 items-center justify-center rounded-input text-2xl transition-colors',
                    value === icon
                        ? 'bg-primary-soft ring-2 ring-primary'
                        : 'hover:bg-surface-2 border border-border'
                )}
            >
                {icon}
            </button>
        ))}
    </div>
);

/**
 * Shared category picker, used by both the add row and the edit-item sheet:
 * "Sans catégorie" + the list's existing categories (order of appearance) +
 * "+ Nouvelle catégorie" revealing a free-text field. Defined ONCE at module
 * level so its identity is stable across renders — an inline component would
 * be recreated on every render and remount the input on each keystroke
 * (focus loss on iOS/Mac).
 */
const CategorySelect: React.FC<{
    id?: string;
    label: string;
    value: string;
    customValue: string;
    existing: string[];
    onChange: (value: string) => void;
    onCustomChange: (value: string) => void;
}> = ({ id, label, value, customValue, existing, onChange, onCustomChange }) => {
    const { t } = useTranslation(['lists']);
    return (
        <div>
            <span className="block text-label font-medium text-foreground mb-1.5">{label}</span>
            {value === NEW_CATEGORY ? (
                <Input
                    id={id}
                    value={customValue}
                    onChange={(e) => onCustomChange(e.target.value)}
                    placeholder={t('lists:list.category.newPlaceholder')}
                    maxLength={LIST_CATEGORY_MAX}
                    autoFocus
                />
            ) : (
                <Select
                    value={value}
                    onValueChange={onChange}
                    options={[
                        { value: '', label: t('lists:list.category.none') },
                        ...existing.map((c) => ({ value: c, label: c })),
                        { value: NEW_CATEGORY, label: t('lists:list.category.new') },
                    ]}
                />
            )}
        </div>
    );
};

/** Resolves the picker state to the category sent to the API (null = none). */
const resolveCategory = (value: string, customValue: string): string | null => {
    if (value === NEW_CATEGORY) {
        const custom = customValue.trim();
        return custom ? custom : null;
    }
    return value ? value : null;
};

// ─── The page ─────────────────────────────────────────────────────────────────

const Lists: React.FC = () => {
    const { listId } = useParams<{ listId: string }>();
    return listId ? <ListDetail key={listId} listId={listId} /> : <ListsHome />;
};

// ─── List of lists ────────────────────────────────────────────────────────────

const ListsHome: React.FC = () => {
    const { t } = useTranslation(['lists', 'common']);
    const { user } = useAuth();
    const { showToast } = useToast();
    const isParent = Boolean(user?.is_owner) || user?.role !== 'enfant';
    const [lists, setLists] = useState<ListSummary[]>([]);
    const [pins, setPins] = useState<string[]>(() => getPins(user?.id));
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    // Sheets: create | rename | icon
    const [sheet, setSheet] = useState<null | { mode: 'create' | 'rename' | 'icon'; list?: ListSummary }>(null);
    const [name, setName] = useState('');
    const [icon, setIcon] = useState<string>(LIST_ICONS[0]);

    const load = async () => {
        try {
            const response = await api.get<{ success: boolean; data: ListSummary[] }>('/api/lists');
            if (response.success) setLists(response.data);
        } catch (err) {
            console.error('Failed to load lists:', err);
            setError(friendlyApiError(err, t, 'lists:errors.loadLists'));
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { void load(); }, []);
    useEffect(() => { setPins(getPins(user?.id)); }, [user?.id]);
    useWebSocketUpdates('lists', () => { void load(); });

    // Pinned first (most recently pinned first), then creation order.
    const sorted = useMemo(() => {
        const byId = new Map(lists.map((l) => [l.id, l]));
        const pinned = pins.filter((id) => byId.has(id)).map((id) => byId.get(id)!);
        const rest = lists.filter((l) => !pins.includes(l.id));
        return [...pinned, ...rest];
    }, [lists, pins]);

    const openCreate = () => {
        setName('');
        setIcon(LIST_ICONS[0]);
        setSheet({ mode: 'create' });
    };
    const openRename = (list: ListSummary) => {
        setName(list.name);
        setIcon(list.icon);
        setSheet({ mode: 'rename', list });
    };
    const openIcon = (list: ListSummary) => {
        setName(list.name);
        setIcon(list.icon);
        setSheet({ mode: 'icon', list });
    };

    const submitSheet = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        const trimmed = name.trim();
        if (!trimmed || trimmed.length > LIST_NAME_MAX) {
            setError(t('lists:errors.invalidName'));
            return;
        }
        try {
            if (sheet?.mode === 'create') {
                await api.post('/api/lists', { name: trimmed, icon });
            } else if (sheet?.list) {
                const body: Record<string, unknown> =
                    sheet.mode === 'rename' ? { name: trimmed } : { icon };
                await api.put(`/api/lists/${sheet.list.id}`, body);
            }
            setSheet(null);
            await load();
        } catch (err) {
            console.error('Failed to save list:', err);
            setError(friendlyApiError(err, t, 'lists:errors.saveList'));
        }
    };

    const handleDelete = async (list: ListSummary) => {
        if (!confirm(t('lists:deleteConfirm', { name: list.name }))) return;
        try {
            await api.delete(`/api/lists/${list.id}`);
            showToast({ title: t('lists:menu.delete'), description: `${list.icon} ${list.name}` });
            setPins(togglePin(user?.id, list.id));
            await load();
        } catch (err) {
            console.error('Failed to delete list:', err);
            setError(friendlyApiError(err, t, 'lists:errors.deleteList'));
        }
    };

    if (loading) {
        return (
            <div className="flex h-full items-center justify-center min-h-[50vh]">
                <div className="flex flex-col items-center gap-4">
                    <div className="spinner-brand" />
                    <p className="text-muted-foreground font-medium animate-pulse">{t('lists:loading')}</p>
                </div>
            </div>
        );
    }

    return (
        <div className="mx-auto max-w-6xl space-y-6 2xl:max-w-[1600px]">
            {error ? (
                <div className="rounded-input border border-danger/30 bg-danger/10 px-4 py-3 text-caption text-danger">{error}</div>
            ) : null}
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                    <h2 className="text-h1 mb-1">{t('lists:title')}</h2>
                    <p className="text-muted-foreground text-body">{t('lists:subtitle')}</p>
                </div>
                {isParent && (
                    <Button onClick={openCreate}>
                        <Plus className="w-4 h-4 mr-2" />
                        {t('lists:empty.cta')}
                    </Button>
                )}
            </div>

            {sorted.length === 0 ? (
                <Card>
                    <CardContent className="p-8 flex flex-col items-center gap-4 text-center">
                        <ListChecks className="h-10 w-10 text-muted-foreground" />
                        <p className="text-muted-foreground text-body">{t('lists:empty.title')}</p>
                        {isParent && (
                            <Button onClick={openCreate}>
                                <Plus className="w-4 h-4 mr-2" />
                                {t('lists:empty.cta')}
                            </Button>
                        )}
                    </CardContent>
                </Card>
            ) : (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {sorted.map((list) => {
                        const pinned = pins.includes(list.id);
                        const allDone = list.counts.total > 0 && list.counts.unchecked === 0;
                        return (
                            <Card key={list.id} className="hover:shadow-surface-hover transition-shadow">
                                <CardContent className="p-4">
                                    <div className="flex items-start gap-3">
                                        <Link
                                            to={`/lists/${list.id}`}
                                            className="flex-1 flex items-center gap-3 min-w-0"
                                            aria-label={`${list.icon} ${list.name}`}
                                        >
                                            <span className="text-3xl shrink-0" aria-hidden="true">{list.icon}</span>
                                            <span className="min-w-0">
                                                <span className="flex items-center gap-1.5 font-medium text-foreground truncate">
                                                    <span className="truncate">{list.name}</span>
                                                    {pinned && <Pin className="h-3.5 w-3.5 shrink-0 text-primary fill-current" aria-label={t('lists:menu.pin')} />}
                                                    {allDone && <Check className="h-4 w-4 shrink-0 text-success" aria-label={t('lists:allDone')} />}
                                                </span>
                                                <span className="block text-micro text-muted-foreground">
                                                    {allDone
                                                        ? t('lists:allDone')
                                                        : t('lists:counts.remaining', { unchecked: list.counts.unchecked, total: list.counts.total })}
                                                </span>
                                            </span>
                                        </Link>
                                        {isParent && (
                                            <Menu
                                                label={`${list.name} — ${t('lists:title')}`}
                                                items={[
                                                    {
                                                        key: 'pin',
                                                        label: pinned ? t('lists:menu.unpin') : t('lists:menu.pin'),
                                                        icon: pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />,
                                                        onClick: () => setPins(togglePin(user?.id, list.id)),
                                                    },
                                                    { key: 'rename', label: t('lists:menu.rename'), icon: <Pencil className="h-4 w-4" />, onClick: () => openRename(list) },
                                                    { key: 'icon', label: t('lists:menu.changeIcon'), icon: <span aria-hidden="true">{list.icon}</span>, onClick: () => openIcon(list) },
                                                    { key: 'delete', label: t('lists:menu.delete'), icon: <Trash2 className="h-4 w-4" />, danger: true, onClick: () => { void handleDelete(list); } },
                                                ]}
                                            />
                                        )}
                                    </div>
                                </CardContent>
                            </Card>
                        );
                    })}
                </div>
            )}

            {/* Create / rename / icon sheet */}
            <Sheet
                open={sheet !== null}
                dismissible={false}
                onClose={() => setSheet(null)}
                title={
                    sheet?.mode === 'create'
                        ? t('lists:create.title')
                        : sheet?.mode === 'rename'
                            ? t('lists:rename.title')
                            : t('lists:iconPicker.title')
                }
            >
                <form onSubmit={submitSheet} className="space-y-4">
                    {(sheet?.mode === 'create' || sheet?.mode === 'rename') && (
                        <Input
                            label={sheet.mode === 'create' ? t('lists:create.nameLabel') : t('lists:rename.nameLabel')}
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder={t('lists:create.namePlaceholder')}
                            maxLength={LIST_NAME_MAX}
                            required
                            autoFocus
                        />
                    )}
                    {sheet?.mode !== 'rename' && (
                        <div>
                            <label className="block text-label font-medium text-foreground mb-1.5">
                                {t('lists:create.iconLabel')}
                            </label>
                            <IconGrid value={icon} onChange={setIcon} />
                        </div>
                    )}
                    <div className="flex justify-end gap-3 pt-2">
                        <Button type="button" variant="secondary" onClick={() => setSheet(null)}>
                            {t('common:actions.cancel')}
                        </Button>
                        <Button type="submit">
                            {sheet?.mode === 'create' ? t('lists:create.submit') : t('lists:rename.submit')}
                        </Button>
                    </div>
                </form>
            </Sheet>
        </div>
    );
};

// ─── Inside one list ──────────────────────────────────────────────────────────

const ListDetail: React.FC<{ listId: string }> = ({ listId }) => {
    const { t } = useTranslation(['lists', 'common']);
    const { user } = useAuth();
    const { showToast } = useToast();
    const navigate = useNavigate();
    const isParent = Boolean(user?.is_owner) || user?.role !== 'enfant';
    const [list, setList] = useState<ListSummary | null>(null);
    const [items, setItems] = useState<ListItem[]>([]);
    const [categories, setCategories] = useState<CategoryCount[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [newText, setNewText] = useState('');
    const [newCategory, setNewCategory] = useState('');
    const [newCategoryCustom, setNewCategoryCustom] = useState('');
    const [collapsed, setCollapsed] = useState<string[]>(() => readJson<string[]>(collapsedKey(user?.id, listId), []));
    const [showChecked, setShowChecked] = useState<boolean>(() => readJson<string>(showCheckedKey(user?.id, listId), '1') !== '0');
    // Item edit sheet
    const [editItem, setEditItem] = useState<ListItem | null>(null);
    const [editText, setEditText] = useState('');
    const [editCategory, setEditCategory] = useState('');
    const [editCategoryCustom, setEditCategoryCustom] = useState('');
    // Category rename sheet
    const [renameCat, setRenameCat] = useState<string | null>(null);
    const [renameCatTo, setRenameCatTo] = useState('');

    const load = async () => {
        try {
            const response = await api.get<{ success: boolean; data: { list: ListSummary; items: ListItem[]; categories: CategoryCount[] } }>(
                `/api/lists/${listId}/items`
            );
            if (response.success) {
                setList(response.data.list);
                setItems(response.data.items);
                setCategories(response.data.categories);
            }
        } catch (err) {
            console.error('Failed to load list items:', err);
            setError(friendlyApiError(err, t, 'lists:errors.loadItems'));
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { void load(); }, [listId]);
    useEffect(() => { setCollapsed(readJson<string[]>(collapsedKey(user?.id, listId), [])); }, [user?.id, listId]);
    useEffect(() => { setShowChecked(readJson<string>(showCheckedKey(user?.id, listId), '1') !== '0'); }, [user?.id, listId]);
    useWebSocketUpdates('lists', () => { void load(); });

    const toggleCollapsed = (catKey: string) => {
        setCollapsed((prev) => {
            const next = prev.includes(catKey) ? prev.filter((c) => c !== catKey) : [...prev, catKey];
            writeJson(collapsedKey(user?.id, listId), next);
            return next;
        });
    };
    const toggleShowChecked = () => {
        setShowChecked((prev) => {
            writeJson(showCheckedKey(user?.id, listId), prev ? '0' : '1');
            return !prev;
        });
    };

    // Categories in order of appearance (first item's position); "Sans catégorie" always last.
    const grouped = useMemo(() => {
        const byCat = new Map<string, ListItem[]>();
        for (const item of items) {
            const key = item.category ?? NO_CATEGORY;
            const list_ = byCat.get(key) ?? [];
            list_.push(item);
            byCat.set(key, list_);
        }
        const order = [...byCat.entries()].sort((a, b) => {
            if (a[0] === NO_CATEGORY) return 1;
            if (b[0] === NO_CATEGORY) return -1;
            const pa = Math.min(...a[1].map((i) => i.position));
            const pb = Math.min(...b[1].map((i) => i.position));
            return pa - pb;
        });
        // Within a category: unchecked first (by position), checked last (by position).
        return order.map(([key, listItems]) => ({
            key,
            name: key === NO_CATEGORY ? null : key,
            items: [...listItems].sort((a, b) =>
                Number(a.checked) - Number(b.checked) || a.position - b.position
            ),
        }));
    }, [items]);

    const existingCategories = useMemo(
        () => grouped.map((g) => g.name).filter((n): n is string => n !== null),
        [grouped]
    );

    const catCountOf = (key: string): CategoryCount => {
        const name = key === NO_CATEGORY ? null : key;
        return categories.find((c) => c.name === name) ?? { name, total: 0, unchecked: 0, firstPosition: 0 };
    };

    const handleAdd = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        const text = newText.trim();
        if (!text || text.length > LIST_ITEM_TEXT_MAX) {
            setError(t('lists:errors.invalidText'));
            return;
        }
        const category = resolveCategory(newCategory, newCategoryCustom);
        if (category && category.length > LIST_CATEGORY_MAX) {
            setError(t('lists:errors.invalidCategory'));
            return;
        }
        try {
            await api.post(`/api/lists/${listId}/items`, { text, category });
            setNewText('');
            setNewCategory('');
            setNewCategoryCustom('');
            await load();
        } catch (err) {
            console.error('Failed to add item:', err);
            setError(friendlyApiError(err, t, 'lists:errors.saveItem'));
        }
    };

    const handleToggleChecked = async (item: ListItem) => {
        try {
            await api.put(`/api/items/${item.id}`, { checked: !item.checked });
            await load();
        } catch (err) {
            console.error('Failed to toggle item:', err);
            setError(friendlyApiError(err, t, 'lists:errors.saveItem'));
        }
    };

    // Move one step up/down within the item's own category (persisted server-side).
    // The server swaps position with the neighbour of the same category AND same
    // checked state, matching the display order (checked sort last in a category).
    const handleMoveItem = async (item: ListItem, direction: 'up' | 'down') => {
        try {
            await api.put(`/api/items/${item.id}/move`, { direction });
            await load();
        } catch (err) {
            console.error('Failed to move item:', err);
            setError(friendlyApiError(err, t, 'lists:errors.saveItem'));
        }
    };

    const handleDeleteItem = async (item: ListItem) => {
        if (!confirm(t('lists:list.deleteItemConfirm'))) return;
        try {
            await api.delete(`/api/items/${item.id}`);
            showToast({ title: t('lists:list.itemMenu.delete'), description: item.text });
            await load();
        } catch (err) {
            console.error('Failed to delete item:', err);
            setError(friendlyApiError(err, t, 'lists:errors.deleteItem'));
        }
    };

    const openEditItem = (item: ListItem) => {
        setEditItem(item);
        setEditText(item.text);
        // Existing category → picked in the dropdown; a category that no longer
        // appears in the list (renamed meanwhile) → free-text via "new".
        if (!item.category) {
            setEditCategory('');
            setEditCategoryCustom('');
        } else if (existingCategories.includes(item.category)) {
            setEditCategory(item.category);
            setEditCategoryCustom('');
        } else {
            setEditCategory(NEW_CATEGORY);
            setEditCategoryCustom(item.category);
        }
    };
    const submitEditItem = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!editItem) return;
        setError('');
        const text = editText.trim();
        if (!text || text.length > LIST_ITEM_TEXT_MAX) {
            setError(t('lists:errors.invalidText'));
            return;
        }
        const category = resolveCategory(editCategory, editCategoryCustom);
        if (category && category.length > LIST_CATEGORY_MAX) {
            setError(t('lists:errors.invalidCategory'));
            return;
        }
        try {
            await api.put(`/api/items/${editItem.id}`, { text, category: category || null });
            setEditItem(null);
            await load();
        } catch (err) {
            console.error('Failed to edit item:', err);
            setError(friendlyApiError(err, t, 'lists:errors.saveItem'));
        }
    };

    const handleRenameCategory = async (e: React.FormEvent) => {
        e.preventDefault();
        if (renameCat === null) return;
        setError('');
        const to = renameCatTo.trim();
        if (!to || to.length > LIST_CATEGORY_MAX) {
            setError(t('lists:errors.invalidCategory'));
            return;
        }
        try {
            await api.put(`/api/lists/${listId}/category`, { from: renameCat, to });
            setRenameCat(null);
            showToast({ title: t('lists:list.renameCategory.toast', { to }) });
            await load();
        } catch (err) {
            console.error('Failed to rename category:', err);
            setError(friendlyApiError(err, t, 'lists:errors.category'));
        }
    };

    const handleDeleteCategory = async (name: string) => {
        if (!confirm(t('lists:list.deleteCategoryConfirm', { name }))) return;
        try {
            // api.delete sends no body: the name goes in the query string
            // (the server also accepts a JSON body).
            await api.delete(`/api/lists/${listId}/category?name=${encodeURIComponent(name)}`);
            await load();
        } catch (err) {
            console.error('Failed to delete category:', err);
            setError(friendlyApiError(err, t, 'lists:errors.category'));
        }
    };

    if (loading) {
        return (
            <div className="flex h-full items-center justify-center min-h-[50vh]">
                <div className="flex flex-col items-center gap-4">
                    <div className="spinner-brand" />
                    <p className="text-muted-foreground font-medium animate-pulse">{t('lists:loading')}</p>
                </div>
            </div>
        );
    }

    return (
        <div className="mx-auto max-w-3xl space-y-4 2xl:max-w-[1200px]">
            {error ? (
                <div className="rounded-input border border-danger/30 bg-danger/10 px-4 py-3 text-caption text-danger">{error}</div>
            ) : null}
            {/* Header */}
            <div className="flex items-center gap-3">
                <button
                    type="button"
                    onClick={() => navigate('/lists')}
                    aria-label={t('lists:list.back')}
                    className="flex min-h-11 min-w-11 items-center justify-center rounded-full hover:bg-surface-2 transition-colors"
                >
                    <ChevronLeft className="h-5 w-5" />
                </button>
                <span className="text-3xl" aria-hidden="true">{list?.icon ?? '📝'}</span>
                <div className="min-w-0 flex-1">
                    <h2 className="text-h1 truncate">{list?.name ?? '…'}</h2>
                    <p className="text-micro text-muted-foreground">
                        {t('lists:counts.items', { count: items.length })}
                    </p>
                </div>
                {/* Labelled toggle: visible text + aria-label with the on/off state. */}
                <div className="flex min-h-11 items-center gap-3">
                    <span className="text-body-sm text-foreground">
                        {t('lists:list.showChecked')}
                    </span>
                    <button
                        type="button"
                        role="switch"
                        aria-checked={showChecked}
                        aria-label={`${t('lists:list.showChecked')} — ${showChecked ? t('common:states.on') : t('common:states.off')}`}
                        title={`${t('lists:list.showChecked')} — ${showChecked ? t('common:states.on') : t('common:states.off')}`}
                        onClick={toggleShowChecked}
                        className={cn(
                            'relative -m-2 h-7 w-12 shrink-0 rounded-full p-2 transition-colors',
                            showChecked ? 'bg-primary' : 'border border-border bg-surface-2'
                        )}
                    >
                        <span
                            className={cn(
                                'absolute top-1 h-5 w-5 rounded-full bg-white shadow transition-all',
                                showChecked ? 'left-6' : 'left-1'
                            )}
                        />
                    </button>
                </div>
            </div>

            {/* Add row */}
            <Card>
                <CardContent className="p-3">
                    <form onSubmit={handleAdd} className="flex flex-col gap-2 sm:flex-row sm:items-end">
                        <div className="flex-1">
                            <Input
                                label={t('lists:list.add')}
                                value={newText}
                                onChange={(e) => setNewText(e.target.value)}
                                placeholder={t('lists:list.addPlaceholder')}
                                maxLength={LIST_ITEM_TEXT_MAX}
                            />
                        </div>
                        <div className="sm:w-56">
                            <CategorySelect
                                label={t('lists:list.category.label')}
                                value={newCategory}
                                customValue={newCategoryCustom}
                                existing={existingCategories}
                                onChange={setNewCategory}
                                onCustomChange={setNewCategoryCustom}
                            />
                        </div>
                        <Button type="submit" disabled={!newText.trim()}>
                            <Plus className="w-4 h-4 mr-1" />
                            {t('lists:list.add')}
                        </Button>
                    </form>
                </CardContent>
            </Card>

            {/* Categories */}
            {grouped.length === 0 ? (
                <Card>
                    <CardContent className="p-6 text-center text-muted-foreground text-body">
                        {t('lists:list.empty')}
                    </CardContent>
                </Card>
            ) : (
                grouped.map((group) => {
                    const isCollapsed = collapsed.includes(group.key);
                    const count = catCountOf(group.key);
                    const visible = showChecked ? group.items : group.items.filter((i) => !i.checked);
                    return (
                        <Card key={group.key}>
                            <button
                                type="button"
                                onClick={() => toggleCollapsed(group.key)}
                                aria-expanded={!isCollapsed}
                                className="flex min-h-11 w-full items-center gap-2 px-4 py-3 text-left hover:bg-surface-2/40 transition-colors"
                            >
                                <ChevronDown
                                    className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', isCollapsed && '-rotate-90')}
                                />
                                <span className="flex-1 font-medium text-foreground truncate">
                                    {group.name ?? t('lists:list.category.none')}
                                </span>
                                <span className="text-micro text-muted-foreground shrink-0">
                                    {count.unchecked}/{count.total}
                                </span>
                                {/* G2: menu « … » sur TOUTES les lignes, y compris le seau
                                    virtuel « Sans catégorie » (aligne padding/hauteur/chevron).
                                    Le seau NULL n'a qu'un « Renommer » — jamais « Supprimer ». */}
                                {isParent && (
                                    <span onClick={(e) => e.stopPropagation()}>
                                        <Menu
                                            label={`${group.name ?? t('lists:list.category.none')} — ${t('lists:list.categoryMenu.rename')}`}
                                            items={[
                                                {
                                                    key: 'rename',
                                                    label: t('lists:list.categoryMenu.rename'),
                                                    icon: <Pencil className="h-4 w-4" />,
                                                    onClick: () => { setRenameCat(group.name); setRenameCatTo(group.name ?? ''); },
                                                },
                                                ...(group.name !== null ? [{
                                                    key: 'delete' as const,
                                                    label: t('lists:list.categoryMenu.delete'),
                                                    icon: <Trash2 className="h-4 w-4" />,
                                                    danger: true as const,
                                                    onClick: () => { void handleDeleteCategory(group.name!); },
                                                }] : []),
                                            ]}
                                        />
                                    </span>
                                )}
                            </button>
                            {!isCollapsed && (
                                <CardContent className="p-0">
                                    {visible.length === 0 ? (
                                        <p className="px-4 py-3 text-micro text-muted-foreground">
                                            {showChecked ? t('lists:list.empty') : t('lists:list.hideChecked')}
                                        </p>
                                    ) : (
                                        <ul className="divide-y divide-border">
                                            {visible.map((item, idx) => (
                                                <li key={item.id} className={cn('flex items-center gap-2 px-2 py-1', item.checked && 'opacity-50')}>
                                                    {/* Touch target ≥ 44 px on the button; the drawn box is
                                                        h-4 w-4 like the design-system checkbox (Tasks module). */}
                                                    <button
                                                        type="button"
                                                        role="checkbox"
                                                        aria-checked={item.checked}
                                                        aria-label={item.text}
                                                        onClick={() => { void handleToggleChecked(item); }}
                                                        className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-surface-2"
                                                    >
                                                        <span
                                                            className={cn(
                                                                'flex h-4 w-4 items-center justify-center rounded border-2 transition-colors',
                                                                item.checked
                                                                    ? 'border-success bg-success text-white'
                                                                    : 'border-border bg-transparent'
                                                            )}
                                                        >
                                                            {item.checked && <Check className="h-3 w-3" />}
                                                        </span>
                                                    </button>
                                                    <span
                                                        className={cn(
                                                            'flex-1 text-body-sm truncate',
                                                            item.checked ? 'text-muted-foreground line-through' : 'text-foreground'
                                                        )}
                                                    >
                                                        {item.text}
                                                    </span>
                                                    {/* Reorder one step within the category
                                                        (persisted server-side). Disabled at the
                                                        category edges; the neighbour always shares
                                                        the same checked state, matching the display. */}
                                                    <button
                                                        type="button"
                                                        aria-label={t('lists:list.moveUp', { text: item.text })}
                                                        title={t('lists:list.moveUp', { text: item.text })}
                                                        disabled={idx === 0}
                                                        onClick={() => { void handleMoveItem(item, 'up'); }}
                                                        className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-30"
                                                    >
                                                        <ChevronUp className="h-4 w-4" />
                                                    </button>
                                                    <button
                                                        type="button"
                                                        aria-label={t('lists:list.moveDown', { text: item.text })}
                                                        title={t('lists:list.moveDown', { text: item.text })}
                                                        disabled={idx === visible.length - 1}
                                                        onClick={() => { void handleMoveItem(item, 'down'); }}
                                                        className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-30"
                                                    >
                                                        <ChevronDown className="h-4 w-4" />
                                                    </button>
                                                    <Menu
                                                        label={item.text}
                                                        items={[
                                                            { key: 'edit', label: t('lists:list.itemMenu.edit'), icon: <Pencil className="h-4 w-4" />, onClick: () => openEditItem(item) },
                                                            { key: 'delete', label: t('lists:list.itemMenu.delete'), icon: <Trash2 className="h-4 w-4" />, danger: true, onClick: () => { void handleDeleteItem(item); } },
                                                        ]}
                                                    />
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                </CardContent>
                            )}
                        </Card>
                    );
                })
            )}

            {/* Edit item sheet */}
            <Sheet open={editItem !== null} dismissible={false} onClose={() => setEditItem(null)} title={t('lists:list.editItem.title')}>
                <form onSubmit={submitEditItem} className="space-y-4">
                    <Input
                        label={t('lists:list.editItem.textLabel')}
                        value={editText}
                        onChange={(e) => setEditText(e.target.value)}
                        maxLength={LIST_ITEM_TEXT_MAX}
                        required
                        autoFocus
                    />
                    <CategorySelect
                        id="edit-item-category"
                        label={t('lists:list.editItem.categoryLabel')}
                        value={editCategory}
                        customValue={editCategoryCustom}
                        existing={existingCategories}
                        onChange={setEditCategory}
                        onCustomChange={setEditCategoryCustom}
                    />
                    <div className="flex justify-end gap-3 pt-2">
                        <Button type="button" variant="secondary" onClick={() => setEditItem(null)}>
                            {t('common:actions.cancel')}
                        </Button>
                        <Button type="submit">{t('lists:list.editItem.submit')}</Button>
                    </div>
                </form>
            </Sheet>

            {/* Rename category sheet */}
            <Sheet
                open={renameCat !== null}
                dismissible={false}
                onClose={() => setRenameCat(null)}
                title={t('lists:list.renameCategory.title', { from: renameCat ?? t('lists:list.category.none') })}
            >
                <form onSubmit={handleRenameCategory} className="space-y-4">
                    <Input
                        label={t('lists:list.renameCategory.toLabel')}
                        value={renameCatTo}
                        onChange={(e) => setRenameCatTo(e.target.value)}
                        maxLength={LIST_CATEGORY_MAX}
                        required
                        autoFocus
                    />
                    <div className="flex justify-end gap-3 pt-2">
                        <Button type="button" variant="secondary" onClick={() => setRenameCat(null)}>
                            {t('common:actions.cancel')}
                        </Button>
                        <Button type="submit">{t('lists:list.renameCategory.submit')}</Button>
                    </div>
                </form>
            </Sheet>
        </div>
    );
};

export default Lists;
