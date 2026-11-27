import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useWebSocketUpdates } from '../hooks/useWebSocketUpdates';
import { useAuth } from '../contexts/AuthContext';
import { useCategories } from '../hooks/useCategories';
import { api } from '../lib/api';
import { Plus, CheckSquare, Square, Trash2, Edit2, Filter, TrendingUp, Star, Hourglass, Check, X } from 'lucide-react';
import { Card, CardContent, Button, Dialog, Input, Select, Textarea, DatePicker, Badge, useToast } from '../components/ui';
import { format, parseISO } from 'date-fns';
import { dateLocale } from '../i18n/format';
import { cn } from '../lib/utils';
import { friendlyApiError } from '../lib/friendlyError';

interface Task {
    id: string;
    title: string;
    description?: string;
    is_completed: boolean;
    due_date?: string;
    frequency?: string;
    /** Recurrence anchor (post-version n°2): 'calendar' (null, default) or 'completion'. */
    recurrence_anchor?: string | null;
    /** Custom interval (chantier C), only set when frequency is 'Personnalisé'. */
    recurrence_custom_value?: number | null;
    recurrence_custom_unit?: string | null;
    priority?: string;
    /** One of the family's task categories (Settings), or none. */
    category?: string | null;
    /** Rappels push (fonctionnalité 14) : null = aucun rappel dédié (défaut des tâches pré-migration). */
    reminder_offset_days?: number | null;
    reminder_time?: string | null;
    reminder_overdue?: boolean;
    assigned_to?: string[];
    assigned_to_members?: Array<{ id: string; name: string; color: string }>;
    points?: number;
    pending_approval?: boolean;
    completed_at?: string;
    created_at: string;
}

interface FamilyMember {
    id: string;
    name: string;
    color: string;
    /** Login account this member profile belongs to, set on the Family page. */
    linked_user_id?: string | null;
}

interface TaskFilters {
    priority: string;
    status: string;
    member: string;
    frequency: string;
    category: string;
}

const DEFAULT_FILTERS: TaskFilters = { priority: '', status: 'all', member: '', frequency: '', category: '' };
/** Filter value for tasks without a category. */
const NO_CATEGORY = '__none__';

/**
 * Arrondit 'HH:MM' au quart d'heure le plus proche (15:38 → 15:45, 15:29 → 15:30).
 * Gère le dépassement de minute (…:52 → heure suivante :00) et minuit (23:52 → 00:00).
 * Retourne 'HH:MM' sur 24 h, minutes ∈ {00,15,30,45}.
 */
export function roundToQuarterHour(value: string): string {
    const match = /^([01][0-9]|2[0-3]):([0-9]{2})$/.exec(value.trim());
    if (!match) return '08:00';
    const hours = parseInt(match[1], 10);
    const minutes = parseInt(match[2], 10);
    const total = hours * 60 + minutes;
    const rounded = Math.round(total / 15) * 15;
    const h = Math.floor(rounded / 60) % 24;
    const m = rounded % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Same sliding pill as the kiosk settings, as a full-width row (≥ 44 px target). */
const SwitchRow: React.FC<{ checked: boolean; onChange: () => void; label: string; hint?: string; disabled?: boolean }> = ({
    checked, onChange, label, hint, disabled,
}) => (
    <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={onChange}
        className="flex min-h-11 w-full items-center gap-3 rounded-input px-2 text-left disabled:cursor-not-allowed disabled:opacity-50"
    >
        <span
            className={cn(
                'relative h-7 w-12 shrink-0 rounded-full transition-colors',
                checked ? 'bg-primary' : 'border border-border bg-surface-2'
            )}
        >
            <span
                className={cn(
                    'absolute top-1 h-5 w-5 rounded-full bg-white shadow transition-all',
                    checked ? 'left-6' : 'left-1'
                )}
            />
        </span>
        <span className="flex-1">
            <span className="block text-label font-medium text-foreground">{label}</span>
            {hint && <span className="block text-micro text-muted-foreground">{hint}</span>}
        </span>
    </button>
);

// Each account keeps its own filters on this device, so a child signed in on the
// family tablet finds "my tasks" again instead of everyone's after every visit.
const filtersKey = (userId: string) => `openfamily.tasks.filters.${userId}`;

function readSavedFilters(userId: string | undefined): TaskFilters | null {
    if (!userId) return null;
    try {
        const raw = localStorage.getItem(filtersKey(userId));
        if (!raw) return null;
        const saved = JSON.parse(raw) as Partial<TaskFilters>;
        return {
            priority: typeof saved.priority === 'string' ? saved.priority : '',
            status: ['all', 'pending', 'completed'].includes(saved.status as string) ? saved.status as string : 'all',
            member: typeof saved.member === 'string' ? saved.member : '',
            frequency: typeof saved.frequency === 'string' ? saved.frequency : '',
            category: typeof saved.category === 'string' ? saved.category : '',
        };
    } catch {
        return null;
    }
}

interface TaskStats {
    total: number;
    completed: number;
    pending: number;
    completionRate: number;
    byPriority: {
        Haute: number;
        Moyenne: number;
        Basse: number;
    };
}

const Tasks: React.FC = () => {
    const { t } = useTranslation(['tasks', 'common']);
    const { user } = useAuth();
    const { categories } = useCategories();
    const { showToast } = useToast();
    // Child accounts cannot grant points or approve chores.
    const isParent = Boolean(user?.is_owner) || user?.role !== 'enfant';
    const PRIORITIES = [
        { value: 'Haute', label: t('tasks:priorities.Haute') },
        { value: 'Moyenne', label: t('tasks:priorities.Moyenne') },
        { value: 'Basse', label: t('tasks:priorities.Basse') },
    ];
    const FREQUENCIES = [
        { value: 'Une fois', label: t('tasks:frequencies.Une fois') },
        { value: 'Quotidien', label: t('tasks:frequencies.Quotidien') },
        { value: 'Hebdomadaire', label: t('tasks:frequencies.Hebdomadaire') },
        { value: 'Mensuel', label: t('tasks:frequencies.Mensuel') },
        { value: 'Trimestriel', label: t('tasks:frequencies.Trimestriel') },
        { value: 'Quadrimestriel', label: t('tasks:frequencies.Quadrimestriel') },
        { value: 'Semestriel', label: t('tasks:frequencies.Semestriel') },
        { value: 'Annuel', label: t('tasks:frequencies.Annuel') },
        { value: 'Personnalisé', label: t('tasks:frequencies.Personnalisé') },
    ];
    // Unités de la fréquence personnalisée (chantier C).
    const CUSTOM_UNITS = [
        { value: 'days', label: t('tasks:form.customFrequency.days') },
        { value: 'months', label: t('tasks:form.customFrequency.months') },
    ];
    // Ancres de récurrence (post-version n°2), montrées seulement si la
    // fréquence n'est pas « Une fois ».
    const RECURRENCE_ANCHORS = [
        { value: 'calendar', label: t('tasks:anchors.calendar') },
        { value: 'completion', label: t('tasks:anchors.completion') },
    ];
    // Moments du rappel dédié (fonctionnalité 14) : Jour-J, J-1 … J-7.
    const REMINDER_OFFSETS = [0, 1, 2, 3, 4, 5, 6, 7].map((n) => ({
        value: String(n),
        label: n === 0 ? t('tasks:reminders.dayJ') : t('tasks:reminders.dayMinus', { count: n }),
    }));
    const TASK_CATEGORIES = categories.task.map((name) => ({
        value: name,
        label: t(`tasks:categories.${name}`, { defaultValue: name }),
    }));
    const categoryLabel = (v?: string | null) => (v ? t(`tasks:categories.${v}`, { defaultValue: v }) : '');
    const priorityLabel = (v?: string) => (v ? t(`tasks:priorities.${v}`, { defaultValue: v }) : '');
    const frequencyLabel = (v?: string) => (v ? t(`tasks:frequencies.${v}`, { defaultValue: v }) : '');
    const [tasks, setTasks] = useState<Task[]>([]);
    const [familyMembers, setFamilyMembers] = useState<FamilyMember[]>([]);
    const [stats, setStats] = useState<TaskStats | null>(null);
    const [loading, setLoading] = useState(true);
    const [dialogOpen, setDialogOpen] = useState(false);
    const [editingTask, setEditingTask] = useState<Task | null>(null);
    const savedFilters = useRef(readSavedFilters(user?.id)).current;
    const [filterPriority, setFilterPriority] = useState<string>(savedFilters?.priority ?? DEFAULT_FILTERS.priority);
    const [filterStatus, setFilterStatus] = useState<string>(savedFilters?.status ?? DEFAULT_FILTERS.status);
    const [filterMember, setFilterMember] = useState<string>(savedFilters?.member ?? DEFAULT_FILTERS.member);
    const [filterFrequency, setFilterFrequency] = useState<string>(savedFilters?.frequency ?? DEFAULT_FILTERS.frequency);
    const [filterCategory, setFilterCategory] = useState<string>(savedFilters?.category ?? DEFAULT_FILTERS.category);
    // A child account with no saved choice yet starts on its own member profile.
    const memberDefaulted = useRef(savedFilters !== null);
    const [error, setError] = useState('');

    // Form state
    const [formData, setFormData] = useState({
        title: '',
        description: '',
        due_date: '',
        frequency: 'Une fois',
        recurrence_anchor: 'calendar',
        recurrence_custom_value: '',
        recurrence_custom_unit: 'days',
        priority: 'Moyenne',
        category: '',
        assigned_to: [] as string[],
        points: '',
        // Rappels push (fonctionnalité 14) : activés par défaut à la création
        // (jour-J à 08:00, sans rappel de retard).
        reminder_enabled: true,
        reminder_offset_days: '0',
        reminder_time: '08:00',
        reminder_overdue: false,
    });

    useEffect(() => {
        loadTasks();
        loadFamilyMembers();
        loadStats();
    }, []);
    useWebSocketUpdates('tasks', () => { void loadTasks(); void loadStats(); });

    const loadTasks = async () => {
        try {
            const response = await api.get<{ success: boolean; data: Task[] }>('/api/tasks');
            if (response.success) {
                setTasks(response.data);
            }
        } catch (error) {
            console.error('Failed to load tasks:', error);
            setError(error instanceof Error ? error.message : t('tasks:errors.loadTasks'));
        } finally {
            setLoading(false);
        }
    };

    const loadFamilyMembers = async () => {
        try {
            const response = await api.get<{ success: boolean; data: FamilyMember[] }>('/api/family');
            if (response.success) {
                setFamilyMembers(response.data);
            }
        } catch (error) {
            console.error('Failed to load family members:', error);
            setError(error instanceof Error ? error.message : t('tasks:errors.loadMembers'));
        }
    };

    const loadStats = async () => {
        try {
            const response = await api.get<{ success: boolean; data: TaskStats }>('/api/tasks/statistics');
            if (response.success) {
                setStats(response.data);
            }
        } catch (error) {
            console.error('Failed to load stats:', error);
            setError(error instanceof Error ? error.message : t('tasks:errors.loadStats'));
        }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        // Custom frequency (chantier C): bornes reflétées — 1-365 jours, 1-12 mois.
        let customValue: number | null = null;
        if (formData.frequency === 'Personnalisé') {
            const n = parseInt(formData.recurrence_custom_value, 10);
            const max = formData.recurrence_custom_unit === 'days' ? 365 : 12;
            if (!Number.isInteger(n) || n < 1 || n > max) {
                setError(t('tasks:errors.customFrequency'));
                return;
            }
            customValue = n;
        }
        // Rappels (fonctionnalité 14) : validation client des bornes —
        // J-X dans 0..7. L'heure est ARRONDIE au quart d'heure le plus proche
        // avant l'envoi (le serveur garde sa validation stricte 400) :
        // 15:38 → 15:45, 15:29 → 15:30, avec un toast explicite.
        // Heure vide avec rappel actif → repli 08:00.
        let reminderOffset: number | null = null;
        let reminderTime: string | null = null;
        if (formData.reminder_enabled) {
            const offset = parseInt(formData.reminder_offset_days, 10);
            if (!Number.isInteger(offset) || offset < 0 || offset > 7) {
                setError(t('tasks:errors.invalidReminder'));
                return;
            }
            const typed = formData.reminder_time.trim() || '08:00';
            const rounded = roundToQuarterHour(typed);
            if (rounded !== typed) {
                setFormData((prev) => ({ ...prev, reminder_time: rounded }));
                showToast({ title: t('tasks:reminders.roundedTime', { from: typed, to: rounded }) });
            }
            reminderOffset = offset;
            reminderTime = rounded;
        }
        try {
            const payload: Record<string, unknown> = {
                ...formData,
                // Children never send points; the server ignores it anyway.
                points: isParent ? parseInt(formData.points, 10) || 0 : undefined,
                // Anchor only meaningful for a recurring task; sent as null
                // otherwise so switching back to "Une fois" resets it.
                recurrence_anchor: formData.frequency !== 'Une fois' ? formData.recurrence_anchor : null,
                // Custom interval only for "Personnalisé"; null otherwise so
                // the server stores NULL columns (no state leak).
                recurrence_custom_value: formData.frequency === 'Personnalisé' ? customValue : null,
                recurrence_custom_unit: formData.frequency === 'Personnalisé' ? formData.recurrence_custom_unit : null,
                // Rappels : null = aucun rappel dédié (le récap du matin reste actif).
                reminder_offset_days: reminderOffset,
                reminder_time: reminderTime,
                reminder_overdue: formData.reminder_enabled ? formData.reminder_overdue : false,
            };
            // The switch state itself is UI-only.
            delete payload.reminder_enabled;
            if (editingTask) {
                await api.put(`/api/tasks/${editingTask.id}`, payload);
            } else {
                await api.post('/api/tasks', payload);
            }
            setDialogOpen(false);
            resetForm();
            loadTasks();
            loadStats();
        } catch (error) {
            console.error('Failed to save task:', error);
            setError(friendlyApiError(error, t, 'tasks:errors.saveTask'));
        }
    };

    const handleToggleComplete = async (task: Task) => {
        try {
            const response = await api.put<{ success: boolean; data: Task }>(`/api/tasks/${task.id}`, {
                is_completed: !task.is_completed,
            });
            // A child completing a points chore: the points wait for a parent.
            if (!task.is_completed && response.success && response.data?.pending_approval) {
                showToast({
                    title: t('tasks:approval.toastTitle'),
                    description: t('tasks:approval.toastDescription'),
                });
            }
            loadTasks();
            loadStats();
        } catch (error) {
            console.error('Failed to toggle task:', error);
            setError(error instanceof Error ? error.message : t('tasks:errors.toggleTask'));
        }
    };

    const handleApprove = async (task: Task) => {
        try {
            await api.post(`/api/tasks/${task.id}/approve`, {});
            loadTasks();
            loadStats();
        } catch (error) {
            console.error('Failed to approve task:', error);
            setError(error instanceof Error ? error.message : t('tasks:errors.approveTask'));
        }
    };

    const handleReject = async (task: Task) => {
        try {
            await api.post(`/api/tasks/${task.id}/reject`, {});
            loadTasks();
            loadStats();
        } catch (error) {
            console.error('Failed to reject task:', error);
            setError(error instanceof Error ? error.message : t('tasks:errors.rejectTask'));
        }
    };

    const handleDelete = async (id: string) => {
        if (!confirm(t('tasks:confirmDelete'))) return;
        try {
            await api.delete(`/api/tasks/${id}`);
            loadTasks();
            loadStats();
        } catch (error) {
            console.error('Failed to delete task:', error);
            setError(error instanceof Error ? error.message : t('tasks:errors.deleteTask'));
        }
    };

    const handleEdit = (task: Task) => {
        setEditingTask(task);
        setFormData({
            title: task.title,
            description: task.description || '',
            // due_date is either a bare "yyyy-MM-dd" date or a naive local datetime
            // ("yyyy-MM-ddTHH:mm:ss" / "yyyy-MM-dd HH:mm:ss"); the first 10 chars
            // are always the local date — no Date round-trip (and no UTC shift).
            due_date: task.due_date ? task.due_date.slice(0, 10) : '',
            frequency: task.frequency || 'Une fois',
            recurrence_anchor: task.recurrence_anchor === 'completion' ? 'completion' : 'calendar',
            recurrence_custom_value: task.recurrence_custom_value != null ? String(task.recurrence_custom_value) : '',
            recurrence_custom_unit: task.recurrence_custom_unit === 'months' ? 'months' : 'days',
            priority: task.priority || 'Moyenne',
            category: task.category || '',
            assigned_to: task.assigned_to || [],
            points: task.points ? String(task.points) : '',
            // Rappels : une tâche existante sans reminder_offset_days (pré-migration)
            // ouvre le bloc désactivé ; sinon les 3 champs sont rechargés.
            reminder_enabled: task.reminder_offset_days != null,
            reminder_offset_days: task.reminder_offset_days != null ? String(task.reminder_offset_days) : '0',
            reminder_time: task.reminder_time || '08:00',
            reminder_overdue: Boolean(task.reminder_overdue),
        });
        setDialogOpen(true);
    };

    const resetForm = () => {
        setEditingTask(null);
        setFormData({
            title: '',
            description: '',
            due_date: '',
            frequency: 'Une fois',
            recurrence_anchor: 'calendar',
            recurrence_custom_value: '',
            recurrence_custom_unit: 'days',
            priority: 'Moyenne',
            category: '',
            assigned_to: [],
            points: '',
            reminder_enabled: true,
            reminder_offset_days: '0',
            reminder_time: '08:00',
            reminder_overdue: false,
        });
    };

    useEffect(() => {
        if (!user?.id) return;
        try {
            localStorage.setItem(filtersKey(user.id), JSON.stringify({
                priority: filterPriority,
                status: filterStatus,
                member: filterMember,
                frequency: filterFrequency,
                category: filterCategory,
            }));
        } catch {
            /* private mode or storage full: filters simply reset next time */
        }
    }, [user?.id, filterPriority, filterStatus, filterMember, filterFrequency, filterCategory]);

    useEffect(() => {
        if (memberDefaulted.current || isParent || !user?.id || familyMembers.length === 0) return;
        memberDefaulted.current = true;
        const own = familyMembers.find((member) => member.linked_user_id === user.id);
        if (own) setFilterMember(own.id);
    }, [familyMembers, isParent, user?.id]);

    // A saved member that no longer exists would hide every task.
    useEffect(() => {
        if (familyMembers.length === 0 || !filterMember || filterMember === '__unassigned__') return;
        if (!familyMembers.some((member) => member.id === filterMember)) setFilterMember('');
    }, [familyMembers, filterMember]);

    // A saved category the family has since removed would hide every task.
    useEffect(() => {
        if (!filterCategory || filterCategory === NO_CATEGORY) return;
        if (!categories.task.includes(filterCategory)) setFilterCategory('');
    }, [categories.task, filterCategory]);

    const filteredTasks = tasks.filter((task) => {
        if (filterPriority && task.priority !== filterPriority) return false;
        if (filterFrequency && (task.frequency || 'Une fois') !== filterFrequency) return false;
        if (filterCategory === NO_CATEGORY && task.category) return false;
        if (filterCategory && filterCategory !== NO_CATEGORY && task.category !== filterCategory) return false;
        if (filterStatus === 'completed' && !task.is_completed) return false;
        if (filterStatus === 'pending' && task.is_completed) return false;
        if (filterMember === '__unassigned__' && task.assigned_to && task.assigned_to.length > 0) return false;
        if (filterMember && filterMember !== '__unassigned__' && !(task.assigned_to || []).includes(filterMember)) return false;
        return true;
    });

    const getPriorityColor = (priority?: string) => {
        switch (priority) {
            case 'Haute':
                return 'danger';
            case 'Moyenne':
                return 'warning';
            case 'Basse':
                return 'success';
            default:
                return 'default';
        }
    };

    if (loading) {
        return (
            <div className="flex h-full items-center justify-center min-h-[50vh]">
                <div className="flex flex-col items-center gap-4">
                    <div className="spinner-brand" />
                    <p className="text-muted-foreground font-medium animate-pulse">{t('tasks:loading')}</p>
                </div>
            </div>
        );
    }

    return (
        <div className="mx-auto max-w-6xl space-y-6 2xl:max-w-[1600px]">
            {error ? (
                <div className="rounded-input border border-danger/30 bg-danger/10 px-4 py-3 text-caption text-danger">
                    {error}
                </div>
            ) : null}
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                    <h2 className="text-h1 mb-1">{t('tasks:title')}</h2>
                    <p className="text-muted-foreground text-body">{t('tasks:subtitle')}</p>
                </div>
                <Button onClick={() => { resetForm(); setDialogOpen(true); }}>
                    <Plus className="w-4 h-4 mr-2" />
                    {t('tasks:newTask')}
                </Button>
            </div>

            {/* Statistics */}
            {stats && (
                <div className="grid grid-cols-2 md:grid-cols-4 overflow-hidden rounded-card border border-border bg-card">
                    <div className="flex items-center justify-between gap-2 p-4 border-b border-r border-border md:border-b-0">
                        <div>
                            <p className="text-label text-muted-foreground mb-1">{t('tasks:stats.total')}</p>
                            <p className="font-serif text-3xl tracking-tight">{stats.total}</p>
                        </div>
                        <CheckSquare className="h-7 w-7 text-muted-foreground" />
                    </div>
                    <div className="flex items-center justify-between gap-2 p-4 border-b border-border md:border-b-0 md:border-r">
                        <div>
                            <p className="text-label text-muted-foreground mb-1">{t('tasks:stats.completed')}</p>
                            <p className="font-serif text-3xl tracking-tight text-success">{stats.completed}</p>
                        </div>
                        <TrendingUp className="h-7 w-7 text-success" />
                    </div>
                    <div className="flex items-center justify-between gap-2 p-4 border-r border-border">
                        <div>
                            <p className="text-label text-muted-foreground mb-1">{t('tasks:stats.pending')}</p>
                            <p className="font-serif text-3xl tracking-tight">{stats.pending}</p>
                        </div>
                        <Square className="h-7 w-7 text-muted-foreground" />
                    </div>
                    <div className="flex items-center justify-between gap-2 p-4">
                        <div>
                            <p className="text-label text-muted-foreground mb-1">{t('tasks:stats.completionRate')}</p>
                            <p className="font-serif text-3xl tracking-tight text-primary">{stats.completionRate}%</p>
                        </div>
                    </div>
                </div>
            )}

            {/* Filters */}
            <Card>
                <CardContent className="p-4">
                    <div className="flex flex-wrap items-center gap-4">
                        <div className="flex items-center gap-2">
                            <Filter className="h-4 w-4 text-muted-foreground" />
                            <span className="text-body-sm font-medium">{t('tasks:filters.label')}</span>
                        </div>
                        <Select
                            value={filterStatus}
                            onValueChange={setFilterStatus}
                            options={[
                                { value: 'all', label: t('tasks:filters.statusAll') },
                                { value: 'pending', label: t('tasks:filters.statusPending') },
                                { value: 'completed', label: t('tasks:filters.statusCompleted') },
                            ]}
                            className="w-40"
                        />
                        <Select
                            value={filterPriority}
                            onValueChange={setFilterPriority}
                            options={[
                                { value: '', label: t('tasks:filters.allPriorities') },
                                ...PRIORITIES,
                            ]}
                            className="w-48"
                        />
                        <Select
                            value={filterMember}
                            onValueChange={setFilterMember}
                            options={[
                                { value: '', label: t('tasks:filters.allMembers') },
                                { value: '__unassigned__', label: t('tasks:filters.unassigned') },
                                ...familyMembers.map((m) => ({ value: m.id, label: m.name })),
                            ]}
                            className="w-48"
                        />
                        <Select
                            value={filterFrequency}
                            onValueChange={setFilterFrequency}
                            options={[
                                { value: '', label: t('tasks:filters.allFrequencies') },
                                ...FREQUENCIES,
                            ]}
                            className="w-48"
                        />
                        <Select
                            value={filterCategory}
                            onValueChange={setFilterCategory}
                            options={[
                                { value: '', label: t('tasks:filters.allCategories') },
                                { value: NO_CATEGORY, label: t('tasks:filters.noCategory') },
                                ...TASK_CATEGORIES,
                            ]}
                            className="w-48"
                        />
                        {(filterPriority || filterStatus !== 'all' || filterMember || filterFrequency || filterCategory) && (
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => {
                                    setFilterPriority('');
                                    setFilterStatus('all');
                                    setFilterMember('');
                                    setFilterFrequency('');
                                    setFilterCategory('');
                                }}
                            >
                                {t('common:actions.reset')}
                            </Button>
                        )}
                    </div>
                </CardContent>
            </Card>

            {/* Tasks List: two side by side on a wide screen */}
            <div className="grid grid-cols-1 gap-3 2xl:grid-cols-2">
                {filteredTasks.length === 0 ? (
                    <Card className="2xl:col-span-2">
                        <CardContent className="p-8 text-center">
                            <CheckSquare className="h-12 w-12 text-muted-foreground mx-auto mb-3 opacity-50" />
                            <p className="text-muted-foreground">
                                {tasks.length === 0
                                    ? t('tasks:empty.none')
                                    : t('tasks:empty.noMatch')}
                            </p>
                        </CardContent>
                    </Card>
                ) : (
                    filteredTasks.map((task) => (
                        <Card
                            key={task.id}
                            className={`transition-all hover:shadow-md ${task.pending_approval
                                ? 'border-amber-300 bg-amber-50/50 dark:border-amber-900 dark:bg-amber-950/20'
                                : task.is_completed ? 'opacity-60' : ''}`}
                        >
                            <CardContent className="p-4">
                                <div className="flex items-start gap-4">
                                    <button
                                        onClick={() => handleToggleComplete(task)}
                                        aria-label={t('tasks:toggleTask')}
                                        className="mt-1 flex-shrink-0 -m-3 p-3"
                                    >
                                        {task.is_completed ? (
                                            <CheckSquare className="h-5 w-5 text-emerald-600" />
                                        ) : (
                                            <Square className="h-5 w-5 text-muted-foreground hover:text-nexus-blue transition-colors" />
                                        )}
                                    </button>
                                    <div className="flex-1 min-w-0">
                                        {/* The title keeps a readable width: when the actions
                                            do not fit beside it (a chore to approve, on a
                                            phone), they go to the line below. */}
                                        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                                            <div className="min-w-[9rem] flex-1">
                                                <h3
                                                    className={`text-body font-semibold mb-1 ${task.is_completed ? 'line-through text-muted-foreground' : ''
                                                        }`}
                                                >
                                                    {task.title}
                                                </h3>
                                                {task.description && (
                                                    <p className="text-body-sm text-muted-foreground mb-2">
                                                        {task.description}
                                                    </p>
                                                )}
                                                <div className="flex flex-wrap items-center gap-2">
                                                    {(task.points ?? 0) > 0 && (
                                                        <Badge variant="warning" className="flex items-center gap-1">
                                                            <Star className="h-3 w-3 fill-current" />
                                                            {task.points}
                                                        </Badge>
                                                    )}
                                                    {task.pending_approval && (
                                                        <Badge variant="warning" className="flex items-center gap-1">
                                                            <Hourglass className="h-3 w-3" />
                                                            {t('tasks:approval.pendingBadge')}
                                                        </Badge>
                                                    )}
                                                    {task.priority && (
                                                        <Badge variant={getPriorityColor(task.priority)}>
                                                            {priorityLabel(task.priority)}
                                                        </Badge>
                                                    )}
                                                    {task.frequency && task.frequency !== 'Une fois' && (
                                                        <Badge variant="secondary">{frequencyLabel(task.frequency)}</Badge>
                                                    )}
                                                    {task.category && (
                                                        <Badge variant="secondary">{categoryLabel(task.category)}</Badge>
                                                    )}
                                                    {task.due_date && (
                                                        <Badge variant="default">
                                                            {t('tasks:due', { date: format(parseISO(task.due_date), 'dd MMM yyyy', { locale: dateLocale() }) })}
                                                        </Badge>
                                                    )}
                                                {(task.assigned_to_members || []).map((member) => (
                                                        <Badge
                                                            key={member.id}
                                                            variant="primary"
                                                            className="flex items-center gap-1"
                                                        >
                                                            <div
                                                                className="w-2 h-2 rounded-full"
                                                                style={{ backgroundColor: member.color }}
                                                            />
                                                            {member.name}
                                                        </Badge>
                                                    ))}
                                                </div>
                                            </div>
                                            <div className="ml-auto flex flex-wrap items-center justify-end gap-1 sm:gap-2">
                                                {isParent && task.pending_approval && (
                                                    <>
                                                        <Button
                                                            variant="secondary"
                                                            size="sm"
                                                            onClick={() => handleApprove(task)}
                                                            className="text-success"
                                                        >
                                                            <Check className="h-4 w-4 mr-1" />
                                                            {t('tasks:approval.approve')}
                                                        </Button>
                                                        <Button
                                                            variant="ghost"
                                                            size="sm"
                                                            onClick={() => handleReject(task)}
                                                            className="text-destructive"
                                                        >
                                                            <X className="h-4 w-4 mr-1" />
                                                            {t('tasks:approval.reject')}
                                                        </Button>
                                                    </>
                                                )}
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    onClick={() => handleEdit(task)}
                                                >
                                                    <Edit2 className="h-4 w-4" />
                                                </Button>
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    onClick={() => handleDelete(task.id)}
                                                >
                                                    <Trash2 className="h-4 w-4 text-red-500" />
                                                </Button>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </CardContent>
                        </Card>
                    ))
                )}
            </div>

            {/* Dialog */}
            <Dialog
                open={dialogOpen}
                dismissible={false}
                onOpenChange={setDialogOpen}
                title={editingTask ? t('tasks:dialog.editTitle') : t('tasks:dialog.createTitle')}
                description={t('tasks:dialog.description')}
            >
                <form onSubmit={handleSubmit} className="space-y-4">
                    <Input
                        label={t('tasks:form.title')}
                        value={formData.title}
                        onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                        required
                        placeholder={t('tasks:form.titlePlaceholder')}
                    />
                    <Textarea
                        label={t('tasks:form.description')}
                        value={formData.description}
                        onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                        placeholder={t('tasks:form.descriptionPlaceholder')}
                        rows={3}
                    />
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="block text-label font-medium text-foreground mb-1.5">
                                {t('tasks:form.priority')}
                            </label>
                            <Select
                                value={formData.priority}
                                onValueChange={(value) => setFormData({ ...formData, priority: value })}
                                options={PRIORITIES}
                            />
                        </div>
                        <div>
                            <label className="block text-label font-medium text-foreground mb-1.5">
                                {t('tasks:form.frequency')}
                            </label>
                            <Select
                                value={formData.frequency}
                                onValueChange={(value) => setFormData({ ...formData, frequency: value })}
                                options={FREQUENCIES}
                            />
                        </div>
                    </div>
                    {formData.frequency !== 'Une fois' && (
                        <div>
                            <label className="block text-label font-medium text-foreground mb-1.5">
                                {t('tasks:form.recurrenceAnchor')}
                            </label>
                            <Select
                                value={formData.recurrence_anchor}
                                onValueChange={(value) => setFormData({ ...formData, recurrence_anchor: value })}
                                options={RECURRENCE_ANCHORS}
                            />
                            <p className="mt-1 text-micro text-muted-foreground">{t('tasks:form.recurrenceAnchorHint')}</p>
                        </div>
                    )}
                    {formData.frequency === 'Personnalisé' && (
                        <div>
                            <label className="block text-label font-medium text-foreground mb-1.5">
                                {t('tasks:form.customFrequency.label')}
                            </label>
                            <div className="flex gap-2">
                                <Input
                                    type="number"
                                    min={1}
                                    max={formData.recurrence_custom_unit === 'days' ? 365 : 12}
                                    step={1}
                                    value={formData.recurrence_custom_value}
                                    onChange={(e) => setFormData({ ...formData, recurrence_custom_value: e.target.value })}
                                    placeholder="5"
                                    className="flex-1"
                                />
                                <div className="w-32 flex-shrink-0">
                                    <Select
                                        value={formData.recurrence_custom_unit}
                                        onValueChange={(value) => setFormData({ ...formData, recurrence_custom_unit: value })}
                                        options={CUSTOM_UNITS}
                                    />
                                </div>
                            </div>
                            <p className="mt-1 text-micro text-muted-foreground">{t('tasks:form.customFrequency.hint')}</p>
                        </div>
                    )}
                    <div>
                        <label className="block text-label font-medium text-foreground mb-1.5">
                            {t('tasks:form.category')}
                        </label>
                        <Select
                            value={formData.category}
                            onValueChange={(value) => setFormData({ ...formData, category: value })}
                            options={[{ value: '', label: t('tasks:form.noCategory') }, ...TASK_CATEGORIES]}
                        />
                    </div>
                    <DatePicker
                        label={t('tasks:form.dueDate')}
                        value={formData.due_date}
                        onChange={(value) => setFormData({ ...formData, due_date: value })}
                    />
                    {/* Rappels push (fonctionnalité 14) — même permission que l'édition de tâche. */}
                    <div className="rounded-input border border-border bg-surface-2/40 p-3 space-y-2">
                        <p className="text-label font-medium text-foreground">{t('tasks:reminders.title')}</p>
                        <SwitchRow
                            checked={formData.reminder_enabled}
                            onChange={() => setFormData({ ...formData, reminder_enabled: !formData.reminder_enabled })}
                            label={t('tasks:reminders.enable')}
                        />
                        {formData.reminder_enabled && (
                            <>
                                <div className="grid grid-cols-2 gap-4">
                                    <div>
                                        <label className="block text-label font-medium text-foreground mb-1.5">
                                            {t('tasks:reminders.moment')}
                                        </label>
                                        <Select
                                            value={formData.reminder_offset_days}
                                            onValueChange={(value) => setFormData({ ...formData, reminder_offset_days: value })}
                                            options={REMINDER_OFFSETS}
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-label font-medium text-foreground mb-1.5" htmlFor="reminder-time">
                                            {t('tasks:reminders.time')}
                                        </label>
                                        <Input
                                            id="reminder-time"
                                            type="time"
                                            step={900}
                                            value={formData.reminder_time}
                                            onChange={(e) => setFormData({ ...formData, reminder_time: e.target.value })}
                                        />
                                    </div>
                                </div>
                                <SwitchRow
                                    checked={formData.reminder_overdue}
                                    onChange={() => setFormData({ ...formData, reminder_overdue: !formData.reminder_overdue })}
                                    label={t('tasks:reminders.overdue')}
                                    hint={t('tasks:reminders.overdueHint')}
                                />
                            </>
                        )}
                        <p className="text-micro text-muted-foreground">{t('tasks:reminders.recapNote')}</p>
                    </div>
                    {isParent && (
                        <div>
                            <label className="flex items-center gap-1.5 text-label font-medium text-foreground mb-1.5">
                                <Star className="h-4 w-4 text-amber-500 fill-current" />
                                {t('tasks:form.points')}
                            </label>
                            <Input
                                type="number"
                                min={0}
                                step={1}
                                value={formData.points}
                                onChange={(e) => setFormData({ ...formData, points: e.target.value })}
                                placeholder="0"
                            />
                            <p className="mt-1 text-micro text-muted-foreground">{t('tasks:form.pointsHint')}</p>
                        </div>
                    )}
                    <div>
                        <label className="block text-label font-medium text-foreground mb-1.5">
                            {t('tasks:form.assignTo')}
                        </label>
                        {familyMembers.length === 0 ? (
                            <p className="text-body-sm text-muted-foreground">{t('tasks:form.noMembers')}</p>
                        ) : (
                            <div className="space-y-2 rounded-input border border-border bg-surface-2/40 p-3">
                                {familyMembers.map((member) => (
                                    <label key={member.id} className="flex items-center gap-2 cursor-pointer hover:bg-nexus-background rounded px-1 py-0.5">
                                        <input
                                            type="checkbox"
                                            checked={formData.assigned_to.includes(member.id)}
                                            onChange={() => {
                                                setFormData((prev) => ({
                                                    ...prev,
                                                    assigned_to: prev.assigned_to.includes(member.id)
                                                        ? prev.assigned_to.filter((id) => id !== member.id)
                                                        : [...prev.assigned_to, member.id],
                                                }));
                                            }}
                                            className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
                                        />
                                        <div
                                            className="w-3 h-3 rounded-full flex-shrink-0"
                                            style={{ backgroundColor: member.color }}
                                        />
                                        <span className="text-body-sm">{member.name}</span>
                                    </label>
                                ))}
                            </div>
                        )}
                    </div>
                    <div className="flex justify-end gap-3 pt-4">
                        <Button
                            type="button"
                            variant="secondary"
                            onClick={() => setDialogOpen(false)}
                        >
                            {t('common:actions.cancel')}
                        </Button>
                        <Button type="submit">
                            {editingTask ? t('common:actions.save') : t('common:actions.create')}
                        </Button>
                    </div>
                </form>
            </Dialog>
        </div>
    );
};

export default Tasks;
