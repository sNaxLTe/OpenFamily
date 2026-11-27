import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useWebSocketUpdates } from '../hooks/useWebSocketUpdates';
import { api } from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import { cn, formatCurrency } from '../lib/utils';
import { intlLocale } from '../i18n/format';
import { Plus, Trash2, Check, ShoppingBag, Save, ListChecks, Store, ChevronLeft, ChevronDown, Minus, MoreVertical, Pencil, X } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Dialog, useToast } from '../components/ui';
import { useCategories } from '../hooks/useCategories';
import { SHOPPING_CATALOG } from '../lib/shoppingCatalog';
import { friendlyApiError } from '../lib/friendlyError';
import { useHistoryAwareOverlay } from '../lib/useHistoryAwareOverlay';
import { LIST_ICONS, SHOPPING_STORE_NAME_MAX } from '@openfamily/shared';

// Quantities come back from the database as "2.00": show 2, 1,5, 0,25.
const formatQty = (q: number | string) =>
    new Intl.NumberFormat(intlLocale(), { maximumFractionDigits: 2 }).format(Number(q));

interface ShoppingItem {
    id: string;
    name: string;
    category: string;
    quantity?: number;
    unit?: string;
    price?: number;
    is_checked: boolean;
    notes?: string;
    /** Shopping store tab (annual/0010) : null/undefined = onglet « Général ». */
    store_id?: string | null;
}

/** A shopping store = one tab on the Shopping page (annual/0010). */
interface ShoppingStore {
    id: string;
    name: string;
    icon: string;
    position: number;
    created_at?: string;
}

interface ShoppingTemplate {
    id: string;
    name: string;
    items: Array<{
        name: string;
        category: string;
        quantity?: number;
        unit?: string;
        price?: number;
        notes?: string;
    }>;
}

const parseOptionalPositiveNumber = (value: string): number | undefined => {
    const trimmed = value.trim();
    if (!trimmed) {
        return undefined;
    }

    const parsed = Number(trimmed.replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : Number.NaN;
};

/** History-aware bottom sheet (same pattern as the Lists module's Sheet).
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
    // depend only on `open`, so the effect runs ONCE when the sheet opens —
    // otherwise titleRef.focus() would re-fire on every keystroke and steal
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

/**
 * A "…" menu: a ≥ 44 px button opening a popover of ≥ 44 px actions.
 * The popover is PORTALED to <body> with position:fixed: the trigger lives
 * inside the horizontally scrollable tab bar (overflow-x-auto), and an
 * in-flow absolute popover there would be clipped (overflow-x non-visible
 * forces overflow-y to auto) — the menu would open but stay invisible,
 * which read as "the tap does nothing" on iOS. Fixed coordinates are taken
 * from the button's rect at open time; any scroll/resize closes the menu.
 */
const Menu: React.FC<{
    label: string;
    items: Array<{ key: string; label: string; icon?: React.ReactNode; danger?: boolean; onClick: () => void }>;
}> = ({ label, items }) => {
    const [open, setOpen] = useState(false);
    const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
    const ref = useRef<HTMLDivElement>(null);
    const btnRef = useRef<HTMLButtonElement>(null);
    const popRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!open) return;
        const onDoc = (e: MouseEvent | TouchEvent) => {
            const target = e.target as Node;
            if (ref.current?.contains(target) || popRef.current?.contains(target)) return;
            setOpen(false);
        };
        const onMove = () => setOpen(false);
        document.addEventListener('mousedown', onDoc);
        document.addEventListener('touchstart', onDoc);
        window.addEventListener('scroll', onMove, true);
        window.addEventListener('resize', onMove);
        return () => {
            document.removeEventListener('mousedown', onDoc);
            document.removeEventListener('touchstart', onDoc);
            window.removeEventListener('scroll', onMove, true);
            window.removeEventListener('resize', onMove);
        };
    }, [open]);
    const toggle = () => {
        if (open) { setOpen(false); return; }
        const rect = btnRef.current?.getBoundingClientRect();
        if (rect) {
            setPos({ top: rect.bottom + 4, right: Math.max(8, window.innerWidth - rect.right) });
        }
        setOpen(true);
    };
    return (
        <div className="relative" ref={ref}>
            <button
                ref={btnRef}
                type="button"
                aria-label={label}
                aria-expanded={open}
                onClick={(e) => { e.stopPropagation(); toggle(); }}
                // Smaller visible button (h-9 w-9) but the negative margin
                // keeps the touch target ≥ 44 px (same pattern as the item
                // checkboxes of this page).
                className="-m-1.5 flex h-9 w-9 items-center justify-center rounded-full hover:bg-surface-2 transition-colors"
            >
                <MoreVertical className="h-4 w-4 text-muted-foreground" />
            </button>
            {open && pos && createPortal(
                <div
                    ref={popRef}
                    role="menu"
                    aria-label={label}
                    className="fixed z-50 w-56 rounded-card border border-border bg-popover shadow-surface-hover overflow-hidden"
                    style={{ top: pos.top, right: pos.right }}
                >
                    {items.map((item) => (
                        <button
                            key={item.key}
                            type="button"
                            role="menuitem"
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
                </div>,
                document.body
            )}
        </div>
    );
};

/** The fixed store icon grid (LIST_ICONS), every cell a ≥ 44 px target. */
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

const ShoppingList: React.FC = () => {
    const { t } = useTranslation(['shopping', 'common']);
    const categoryLabel = (value: string) => t(`shopping:categories.${value}`, { defaultValue: value });
    const { user } = useAuth();
    const currency = user?.currency || 'EUR';
    // Family-customizable category list (Settings → Categories).
    const { categories: familyCategories } = useCategories();
    const categories = familyCategories.shopping;
    const { showToast } = useToast();
    const isParent = Boolean(user?.is_owner) || user?.role !== 'enfant';
    const [items, setItems] = useState<ShoppingItem[]>([]);
    const [templates, setTemplates] = useState<ShoppingTemplate[]>([]);
    // Shopping stores = tabs (annual/0010). '' = onglet « Général ».
    const [stores, setStores] = useState<ShoppingStore[]>([]);
    const tabKey = `openfamily.shoppingTab.${user?.id ?? 'anon'}`;
    const [activeTab, setActiveTab] = useState<string>(() => {
        try { return localStorage.getItem(tabKey) ?? ''; } catch { return ''; }
    });
    const [storeSheet, setStoreSheet] = useState<null | { mode: 'create' } | { mode: 'edit'; store: ShoppingStore }>(null);
    const [storeName, setStoreName] = useState('');
    const [storeIcon, setStoreIcon] = useState('🛒');
    // Item edit sheet (store dropdown only: moving between stores).
    const [editingItem, setEditingItem] = useState<ShoppingItem | null>(null);
    const [editItemStore, setEditItemStore] = useState('');
    const [selectedTemplateId, setSelectedTemplateId] = useState('');
    const [templateName, setTemplateName] = useState('');
    const [newItem, setNewItem] = useState({
        name: '',
        category: 'Alimentation',
        quantity: '',
        price: '',
        unit: '',
    });
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [templateDialogOpen, setTemplateDialogOpen] = useState(false);
    const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(new Set());
    const [storeMode, setStoreMode] = useState(false);
    // Which item's quantity is being edited inline, and the value being typed.
    const [editingQuantityId, setEditingQuantityId] = useState<string | null>(null);
    const [quantityDraft, setQuantityDraft] = useState('');
    // D2: panneau de détails de l'item (catégorie/qteo/prix) replié par défaut.
    const [expandedItems, setExpandedItems] = useState<ReadonlySet<string>>(new Set());

    useEffect(() => {
        void Promise.all([loadItems(), loadTemplates(), loadStores()]).finally(() => setLoading(false));
    }, []);

    // If the family's custom list doesn't contain the form's current category
    // (custom lists load async, or a category was renamed/removed), realign it.
    useEffect(() => {
        setNewItem((prev) => (categories.includes(prev.category) ? prev : { ...prev, category: categories[0] }));
    }, [categories]);
    useWebSocketUpdates('shopping', () => { void loadItems(); void loadStores(); });

    const loadItems = async () => {
        try {
            const response = await api.get<{ success: boolean; data: ShoppingItem[] }>('/api/shopping');
            if (response.success) {
                setItems(response.data);
            }
        } catch (err) {
            console.error('Failed to load shopping items:', err);
            setError(err instanceof Error ? err.message : t('shopping:errors.loadItems'));
        }
    };

    const loadStores = async () => {
        try {
            const response = await api.get<{ success: boolean; data: ShoppingStore[] }>('/api/shopping/stores');
            if (response.success) {
                setStores(response.data);
            }
        } catch (err) {
            console.error('Failed to load shopping stores:', err);
            setError(friendlyApiError(err, t, 'shopping:stores.errors.loadStores'));
        }
    };

    // Last active tab, per account and per device. A stored tab whose store
    // was deleted falls back to "Général".
    const effectiveTab = useMemo(() => {
        if (!activeTab) return '';
        return stores.some((s) => s.id === activeTab) ? activeTab : '';
    }, [activeTab, stores]);

    const selectTab = (tabId: string) => {
        setActiveTab(tabId);
        try { localStorage.setItem(tabKey, tabId); } catch { /* private mode */ }
    };

    // Items of the active tab: '' = "Général" = items without a store.
    // With zero stores every item has store_id NULL → the page is exactly
    // the pre-stores one (no tab bar rendered either).
    const visibleItems = useMemo(() => {
        if (!effectiveTab) return items.filter((i) => !i.store_id);
        return items.filter((i) => i.store_id === effectiveTab);
    }, [items, effectiveTab]);

    const uncheckedInTab = (tabId: string) =>
        (tabId === '' ? items.filter((i) => !i.store_id) : items.filter((i) => i.store_id === tabId))
            .filter((i) => !i.is_checked).length;

    // ─── Stores (parents manage them) ────────────────────────────────────────

    const openCreateStore = () => {
        setStoreName('');
        setStoreIcon('🛒');
        setStoreSheet({ mode: 'create' });
    };
    const openEditStore = (store: ShoppingStore) => {
        setStoreName(store.name);
        setStoreIcon(store.icon);
        setStoreSheet({ mode: 'edit', store });
    };

    const submitStoreSheet = async (e: React.FormEvent) => {
        e.preventDefault();
        const name = storeName.trim();
        if (!name || name.length > SHOPPING_STORE_NAME_MAX) {
            setError(t('shopping:stores.errors.nameRequired'));
            return;
        }
        try {
            if (storeSheet?.mode === 'edit') {
                await api.put(`/api/shopping/stores/${storeSheet.store.id}`, { name, icon: storeIcon });
                showToast({ title: t('shopping:stores.editTitle'), description: name });
            } else {
                await api.post('/api/shopping/stores', { name, icon: storeIcon });
                showToast({ title: t('shopping:stores.newTitle'), description: name });
            }
            setStoreSheet(null);
            await loadStores();
        } catch (err) {
            console.error('Failed to save store:', err);
            setError(friendlyApiError(err, t, 'shopping:stores.errors.saveStore'));
        }
    };

    const deleteStore = async (store: ShoppingStore) => {
        if (!confirm(t('shopping:stores.deleteConfirm', { name: store.name }))) return;
        try {
            await api.delete(`/api/shopping/stores/${store.id}`);
            showToast({ title: t('shopping:stores.delete'), description: store.name });
            if (effectiveTab === store.id) selectTab('');
            await Promise.all([loadStores(), loadItems()]);
        } catch (err) {
            console.error('Failed to delete store:', err);
            setError(friendlyApiError(err, t, 'shopping:stores.errors.deleteStore'));
        }
    };

    // ─── Item edit sheet (move the item between stores) ─────────────────────

    const openEditItem = (item: ShoppingItem) => {
        setEditingItem(item);
        setEditItemStore(item.store_id ?? '');
    };

    const submitEditItem = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!editingItem) return;
        try {
            await api.put(`/api/shopping/${editingItem.id}`, { store_id: editItemStore || null });
            setEditingItem(null);
            await loadItems();
        } catch (err) {
            console.error('Failed to move item:', err);
            setError(friendlyApiError(err, t, 'shopping:stores.errors.saveItem'));
        }
    };

    const loadTemplates = async () => {
        try {
            const response = await api.get<{ success: boolean; data: ShoppingTemplate[] }>('/api/shopping/templates');
            if (response.success) {
                setTemplates(response.data);
            }
        } catch (err) {
            console.error('Failed to load templates:', err);
            setError(err instanceof Error ? err.message : t('shopping:errors.loadTemplates'));
        }
    };

    const addItem = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');

        if (!newItem.name.trim()) {
            setError(t('shopping:errors.nameRequired'));
            return;
        }

        const quantity = parseOptionalPositiveNumber(newItem.quantity);
        const price = parseOptionalPositiveNumber(newItem.price);

        if (quantity !== undefined && (!Number.isFinite(quantity) || quantity <= 0)) {
            setError(t('shopping:errors.quantityInvalid'));
            return;
        }

        if (price !== undefined && (!Number.isFinite(price) || price < 0)) {
            setError(t('shopping:errors.priceInvalid'));
            return;
        }

        try {
            const response = await api.post<{ success: boolean; data: ShoppingItem }>('/api/shopping', {
                name: newItem.name,
                category: newItem.category,
                quantity,
                price,
                unit: newItem.unit || null,
                // An item created from a store tab lands in that store; from
                // "Général" (or with no stores at all) it stays in Général.
                store_id: effectiveTab || null,
            });

            if (response.success) {
                setItems((prev) => [response.data, ...prev]);
                setNewItem({ name: '', category: categories[0], quantity: '', price: '', unit: '' });
            }
        } catch (err) {
            console.error('Failed to add item:', err);
            setError(err instanceof Error ? err.message : t('shopping:errors.addFailed'));
        }
    };

    const toggleItem = async (item: ShoppingItem) => {
        setError('');
        try {
            const response = await api.put<{ success: boolean; data: ShoppingItem }>(`/api/shopping/${item.id}`, {
                is_checked: !item.is_checked,
            });
            if (response.success) {
                setItems((prev) => prev.map((current) => (current.id === item.id ? response.data : current)));
            }
        } catch (err) {
            console.error('Failed to toggle item:', err);
            setError(err instanceof Error ? err.message : t('shopping:errors.toggleFailed'));
        }
    };

    const deleteItem = async (id: string) => {
        if (!confirm(t('shopping:confirmDeleteItem'))) return;
        setError('');
        try {
            await api.delete(`/api/shopping/${id}`);
            setItems((prev) => prev.filter((item) => item.id !== id));
        } catch (err) {
            console.error('Failed to delete item:', err);
            setError(err instanceof Error ? err.message : t('shopping:errors.deleteFailed'));
        }
    };

    /**
     * Quantity of an item already on the list. A quantity that reaches zero is
     * cleared rather than stored, so the item reads as "bread" and not "bread,
     * 0", which is what you want when you stop counting rather than when you
     * want none of it.
     */
    const setItemQuantity = async (item: ShoppingItem, raw: string) => {
        const trimmed = raw.trim();
        const parsed = trimmed === '' ? null : Number(trimmed.replace(',', '.'));

        if (parsed !== null && (!Number.isFinite(parsed) || parsed < 0)) {
            setError(t('shopping:errors.quantityInvalid'));
            return;
        }

        const next = parsed === null || parsed === 0 ? null : parsed;
        if ((item.quantity ?? null) === next) {
            return;
        }

        setError('');
        // Optimistic: the row is under the finger, so it has to answer at once.
        setItems((prev) => prev.map((c) => (c.id === item.id ? { ...c, quantity: next ?? undefined } : c)));

        try {
            const response = await api.put<{ success: boolean; data: ShoppingItem }>(
                `/api/shopping/${item.id}`,
                { quantity: next === null ? '' : next }
            );
            if (response.success) {
                setItems((prev) => prev.map((c) => (c.id === item.id ? response.data : c)));
            }
        } catch (err) {
            console.error('Failed to update quantity:', err);
            setItems((prev) => prev.map((c) => (c.id === item.id ? item : c)));
            setError(err instanceof Error ? err.message : t('shopping:errors.updateFailed'));
        }
    };

    /**
     * Steps the draft, not the saved value. The buttons sit next to the input,
     * so acting on the item directly would race the blur handler that saves what
     * was typed. One value changes, one save, on blur or Enter.
     */
    const stepDraft = (delta: number) => {
        setQuantityDraft((prev) => {
            const current = Number(prev.replace(',', '.'));
            const base = Number.isFinite(current) ? current : 0;
            const next = Math.max(0, Math.round((base + delta) * 100) / 100);
            return next === 0 ? '' : String(next);
        });
    };

    const clearCheckedItems = async () => {
        if (!confirm(t('shopping:confirmClearChecked'))) return;
        setError('');
        try {
            await api.delete('/api/shopping/checked/clear');
            setItems((prev) => prev.filter((item) => !item.is_checked));
        } catch (err) {
            console.error('Failed to clear checked items:', err);
            setError(err instanceof Error ? err.message : t('shopping:errors.clearFailed'));
        }
    };

    const openTemplateDialog = () => {
        setError('');
        if (items.length === 0) {
            setError(t('shopping:errors.noItemsForTemplate'));
            return;
        }
        // Pre-select all items by default
        setSelectedItemIds(new Set(items.map((item) => item.id)));
        setTemplateDialogOpen(true);
    };

    const toggleItemSelection = (id: string) => {
        setSelectedItemIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const selectByCategory = (category: string) => {
        setSelectedItemIds((prev) => {
            const next = new Set(prev);
            items.filter((item) => item.category === category).forEach((item) => next.add(item.id));
            return next;
        });
    };

    const deselectByCategory = (category: string) => {
        setSelectedItemIds((prev) => {
            const next = new Set(prev);
            items.filter((item) => item.category === category).forEach((item) => next.delete(item.id));
            return next;
        });
    };

    const saveTemplateFromDialog = async () => {
        setError('');
        const name = templateName.trim();
        if (!name) {
            setError(t('shopping:errors.templateNameRequired'));
            return;
        }

        const templateItems = items
            .filter((item) => selectedItemIds.has(item.id))
            .map((item) => ({
                name: item.name,
                category: item.category,
                quantity: item.quantity,
                unit: item.unit,
                price: item.price,
                notes: item.notes,
            }));

        if (templateItems.length === 0) {
            setError(t('shopping:errors.selectAtLeastOne'));
            return;
        }

        try {
            await api.post('/api/shopping/templates', {
                name,
                items: templateItems,
            });
            setTemplateName('');
            setTemplateDialogOpen(false);
            setSelectedItemIds(new Set());
            await loadTemplates();
        } catch (err) {
            console.error('Failed to save template:', err);
            setError(err instanceof Error ? err.message : t('shopping:errors.saveTemplateFailed'));
        }
    };

    const applyTemplate = async () => {
        setError('');
        if (!selectedTemplateId) {
            setError(t('shopping:errors.selectTemplateApply'));
            return;
        }

        try {
            await api.post(`/api/shopping/templates/${selectedTemplateId}/apply`, {});
            await loadItems();
        } catch (err) {
            console.error('Failed to apply template:', err);
            setError(err instanceof Error ? err.message : t('shopping:errors.applyTemplateFailed'));
        }
    };

    const deleteTemplate = async () => {
        setError('');
        if (!selectedTemplateId) {
            setError(t('shopping:errors.selectTemplateDelete'));
            return;
        }

        try {
            await api.delete(`/api/shopping/templates/${selectedTemplateId}`);
            setSelectedTemplateId('');
            await loadTemplates();
        } catch (err) {
            console.error('Failed to delete template:', err);
            setError(err instanceof Error ? err.message : t('shopping:errors.deleteTemplateFailed'));
        }
    };

    const pendingItems = useMemo(() => visibleItems.filter((item) => !item.is_checked), [visibleItems]);
    const completedItems = useMemo(() => visibleItems.filter((item) => item.is_checked), [visibleItems]);

    /**
     * Ready-made items to add in one tap. Filtered by what has been typed, and
     * hiding anything already on the list so a suggestion never produces a
     * duplicate line.
     */
    const suggestions = useMemo(() => {
        const typed = newItem.name.trim().toLowerCase();
        const onList = new Set(items.map((item) => item.name.trim().toLowerCase()));

        const matches = SHOPPING_CATALOG
            .map((entry) => ({
                ...entry,
                label: t(`shopping:catalog.${entry.key}`, { defaultValue: entry.key }),
            }))
            .filter(({ label }) => {
                const lower = label.toLowerCase();
                if (onList.has(lower)) return false;
                return typed === '' || lower.includes(typed);
            });

        return matches.slice(0, typed === '' ? 8 : 6);
    }, [newItem.name, items, t]);

    const applySuggestion = (label: string, category: string) => {
        setNewItem((prev) => ({
            ...prev,
            name: label,
            // A family that renamed or removed the suggested category keeps
            // whatever is already selected rather than getting an invalid one.
            category: categories.includes(category) ? category : prev.category,
        }));
    };

    // Store mode: group every item by category (aisle), keeping checked ones for context.
    const itemsByAisle = useMemo(() => {
        const groups = new Map<string, ShoppingItem[]>();
        for (const cat of categories) groups.set(cat, []);
        // Items whose category is not in the family's (customizable) list fall back
        // to "Autre" when it exists, otherwise to a trailing catch-all group.
        const fallback = groups.has('Autre') ? 'Autre' : categories[categories.length - 1];
        for (const item of visibleItems) {
            const cat = groups.has(item.category) ? item.category : fallback;
            groups.get(cat)!.push(item);
        }
        return Array.from(groups.entries())
            .filter(([, list]) => list.length > 0)
            .map(([category, list]) => ({
                category,
                list: [...list].sort((a, b) => Number(a.is_checked) - Number(b.is_checked)),
            }));
    }, [visibleItems, categories]);

    const totalPrice = useMemo(() => {
        return pendingItems.reduce((sum, item) => {
            const quantity = item.quantity && item.quantity > 0 ? item.quantity : 1;
            const price = item.price || 0;
            return sum + quantity * price;
        }, 0);
    }, [pendingItems]);

    if (loading) {
        return (
            <div className="flex h-full min-h-[50vh] items-center justify-center">
                <div className="flex flex-col items-center gap-4">
                    <div className="spinner-brand" />
                    <p className="animate-pulse font-medium text-muted-foreground">{t('shopping:loading')}</p>
                </div>
            </div>
        );
    }

    // ─── Mode magasin ───────────────────────────────────────────────────────────
    if (storeMode) {
        const remaining = pendingItems.length;
        const total = visibleItems.length;
        const done = total - remaining;
        return (
            <div className="mx-auto max-w-2xl space-y-4 pb-28">
                <div className="sticky top-0 z-20 -mx-4 flex items-center gap-3 border-b border-border bg-background/90 px-4 py-3 backdrop-blur-md">
                    <Button variant="ghost" size="sm" onClick={() => setStoreMode(false)}>
                        <ChevronLeft className="h-5 w-5" />
                    </Button>
                    <div className="flex-1">
                        <h2 className="flex items-center gap-2 text-h2 font-semibold text-foreground">
                            <Store className="h-5 w-5 text-primary" /> {t('shopping:storeMode.title')}
                        </h2>
                        <p className="text-caption text-muted-foreground">
                            {t('shopping:storeMode.cart', { done, total })} · {t('shopping:storeMode.remaining', { count: remaining })}
                        </p>
                    </div>
                </div>

                {total === 0 ? (
                    <div className="rounded-card border border-dashed border-border bg-card py-16 text-center">
                        <ShoppingBag className="mx-auto mb-3 h-12 w-12 text-muted-foreground/30" />
                        <p className="text-body font-semibold text-foreground">{t('shopping:storeMode.emptyList')}</p>
                    </div>
                ) : (
                    itemsByAisle.map(({ category, list }) => (
                        <section key={category}>
                            <h2 className="mb-2 px-1 text-caption font-semibold uppercase tracking-wide text-muted-foreground">
                                {categoryLabel(category)}
                            </h2>
                            <div className="space-y-2">
                                {list.map((item) => (
                                    <button
                                        key={item.id}
                                        type="button"
                                        onClick={() => toggleItem(item)}
                                        className={`flex w-full items-center gap-4 rounded-card border p-4 text-left transition-all active:scale-[0.99] ${
                                            item.is_checked
                                                ? 'border-border bg-muted/30 opacity-60'
                                                : 'border-border bg-card shadow-surface'
                                        }`}
                                    >
                                        <span
                                            className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full border-2 ${
                                                item.is_checked ? 'border-primary bg-primary' : 'border-input'
                                            }`}
                                        >
                                            {item.is_checked && <Check className="h-5 w-5 text-white" strokeWidth={3} />}
                                        </span>
                                        <span className="min-w-0 flex-1">
                                            <span className={`block truncate text-body font-medium ${item.is_checked ? 'text-muted-foreground line-through' : 'text-foreground'}`}>
                                                {item.name}
                                            </span>
                                            {(item.quantity || item.price) && (
                                                <span className="mt-0.5 flex items-center gap-2 text-micro text-muted-foreground">
                                                    {item.quantity ? <span>{t('shopping:qty')}: {formatQty(item.quantity)}{item.unit ? ` ${item.unit}` : ''}</span> : null}
                                                    {item.price ? <span>{formatCurrency(Number(item.price), currency)}</span> : null}
                                                </span>
                                            )}
                                        </span>
                                    </button>
                                ))}
                            </div>
                        </section>
                    ))
                )}
            </div>
        );
    }

    return (
        <div className="mx-auto max-w-4xl space-y-6 xl:max-w-7xl">
            {error ? (
                <div className="rounded-input border border-danger/30 bg-danger/10 px-4 py-3 text-caption text-danger">
                    {error}
                </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-3">
                <div className="rounded-card bg-primary-soft p-3 text-primary">
                    <ShoppingBag className="h-7 w-7" />
                </div>
                <div className="flex-1">
                    <h2 className="text-h1 text-foreground">{t('shopping:header.title')}</h2>
                    <p className="text-body text-muted-foreground">{t('shopping:header.remaining', { count: pendingItems.length })}</p>
                </div>
                {visibleItems.length > 0 && (
                    <Button onClick={() => setStoreMode(true)}>
                        <Store className="mr-1 h-4 w-4" />
                        {t('shopping:storeMode.enter')}
                    </Button>
                )}
            </div>

            {/* Store tabs (annual/0010): rendered when at least one store exists
                OR when the user is a parent — with zero stores a parent still
                sees "Général | +" so there is an entry point to create the FIRST
                store (otherwise the "+" chip would be unreachable). Children
                with zero stores get strictly the upstream page (no bar at all). */}
            {(stores.length > 0 || isParent) && (
                <div
                    role="tablist"
                    aria-label={t('shopping:stores.tabsLabel')}
                    className="-mx-1 flex items-center gap-2 overflow-x-auto px-1 pb-1"
                >
                    <button
                        type="button"
                        role="tab"
                        aria-selected={effectiveTab === ''}
                        onClick={() => selectTab('')}
                        aria-label={`${t('shopping:stores.general')} — ${t('shopping:stores.remaining', { count: uncheckedInTab('') })}`}
                        className={cn(
                            'flex min-h-11 shrink-0 items-center gap-1.5 rounded-pill border px-3 text-caption transition-colors',
                            effectiveTab === ''
                                ? 'border-primary bg-primary-soft font-medium text-primary'
                                : 'border-border bg-card text-foreground hover:bg-surface-2'
                        )}
                    >
                        {t('shopping:stores.general')}
                        {uncheckedInTab('') > 0 && (
                            <span className="rounded-pill bg-surface-2 px-1.5 text-micro text-muted-foreground">{uncheckedInTab('')}</span>
                        )}
                    </button>
                    {stores.map((store) => {
                        const remaining = uncheckedInTab(store.id);
                        const active = effectiveTab === store.id;
                        // One single pill per store: full border + rounded both
                        // sides, active state (accent border + bg) on the WHOLE
                        // pill. The "…" menu button lives INSIDE the pill, right
                        // of the name (a <button> cannot nest in a <button>, so
                        // the pill is a div and the tab zone is the inner
                        // button). Children: same pill without the menu and
                        // without residual right padding.
                        return (
                            <div
                                key={store.id}
                                className={cn(
                                    'flex min-h-11 shrink-0 items-center rounded-pill border transition-colors',
                                    isParent ? 'pr-2' : '',
                                    active
                                        ? 'border-primary bg-primary-soft'
                                        : 'border-border bg-card hover:bg-surface-2'
                                )}
                            >
                                <button
                                    type="button"
                                    role="tab"
                                    aria-selected={active}
                                    onClick={() => selectTab(store.id)}
                                    aria-label={`${store.name} — ${t('shopping:stores.remaining', { count: remaining })}`}
                                    className={cn(
                                        'flex min-h-11 items-center gap-1.5 pl-3 pr-3 text-caption',
                                        active ? 'font-medium text-primary' : 'text-foreground'
                                    )}
                                >
                                    <span aria-hidden="true">{store.icon}</span>
                                    <span className="max-w-32 truncate">{store.name}</span>
                                    {remaining > 0 && (
                                        <span className="rounded-pill bg-surface-2 px-1.5 text-micro text-muted-foreground">{remaining}</span>
                                    )}
                                </button>
                                {isParent && (
                                    <Menu
                                        label={t('shopping:stores.menuLabel', { name: store.name })}
                                        items={[
                                            { key: 'rename', label: t('shopping:stores.rename'), icon: <Pencil className="h-4 w-4" />, onClick: () => openEditStore(store) },
                                            { key: 'delete', label: t('shopping:stores.delete'), icon: <Trash2 className="h-4 w-4" />, danger: true, onClick: () => { void deleteStore(store); } },
                                        ]}
                                    />
                                )}
                            </div>
                        );
                    })}
                    {isParent && (
                        <button
                            type="button"
                            onClick={openCreateStore}
                            aria-label={t('shopping:stores.add')}
                            title={t('shopping:stores.add')}
                            className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full border border-dashed border-border text-muted-foreground transition-colors hover:border-primary hover:text-primary"
                        >
                            <Plus className="h-5 w-5" />
                        </button>
                    )}
                </div>
            )}

            {/* On a wide screen: the form and the templates on the left, the
                list and its total on the right. The third row only absorbs
                the height of a long list, so the two cards keep their own. */}
            <div className="flex flex-col gap-6 xl:grid xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] xl:grid-rows-[auto_auto_1fr] xl:items-start">
            <Card className="xl:col-start-1 xl:row-start-1">
                <CardHeader>
                    <CardTitle>{t('shopping:add.title')}</CardTitle>
                </CardHeader>
                <CardContent>
                    {/* From xl up this card is a narrow column: the fields go back
                        to the two columns they have on a phone. */}
                    <form onSubmit={addItem} className="grid grid-cols-2 gap-3 md:grid-cols-12 md:gap-4 xl:grid-cols-2 xl:gap-3">
                        <div className="col-span-2 md:col-span-12 xl:col-span-2">
                            <Input
                                label={t('common:labels.name')}
                                type="text"
                                value={newItem.name}
                                onChange={(e) => setNewItem((prev) => ({ ...prev, name: e.target.value }))}
                                placeholder={t('shopping:add.namePlaceholder')}
                            />
                        </div>

                        {suggestions.length > 0 && (
                            <div className="col-span-2 md:col-span-12 xl:col-span-2">
                                <p className="mb-1.5 text-micro font-medium uppercase tracking-wide text-muted-foreground">
                                    {t('shopping:add.suggestions')}
                                </p>
                                <div className="flex flex-wrap gap-1.5">
                                    {suggestions.map(({ key, label, category }) => (
                                        <button
                                            key={key}
                                            type="button"
                                            onClick={() => applySuggestion(label, category)}
                                            className="min-h-11 rounded-pill border border-border bg-card px-3 py-1 text-caption text-foreground transition-colors hover:border-primary hover:bg-primary-soft hover:text-primary"
                                        >
                                            {label}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}
                        <div className="col-span-2 md:col-span-4 xl:col-span-2">
                            <label className="mb-1.5 block text-caption font-medium text-foreground">{t('shopping:add.category')}</label>
                            <select
                                value={newItem.category}
                                onChange={(e) => setNewItem((prev) => ({ ...prev, category: e.target.value }))}
                                className="input-nexus py-0 text-caption"
                            >
                                {categories.map((category) => (
                                    <option key={category} value={category}>
                                        {categoryLabel(category)}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <div className="md:col-span-2 xl:col-span-1">
                            <Input
                                label={t('shopping:qty')}
                                type="number"
                                min="0"
                                step="0.1"
                                value={newItem.quantity}
                                onChange={(e) => setNewItem((prev) => ({ ...prev, quantity: e.target.value }))}
                                placeholder={t('shopping:add.qtyPlaceholder')}
                            />
                        </div>
                        <div className="md:col-span-2 xl:col-span-1">
                            <Input
                                label={t('common:labels.price')}
                                type="number"
                                min="0"
                                step="0.01"
                                value={newItem.price}
                                onChange={(e) => setNewItem((prev) => ({ ...prev, price: e.target.value }))}
                                placeholder={t('shopping:add.pricePlaceholder')}
                            />
                        </div>
                        <div className="col-span-2 flex items-end justify-end md:col-span-4 xl:col-span-2">
                            <Button type="submit" className="w-full md:w-auto xl:w-full">
                                <Plus className="mr-1 h-4 w-4" />
                                {t('common:actions.add')}
                            </Button>
                        </div>
                    </form>
                </CardContent>
            </Card>

            <div className="space-y-3 xl:col-start-2 xl:row-span-3 xl:row-start-1">
                {pendingItems.length === 0 && completedItems.length === 0 ? (
                    <div className="rounded-card border border-dashed border-border bg-card py-16 text-center">
                        <ShoppingBag className="mx-auto mb-3 h-12 w-12 text-muted-foreground/30" />
                        <h3 className="text-body font-semibold text-foreground">{t('shopping:list.emptyTitle')}</h3>
                        <p className="text-caption text-muted-foreground">{t('shopping:list.emptySubtitle')}</p>
                    </div>
                ) : (
                    <>
                        {pendingItems.map((item) => {
                            const expanded = expandedItems.has(item.id);
                            return (
                            <div
                                key={item.id}
                                className="group flex items-center gap-4 rounded-card border border-border bg-card p-4 shadow-surface transition-all duration-fast ease-soft hover:border-border-strong"
                            >
                                <button
                                    type="button"
                                    onClick={() => toggleItem(item)}
                                    className="-m-2 flex h-8 w-8 p-2 flex-shrink-0 items-center justify-center"
                                >
                                    <span className="flex h-6 w-6 items-center justify-center rounded-md border-2 border-input">
                                        {item.is_checked ? <Check className="h-3.5 w-3.5 text-primary" /> : null}
                                    </span>
                                </button>

                                <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-1">
                                        <p className="truncate text-body font-medium text-foreground">{item.name}</p>
                                        <button
                                            type="button"
                                            aria-expanded={expanded}
                                            aria-controls={`item-details-${item.id}`}
                                            aria-label={t('shopping:item.toggleDetails', { name: item.name })}
                                            onClick={() => {
                                                const willCollapse = expanded;
                                                if (willCollapse && editingQuantityId === item.id) {
                                                    // D2: pas de perte de saisie au repli — on valide
                                                    // le brouillon comme le blur de l'input.
                                                    void setItemQuantity(item, quantityDraft);
                                                    setEditingQuantityId(null);
                                                }
                                                setExpandedItems((prev) => {
                                                    const next = new Set(prev);
                                                    if (willCollapse) next.delete(item.id); else next.add(item.id);
                                                    return next;
                                                });
                                            }}
                                            className="-m-3 p-3 text-muted-foreground hover:text-foreground"
                                        >
                                            <ChevronDown className={`h-4 w-4 transition-transform ${expanded ? '' : '-rotate-90'}`} />
                                        </button>
                                    </div>
                                    {expanded && (
                                    <div id={`item-details-${item.id}`} className="mt-1 flex flex-wrap items-center gap-2 text-micro">
                                        <span className="rounded-pill bg-primary-soft px-2 py-0.5 text-primary">{categoryLabel(item.category)}</span>

                                        {editingQuantityId === item.id ? (
                                            <span className="flex items-center gap-1">
                                                <button
                                                    type="button"
                                                    aria-label={t('shopping:quantity.decrease')}
                                                    // Keeps the input focused so the blur-save is not
                                                    // triggered by pressing the stepper itself.
                                                    onMouseDown={(e) => e.preventDefault()}
                                                    onClick={() => stepDraft(-1)}
                                                    className="flex -m-2 h-8 w-8 p-2 items-center justify-center rounded-md border border-border text-muted-foreground hover:border-primary hover:text-primary"
                                                >
                                                    <Minus className="h-3 w-3" />
                                                </button>
                                                <input
                                                    type="number"
                                                    min="0"
                                                    step="0.1"
                                                    autoFocus
                                                    value={quantityDraft}
                                                    onChange={(e) => setQuantityDraft(e.target.value)}
                                                    onBlur={() => {
                                                        void setItemQuantity(item, quantityDraft);
                                                        setEditingQuantityId(null);
                                                    }}
                                                    onKeyDown={(e) => {
                                                        if (e.key === 'Enter') {
                                                            e.currentTarget.blur();
                                                        }
                                                        if (e.key === 'Escape') {
                                                            setEditingQuantityId(null);
                                                        }
                                                    }}
                                                    className="h-8 w-16 rounded-md border border-border bg-card px-2 py-0.5 text-center text-caption text-foreground"
                                                />
                                                <button
                                                    type="button"
                                                    aria-label={t('shopping:quantity.increase')}
                                                    onMouseDown={(e) => e.preventDefault()}
                                                    onClick={() => stepDraft(1)}
                                                    className="flex -m-2 h-8 w-8 p-2 items-center justify-center rounded-md border border-border text-muted-foreground hover:border-primary hover:text-primary"
                                                >
                                                    <Plus className="h-3 w-3" />
                                                </button>
                                                {item.unit ? <span className="text-muted-foreground">{item.unit}</span> : null}
                                            </span>
                                        ) : (
                                            <button
                                                type="button"
                                                title={t('shopping:quantity.edit')}
                                                onClick={() => {
                                                    setEditingQuantityId(item.id);
                                                    setQuantityDraft(item.quantity ? String(Number(item.quantity)) : '');
                                                }}
                                                className="min-h-11 rounded-pill border border-dashed border-border px-2.5 py-1 text-muted-foreground transition-colors hover:border-primary hover:text-primary"
                                            >
                                                {item.quantity
                                                    ? `${t('shopping:qty')}: ${formatQty(item.quantity)}${item.unit ? ` ${item.unit}` : ''}`
                                                    : t('shopping:quantity.unset')}
                                            </button>
                                        )}

                                        {item.price ? <span className="text-muted-foreground">{formatCurrency(Number(item.price), currency)}</span> : null}
                                    </div>
                                    )}
                                </div>

                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => openEditItem(item)}
                                    aria-label={t('shopping:stores.editItemTitle')}
                                    title={t('shopping:stores.editItemTitle')}
                                    className="text-muted-foreground hover:bg-surface-2"
                                >
                                    <Pencil className="h-4 w-4" />
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => deleteItem(item.id)}
                                    className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                                >
                                    <Trash2 className="h-4 w-4" />
                                </Button>
                            </div>
                            );
                        })}

                        {completedItems.length > 0 ? (
                            <div className="rounded-card border border-dashed border-border bg-muted/20 p-4">
                                <div className="mb-3 flex items-center justify-between">
                                    <p className="text-caption font-medium text-muted-foreground">{t('shopping:list.completed', { count: completedItems.length })}</p>
                                    <Button variant="ghost" size="sm" onClick={clearCheckedItems}>
                                        {t('shopping:list.clean')}
                                    </Button>
                                </div>
                                <div className="space-y-2">
                                    {completedItems.map((item) => (
                                        <div
                                            key={item.id}
                                            className="flex items-center gap-3 rounded-input border border-border bg-card px-3 py-2"
                                        >
                                            <button
                                                type="button"
                                                onClick={() => toggleItem(item)}
                                                className="-m-2 flex h-8 w-8 p-2 flex-shrink-0 items-center justify-center"
                                            >
                                                <span className="flex h-5 w-5 items-center justify-center rounded border border-primary bg-primary">
                                                    <Check className="h-3 w-3 text-white" />
                                                </span>
                                            </button>
                                            <p className="line-through text-caption text-muted-foreground">{item.name}</p>
                                            <button
                                                type="button"
                                                onClick={() => openEditItem(item)}
                                                aria-label={t('shopping:stores.editItemTitle')}
                                                className="ml-auto flex min-h-11 min-w-11 items-center justify-center rounded-full text-muted-foreground hover:bg-surface-2"
                                            >
                                                <Pencil className="h-4 w-4" />
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        ) : null}
                    </>
                )}
            </div>

            <Card className="xl:col-start-1 xl:row-start-2">
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <ListChecks className="h-5 w-5 text-primary" />
                        {t('shopping:templates.title')}
                    </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-3 xl:grid-cols-1">
                        <div className="md:col-span-2 xl:col-span-1">
                            <Input
                                label={t('shopping:templates.newLabel')}
                                value={templateName}
                                onChange={(e) => setTemplateName(e.target.value)}
                                placeholder={t('shopping:templates.newPlaceholder')}
                            />
                        </div>
                        <div className="flex items-end gap-2">
                            <Button variant="secondary" className="w-full" onClick={openTemplateDialog}>
                                <Save className="mr-1 h-4 w-4" />
                                {t('shopping:templates.create')}
                            </Button>
                        </div>
                    </div>

                    <div className="grid grid-cols-1 gap-3 md:grid-cols-3 xl:grid-cols-1">
                        <div className="md:col-span-2 xl:col-span-1">
                            <label className="mb-1.5 block text-caption font-medium text-foreground">{t('shopping:templates.existing')}</label>
                            <select
                                value={selectedTemplateId}
                                onChange={(e) => setSelectedTemplateId(e.target.value)}
                                className="input-nexus py-0 text-caption"
                            >
                                <option value="">{t('shopping:templates.selectPlaceholder')}</option>
                                {templates.map((template) => (
                                    <option key={template.id} value={template.id}>
                                        {template.name} ({t('shopping:templates.optionItems', { count: template.items?.length || 0 })})
                                    </option>
                                ))}
                            </select>
                        </div>
                        <div className="flex items-end gap-2">
                            <Button variant="secondary" className="flex-1" onClick={applyTemplate}>
                                {t('common:actions.apply')}
                            </Button>
                            <Button variant="ghost" className="text-destructive hover:bg-destructive/10" onClick={deleteTemplate}>
                                <Trash2 className="h-4 w-4" />
                            </Button>
                        </div>
                    </div>
                </CardContent>
            </Card>

            <div className="sticky bottom-20 z-20 rounded-card border border-border bg-card px-4 py-3 shadow-surface lg:bottom-4 xl:col-start-2 xl:row-start-4">
                <div className="flex items-center justify-between text-caption">
                    <span className="text-muted-foreground">{t('shopping:footer.estimatedTotal')}</span>
                    <span className="text-body font-semibold text-foreground">{formatCurrency(totalPrice, currency)}</span>
                </div>
            </div>
            </div>

            {/* Store sheet (create | edit) — parents only see the entry points */}
            <Sheet
                open={storeSheet !== null}
                dismissible={false}
                onClose={() => setStoreSheet(null)}
                title={storeSheet?.mode === 'edit' ? t('shopping:stores.editTitle') : t('shopping:stores.newTitle')}
            >
                <form onSubmit={submitStoreSheet} className="space-y-4">
                    <Input
                        label={t('shopping:stores.nameLabel')}
                        value={storeName}
                        onChange={(e) => setStoreName(e.target.value)}
                        placeholder={t('shopping:stores.namePlaceholder')}
                        maxLength={SHOPPING_STORE_NAME_MAX}
                        required
                        autoFocus
                    />
                    <div>
                        <span className="mb-1.5 block text-label font-medium text-foreground">
                            {t('shopping:stores.iconLabel')}
                        </span>
                        <IconGrid value={storeIcon} onChange={setStoreIcon} />
                    </div>
                    <div className="flex justify-end gap-3 pt-2">
                        <Button type="button" variant="secondary" onClick={() => setStoreSheet(null)}>
                            {t('common:actions.cancel')}
                        </Button>
                        <Button type="submit">
                            {storeSheet?.mode === 'edit' ? t('shopping:stores.submitSave') : t('shopping:stores.submitCreate')}
                        </Button>
                    </div>
                </form>
            </Sheet>

            {/* Item edit sheet: the store dropdown moves the item between tabs
                ("Général" + existing stores, no inline creation). */}
            <Sheet
                open={editingItem !== null}
                dismissible={false}
                onClose={() => setEditingItem(null)}
                title={t('shopping:stores.editItemTitle')}
            >
                <form onSubmit={submitEditItem} className="space-y-4">
                    <div>
                        <label className="mb-1.5 block text-caption font-medium text-foreground" htmlFor="edit-item-store">
                            {t('shopping:stores.itemStore')}
                        </label>
                        <select
                            id="edit-item-store"
                            value={editItemStore}
                            onChange={(e) => setEditItemStore(e.target.value)}
                            className="input-nexus w-full py-0 text-caption"
                        >
                            <option value="">{t('shopping:stores.generalOption')}</option>
                            {stores.map((s) => (
                                <option key={s.id} value={s.id}>{s.icon} {s.name}</option>
                            ))}
                        </select>
                    </div>
                    <div className="flex justify-end gap-3 pt-2">
                        <Button type="button" variant="secondary" onClick={() => setEditingItem(null)}>
                            {t('common:actions.cancel')}
                        </Button>
                        <Button type="submit">{t('common:actions.save')}</Button>
                    </div>
                </form>
            </Sheet>

            {/* Template creation dialog */}
            <Dialog
                open={templateDialogOpen}
                dismissible={false}
                onOpenChange={setTemplateDialogOpen}
                title={t('shopping:dialog.title')}
                description={t('shopping:dialog.description')}
            >
                <div className="space-y-4">
                    <Input
                        label={t('shopping:dialog.nameLabel')}
                        value={templateName}
                        onChange={(e) => setTemplateName(e.target.value)}
                        placeholder={t('shopping:dialog.namePlaceholder')}
                    />
                    <div>
                        <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                            <span className="whitespace-nowrap text-label font-medium text-foreground">
                                {t('shopping:dialog.itemsSelected', { selected: selectedItemIds.size, total: items.length })}
                            </span>
                            <div className="flex gap-2">
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => setSelectedItemIds(new Set(items.map((i) => i.id)))}
                                >
                                    {t('shopping:dialog.selectAll')}
                                </Button>
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => setSelectedItemIds(new Set())}
                                >
                                    {t('shopping:dialog.deselectAll')}
                                </Button>
                            </div>
                        </div>
                        <div className="max-h-72 overflow-y-auto space-y-3 rounded-input border border-border p-3">
                            {categories.map((category) => {
                                const categoryItems = items.filter((item) => item.category === category);
                                if (categoryItems.length === 0) return null;
                                const allSelected = categoryItems.every((item) => selectedItemIds.has(item.id));
                                return (
                                    <div key={category}>
                                        <div className="flex items-center justify-between mb-1">
                                            <span className="text-caption font-semibold text-muted-foreground uppercase tracking-wide">
                                                {categoryLabel(category)} ({categoryItems.length})
                                            </span>
                                            <button
                                                type="button"
                                                onClick={() => allSelected ? deselectByCategory(category) : selectByCategory(category)}
                                                className="text-micro text-primary underline hover:no-underline"
                                            >
                                                {allSelected ? t('shopping:dialog.deselect') : t('shopping:dialog.selectAll')}
                                            </button>
                                        </div>
                                        <div className="space-y-1 pl-1">
                                            {categoryItems.map((item) => (
                                                <label
                                                    key={item.id}
                                                    className="flex items-center gap-2 cursor-pointer hover:bg-nexus-background rounded px-1 py-0.5"
                                                >
                                                    <input
                                                        type="checkbox"
                                                        checked={selectedItemIds.has(item.id)}
                                                        onChange={() => toggleItemSelection(item.id)}
                                                        className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
                                                    />
                                                    <span className={`text-body-sm ${item.is_checked ? 'line-through text-muted-foreground' : 'text-foreground'}`}>
                                                        {item.name}
                                                        {item.quantity ? ` · ${formatQty(item.quantity)}${item.unit ? ' ' + item.unit : ''}` : ''}
                                                    </span>
                                                </label>
                                            ))}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                    <div className="flex justify-end gap-3 pt-2">
                        <Button type="button" variant="secondary" onClick={() => setTemplateDialogOpen(false)}>
                            {t('common:actions.cancel')}
                        </Button>
                        <Button type="button" onClick={saveTemplateFromDialog}>
                            <Save className="mr-1 h-4 w-4" />
                            {t('shopping:dialog.create')}
                        </Button>
                    </div>
                </div>
            </Dialog>
        </div>
    );
};

export default ShoppingList;
