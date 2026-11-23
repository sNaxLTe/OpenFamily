import { Router } from 'express';
import { query } from '../db';
import { authMiddleware, AuthRequest, isParentAccount, requireParent } from '../middleware/auth';
import { toNullIfEmpty } from '../lib/normalize';
import { broadcast } from '../lib/broadcaster';
import { getFamilyCategories } from './categories';
import {
    customFrequencyFromRow,
    nextTaskDueDateOnComplete,
    normalizeCustomFrequencyInput,
    normalizeTaskAnchorInput,
    normalizeTaskReminderInput,
    resetRecurringTasksDue,
} from '../lib/taskRecurrence';

/**
 * A task's category: empty means none; anything else must be one of the
 * family's task categories (Settings), so a typo or a stale client cannot
 * store a category nobody can filter on.
 */
const resolveTaskCategory = async (value: unknown, ownerId: string): Promise<string | null | undefined> => {
    const name = typeof value === 'string' ? value.trim() : '';
    if (!name) return null;
    const allowed = (await getFamilyCategories(ownerId)).task;
    return allowed.includes(name) ? name : undefined;
};

const router = Router();
router.use(authMiddleware);

// Points are non-negative integers; anything else is treated as 0.
const sanitizePoints = (value: unknown): number => {
    const n = typeof value === 'string' ? parseInt(value, 10) : (value as number);
    return Number.isInteger(n) && n > 0 ? n : 0;
};

/**
 * Credit one 'earn' transaction per assigned member for a completed task.
 * The note is the task title so the history stays readable on its own.
 */
const awardTaskPoints = async (task: { id: string; title: string; points: number; assigned_to: string[] }, userId: string) => {
    for (const memberId of task.assigned_to) {
        await query(
            `INSERT INTO reward_transactions (user_id, member_id, task_id, points, type, note)
             VALUES ($1, $2, $3, $4, 'earn', $5)`,
            [userId, memberId, task.id, task.points, task.title]
        );
    }
};

const ensureMembersBelongToUser = async (memberIds: string[], userId: string) => {
    for (const memberId of memberIds) {
        const member = await query(
            'SELECT id FROM family_members WHERE id = $1 AND user_id = $2',
            [memberId, userId]
        );
        if (member.rows.length === 0) {
            throw new Error('INVALID_MEMBER');
        }
    }
};

const enrichTasksWithMembers = async (tasks: any[], userId: string) => {
    if (tasks.length === 0) return tasks;
    const membersResult = await query(
        'SELECT id, name, color FROM family_members WHERE user_id = $1',
        [userId]
    );
    const membersById = new Map(membersResult.rows.map((m: any) => [m.id, m]));
    return tasks.map((task) => {
        const assignedTo: string[] = Array.isArray(task.assigned_to) ? task.assigned_to : [];
        return {
            ...task,
            assigned_to: assignedTo,
            assigned_to_members: assignedTo.map((id) => membersById.get(id)).filter(Boolean),
        };
    });
};

// Get all tasks
router.get('/', async (req: AuthRequest, res) => {
    try {
        // Reset paresseux des corvées récurrentes (post-version n°2, corrigé
        // en lot D) : une tâche récurrente complétée dont l'échéance est
        // ATTEINTE (due_date <= aujourd'hui, et non "passée") redevient
        // « à faire » dès le démarrage du cycle — sinon elle apparaîtrait un
        // jour « en retard » artificiel. Rattrapage automatique après
        // reboot/vacances, et idempotent (une seule écriture, même après 3
        // semaines). C'est un UPDATE direct, JAMAIS la route d'édition : les
        // reward_transactions du cycle écoulé ne sont pas touchées (le
        // reversement ne vit que dans le PUT manuel). pending_approval est
        // exclu : l'arbitrage parent reste possible et l'enfant ne perd pas
        // ses points. Les retards (tâches non cochées) ne sont jamais
        // effacés, et « Une fois »/NULL reste strictement ponctuel.
        // « Personnalisé » n'est reset que si son intervalle custom est
        // valide (défense anti-garbage). Même helper que le scheduler de
        // rappels (qui le rejoue avant lecture) : un seul WHERE, un seul
        // comportement.
        await resetRecurringTasksDue(query, req.userId!);
        const result = await query(
            'SELECT * FROM tasks WHERE user_id = $1 ORDER BY due_date ASC NULLS LAST, created_at DESC',
            [req.userId]
        );
        const tasks = await enrichTasksWithMembers(result.rows, req.userId!);
        res.json({ success: true, data: tasks });
    } catch (error) {
        console.error('Get tasks error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Create task
router.post('/', async (req: AuthRequest, res) => {
    try {
        const {
            title, description, due_date, frequency, priority, assigned_to, points, category,
            recurrence_anchor, recurrence_custom_value, recurrence_custom_unit,
        } = req.body;

        const cleanedTitle = typeof title === 'string' ? title.trim() : '';
        if (!cleanedTitle) {
            return res.status(400).json({ success: false, error: 'Title is required' });
        }

        // Rappels push (fonctionnalité 14) : validation stricte, 400 hors
        // bornes. Absents à la création → NULL/false = aucun rappel dédié
        // (défaut sûr, identique aux tâches pré-migration).
        const reminders = normalizeTaskReminderInput(req.body);
        if (!reminders.ok) {
            return res.status(400).json({ success: false, error: `Invalid ${reminders.field}` });
        }

        // Ancrage de la récurrence (post-version n°2) : absent = NULL (défaut
        // calendrier), null/'' = retour au défaut, sinon 'calendar'|'completion'.
        let anchor: 'calendar' | 'completion' | null = null;
        if (recurrence_anchor !== undefined) {
            const parsed = normalizeTaskAnchorInput(recurrence_anchor);
            if (!parsed.ok) {
                return res.status(400).json({ success: false, error: 'Invalid recurrence_anchor' });
            }
            anchor = parsed.anchor;
        }

        // Fréquence personnalisée (chantier C) : « Personnalisé » exige un
        // intervalle valide (jours 1-365 / mois 1-12) ; toute autre fréquence
        // exige les deux colonnes à NULL.
        const freq = toNullIfEmpty(frequency);
        const customParsed = normalizeCustomFrequencyInput(recurrence_custom_value, recurrence_custom_unit);
        if (!customParsed.ok) {
            return res.status(400).json({ success: false, error: 'Invalid custom frequency' });
        }
        let custom: { value: number; unit: 'days' | 'months' } | null = customParsed.custom;
        if (freq === 'Personnalisé') {
            if (!custom) {
                return res.status(400).json({ success: false, error: 'Custom frequency requires a value and a unit' });
            }
        } else if (custom !== null) {
            return res.status(400).json({ success: false, error: 'Custom frequency is only allowed with frequency "Personnalisé"' });
        }

        const taskCategory = await resolveTaskCategory(category, req.userId!);
        if (taskCategory === undefined) {
            return res.status(400).json({ success: false, error: 'Unknown category' });
        }

        const assignedTo: string[] = Array.isArray(assigned_to)
            ? assigned_to.filter((id: any) => typeof id === 'string' && id.trim())
            : [];
        await ensureMembersBelongToUser(assignedTo, req.userId!);

        // Only parents may put points on a chore — silently ignore the field otherwise.
        const taskPoints = points !== undefined && (await isParentAccount(req.actualUserId))
            ? sanitizePoints(points)
            : 0;

        const result = await query(
            `INSERT INTO tasks (user_id, title, description, due_date, frequency, priority, assigned_to, points, category, recurrence_anchor, recurrence_custom_value, recurrence_custom_unit, reminder_offset_days, reminder_time, reminder_overdue)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
            [
                req.userId,
                cleanedTitle,
                toNullIfEmpty(description),
                toNullIfEmpty(due_date),
                freq,
                toNullIfEmpty(priority),
                JSON.stringify(assignedTo),
                taskPoints,
                taskCategory,
                anchor,
                custom ? custom.value : null,
                custom ? custom.unit : null,
                reminders.fields.reminder_offset_days ?? null,
                reminders.fields.reminder_time ?? null,
                reminders.fields.reminder_overdue ?? false,
            ]
        );

        const [enriched] = await enrichTasksWithMembers([result.rows[0]], req.userId!);
        broadcast(req.userId!, { type: 'update', entity: 'tasks', action: 'created' });
        res.json({ success: true, data: enriched });
    } catch (error) {
        if (error instanceof Error && error.message === 'INVALID_MEMBER') {
            return res.status(400).json({ success: false, error: 'Assigned member not found' });
        }

        console.error('Create task error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Update task
router.put('/:id', async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;
        const {
            title, description, is_completed, due_date, frequency, priority, assigned_to, points, category,
            recurrence_anchor, recurrence_custom_value, recurrence_custom_unit,
        } = req.body;

        // Rappels push (fonctionnalité 14) : mêmes bornes qu'au POST ; un
        // champ à null/'' repasse la colonne à NULL (rappel dédié désactivé).
        const reminders = normalizeTaskReminderInput(req.body);
        if (!reminders.ok) {
            return res.status(400).json({ success: false, error: `Invalid ${reminders.field}` });
        }

        // The previous state drives the reward logic (false→true transition only).
        const existingResult = await query(
            'SELECT * FROM tasks WHERE id = $1 AND user_id = $2',
            [id, req.userId]
        );
        if (existingResult.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Task not found' });
        }
        const existing = existingResult.rows[0];
        const isParent = await isParentAccount(req.actualUserId);

        const updates: string[] = [];
        const values: any[] = [];

        const pushUpdate = (field: string, value: any) => {
            values.push(value);
            updates.push(`${field} = $${values.length}`);
        };

        if (title !== undefined) {
            const cleanedTitle = typeof title === 'string' ? title.trim() : '';
            if (!cleanedTitle) {
                return res.status(400).json({ success: false, error: 'Title cannot be empty' });
            }
            pushUpdate('title', cleanedTitle);
        }

        if (description !== undefined) {
            pushUpdate('description', toNullIfEmpty(description));
        }

        if (due_date !== undefined) {
            pushUpdate('due_date', toNullIfEmpty(due_date));
        }

        if (frequency !== undefined) {
            pushUpdate('frequency', toNullIfEmpty(frequency));
        }

        // Fréquence effective (body si présent, sinon celle en base), utilisée
        // pour valider l'intervalle custom et l'avance à la complétion.
        const effectiveFrequency = frequency !== undefined ? toNullIfEmpty(frequency) : existing.frequency;

        // Fréquence personnalisée (chantier C) : « Personnalisé » exige un
        // intervalle valide (jours 1-365 / mois 1-12) ; toute autre fréquence
        // exige les deux colonnes à NULL (sinon 400).
        const hasCustomInput = recurrence_custom_value !== undefined || recurrence_custom_unit !== undefined;
        let effectiveCustom = customFrequencyFromRow(existing);
        if (hasCustomInput) {
            const parsed = normalizeCustomFrequencyInput(recurrence_custom_value, recurrence_custom_unit);
            if (!parsed.ok) {
                return res.status(400).json({ success: false, error: 'Invalid custom frequency' });
            }
            if (effectiveFrequency === 'Personnalisé') {
                if (!parsed.custom) {
                    return res.status(400).json({ success: false, error: 'Custom frequency requires a value and a unit' });
                }
                pushUpdate('recurrence_custom_value', parsed.custom.value);
                pushUpdate('recurrence_custom_unit', parsed.custom.unit);
                effectiveCustom = parsed.custom;
            } else {
                if (parsed.custom !== null) {
                    return res.status(400).json({ success: false, error: 'Custom frequency is only allowed with frequency "Personnalisé"' });
                }
                pushUpdate('recurrence_custom_value', null);
                pushUpdate('recurrence_custom_unit', null);
                effectiveCustom = null;
            }
        } else if (frequency !== undefined && existing.frequency === 'Personnalisé' && effectiveFrequency !== 'Personnalisé') {
            // Passage de « Personnalisé » à une autre fréquence sans toucher
            // aux colonnes : elles repassent à NULL (aucune fuite d'état).
            pushUpdate('recurrence_custom_value', null);
            pushUpdate('recurrence_custom_unit', null);
            effectiveCustom = null;
        } else if (effectiveFrequency === 'Personnalisé' && !effectiveCustom) {
            // « Personnalisé » sans intervalle valide, ni en base ni en input.
            return res.status(400).json({ success: false, error: 'Custom frequency requires a value and a unit' });
        }

        // Ancrage de la récurrence (post-version n°2), même validation que POST.
        let anchor: 'calendar' | 'completion' | null | undefined;
        if (recurrence_anchor !== undefined) {
            const parsed = normalizeTaskAnchorInput(recurrence_anchor);
            if (!parsed.ok) {
                return res.status(400).json({ success: false, error: 'Invalid recurrence_anchor' });
            }
            anchor = parsed.anchor;
            pushUpdate('recurrence_anchor', anchor);
        }

        if (category !== undefined) {
            const taskCategory = await resolveTaskCategory(category, req.userId!);
            if (taskCategory === undefined) {
                return res.status(400).json({ success: false, error: 'Unknown category' });
            }
            pushUpdate('category', taskCategory);
        }

        if (priority !== undefined) {
            pushUpdate('priority', toNullIfEmpty(priority));
        }

        // Rappels push (fonctionnalité 14) : only when the client sends them.
        if (reminders.fields.reminder_offset_days !== undefined) {
            pushUpdate('reminder_offset_days', reminders.fields.reminder_offset_days);
        }
        if (reminders.fields.reminder_time !== undefined) {
            pushUpdate('reminder_time', reminders.fields.reminder_time);
        }
        if (reminders.fields.reminder_overdue !== undefined) {
            pushUpdate('reminder_overdue', reminders.fields.reminder_overdue);
        }

        if (assigned_to !== undefined) {
            const assignedTo: string[] = Array.isArray(assigned_to)
                ? assigned_to.filter((mid: any) => typeof mid === 'string' && mid.trim())
                : [];
            await ensureMembersBelongToUser(assignedTo, req.userId!);
            values.push(JSON.stringify(assignedTo));
            updates.push(`assigned_to = $${values.length}::jsonb`);
        }

        // Only parents may set/modify points — silently ignore the field otherwise.
        if (points !== undefined && isParent) {
            pushUpdate('points', sanitizePoints(points));
        }

        let rewardsChanged = false;
        // Award AFTER the UPDATE so the transactions' created_at is >= the new
        // completed_at — the reversal filter on un-complete relies on that order.
        let awardAfterUpdate: { points: number; assigned_to: string[] } | null = null;

        if (is_completed !== undefined) {
            const isCompleted = Boolean(is_completed);
            const wasCompleted = Boolean(existing.is_completed);
            pushUpdate('is_completed', isCompleted);
            // Only touch completed_at on a real transition: a repeated
            // "is_completed: true" PUT must not refresh the timestamp, which
            // anchors the earn transactions of the current completion cycle.
            if (isCompleted !== wasCompleted) {
                updates.push(`completed_at = ${isCompleted ? 'NOW()' : 'NULL'}`);
            }

            if (isCompleted && !wasCompleted) {
                // Completion transition (false → true) only — repeated PUTs with
                // is_completed already true never award twice.
                const effectivePoints = points !== undefined && isParent
                    ? sanitizePoints(points)
                    : sanitizePoints(existing.points);
                const effectiveAssigned: string[] = assigned_to !== undefined && Array.isArray(assigned_to)
                    ? assigned_to.filter((mid: any) => typeof mid === 'string' && mid.trim())
                    : (Array.isArray(existing.assigned_to) ? existing.assigned_to : []);

                if (effectivePoints > 0 && effectiveAssigned.length > 0) {
                    if (isParent) {
                        awardAfterUpdate = { points: effectivePoints, assigned_to: effectiveAssigned };
                        updates.push('pending_approval = false');
                        rewardsChanged = true;
                    } else {
                        // A child completing a points chore must wait for a parent.
                        updates.push('pending_approval = true');
                        rewardsChanged = true; // pending-approval counters change
                    }
                }

                // Auto-gestion (post-version n°2 + C) : une corvée récurrente
                // voit son échéance avancer au cycle suivant DANS LA MÊME
                // écriture que la complétion (une seule UPDATE). Un due_date
                // explicite dans la requête gagne sur le calcul automatique.
                if (due_date === undefined) {
                    const effectiveAnchor = anchor !== undefined ? anchor : (existing.recurrence_anchor ?? null);
                    const nextDue = nextTaskDueDateOnComplete(effectiveAnchor, existing.due_date, effectiveFrequency, new Date(), effectiveCustom);
                    if (nextDue) pushUpdate('due_date', nextDue);
                }
            } else if (!isCompleted && wasCompleted) {
                // Un-completing reverses the CURRENT completion only: earn
                // transactions created at-or-after completed_at belong to this
                // cycle (recurring chores are re-completed later, producing new
                // rows with later timestamps — earlier cycles stay untouched).
                const deleted = await query(
                    `DELETE FROM reward_transactions
                     WHERE task_id = $1 AND user_id = $2 AND type = 'earn'
                       AND created_at >= COALESCE($3::timestamp, '-infinity'::timestamp)
                     RETURNING id`,
                    [id, req.userId, existing.completed_at || null]
                );
                if (deleted.rows.length > 0) rewardsChanged = true;
                if (existing.pending_approval) {
                    updates.push('pending_approval = false');
                    rewardsChanged = true;
                }
            }
        }

        if (updates.length === 0) {
            return res.status(400).json({ success: false, error: 'No fields to update' });
        }

        const result = await query(
            `UPDATE tasks
       SET ${updates.join(', ')}
       WHERE id = $${values.length + 1} AND user_id = $${values.length + 2}
       RETURNING *`,
            [...values, id, req.userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Task not found' });
        }

        if (awardAfterUpdate) {
            await awardTaskPoints(
                { id, title: result.rows[0].title, points: awardAfterUpdate.points, assigned_to: awardAfterUpdate.assigned_to },
                req.userId!
            );
        }

        const [enriched] = await enrichTasksWithMembers([result.rows[0]], req.userId!);
        broadcast(req.userId!, { type: 'update', entity: 'tasks', action: 'updated' });
        if (rewardsChanged) {
            broadcast(req.userId!, { type: 'update', entity: 'rewards', action: 'updated' });
        }
        res.json({ success: true, data: enriched });
    } catch (error) {
        if (error instanceof Error && error.message === 'INVALID_MEMBER') {
            return res.status(400).json({ success: false, error: 'Assigned member not found' });
        }

        console.error('Update task error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Approve a child-completed task: credit the points and clear the pending flag
router.post('/:id/approve', requireParent, async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;

        const existingResult = await query(
            'SELECT * FROM tasks WHERE id = $1 AND user_id = $2',
            [id, req.userId]
        );
        if (existingResult.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Task not found' });
        }
        const task = existingResult.rows[0];
        if (!task.pending_approval) {
            return res.status(400).json({ success: false, error: 'Task is not awaiting approval' });
        }

        const assignedTo: string[] = Array.isArray(task.assigned_to) ? task.assigned_to : [];
        const taskPoints = sanitizePoints(task.points);
        if (taskPoints > 0 && assignedTo.length > 0) {
            await awardTaskPoints({ id, title: task.title, points: taskPoints, assigned_to: assignedTo }, req.userId!);
        }

        const result = await query(
            'UPDATE tasks SET pending_approval = false WHERE id = $1 AND user_id = $2 RETURNING *',
            [id, req.userId]
        );

        const [enriched] = await enrichTasksWithMembers([result.rows[0]], req.userId!);
        broadcast(req.userId!, { type: 'update', entity: 'tasks', action: 'updated' });
        broadcast(req.userId!, { type: 'update', entity: 'rewards', action: 'updated' });
        res.json({ success: true, data: enriched });
    } catch (error) {
        console.error('Approve task error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Reject a child-completed task: no points, and the chore must be redone
router.post('/:id/reject', requireParent, async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;

        const existingResult = await query(
            'SELECT * FROM tasks WHERE id = $1 AND user_id = $2',
            [id, req.userId]
        );
        if (existingResult.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Task not found' });
        }
        if (!existingResult.rows[0].pending_approval) {
            return res.status(400).json({ success: false, error: 'Task is not awaiting approval' });
        }

        const result = await query(
            `UPDATE tasks
             SET pending_approval = false, is_completed = false, completed_at = NULL
             WHERE id = $1 AND user_id = $2 RETURNING *`,
            [id, req.userId]
        );

        const [enriched] = await enrichTasksWithMembers([result.rows[0]], req.userId!);
        broadcast(req.userId!, { type: 'update', entity: 'tasks', action: 'updated' });
        broadcast(req.userId!, { type: 'update', entity: 'rewards', action: 'updated' });
        res.json({ success: true, data: enriched });
    } catch (error) {
        console.error('Reject task error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Delete task
router.delete('/:id', async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;

        const result = await query(
            'DELETE FROM tasks WHERE id = $1 AND user_id = $2 RETURNING id',
            [id, req.userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Task not found' });
        }

        broadcast(req.userId!, { type: 'update', entity: 'tasks', action: 'deleted' });
        res.json({ success: true, message: 'Task deleted' });
    } catch (error) {
        console.error('Delete task error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Get task statistics
router.get('/statistics', async (req: AuthRequest, res) => {
    try {
        const result = await query(
            `SELECT
         COUNT(*) as total,
         COUNT(*) FILTER (WHERE is_completed = true) as completed,
         COUNT(*) FILTER (WHERE is_completed = false) as pending,
         COUNT(*) FILTER (WHERE priority = 'Haute') as high_priority,
         COUNT(*) FILTER (WHERE priority = 'Moyenne') as medium_priority,
         COUNT(*) FILTER (WHERE priority = 'Basse') as low_priority
       FROM tasks WHERE user_id = $1`,
            [req.userId]
        );

        const stats = result.rows[0];
        const total = parseInt(stats.total, 10) || 0;
        const completed = parseInt(stats.completed, 10) || 0;
        const completionRate = total > 0 ? (completed / total) * 100 : 0;

        res.json({
            success: true,
            data: {
                total,
                completed,
                pending: parseInt(stats.pending, 10) || 0,
                completionRate: Math.round(completionRate),
                byPriority: {
                    Haute: parseInt(stats.high_priority, 10) || 0,
                    Moyenne: parseInt(stats.medium_priority, 10) || 0,
                    Basse: parseInt(stats.low_priority, 10) || 0,
                },
            },
        });
    } catch (error) {
        console.error('Get task statistics error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

export default router;
