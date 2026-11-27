import { Router } from 'express';
import { query, withTransaction } from '../db';
import { authMiddleware, AuthRequest, requireParent } from '../middleware/auth';
import { broadcast } from '../lib/broadcaster';
// Shared constants: the package is a proper ESM package now ("type": "module",
// NodeNext emit with explicit '.js' extensions, checked at build time by
// shared/scripts/check-dist.mjs), so the server can runtime-import it.
import { LIST_ICONS, LIST_NAME_MAX, LIST_ITEM_TEXT_MAX, LIST_CATEGORY_MAX } from '@openfamily/shared';

/**
 * Module Listes (fonctionnalité 15 du fork) : liste de listes familiales.
 * Toute la famille voit tout ; la gestion des LISTES et des catégories en
 * masse (créer/renommer/supprimer) est réservée aux parents (requireParent),
 * les ITEMS (ajouter/cocher/éditer/supprimer) sont ouverts à tous les membres.
 *
 * Toutes les routes passent par authMiddleware : aucun endpoint public.
 * Les mappeurs sont null-safe (category/created_by/checked_by peuvent être
 * NULL). Validation stricte, 400 hors bornes (texte 1..200, catégorie
 * ≤ 60, nom de liste 1..120, icône dans le jeu fixe LIST_ICONS).
 */

const router = Router();
router.use(authMiddleware);

const iconSet = new Set<string>(LIST_ICONS as readonly string[]);

/** Trimmed, bounds-checked list name — null when absent, undefined when invalid. */
const cleanName = (value: unknown): string | null | undefined => {
    if (value === undefined) return undefined;
    const name = typeof value === 'string' ? value.trim() : '';
    if (name.length < 1 || name.length > LIST_NAME_MAX) return null;
    return name;
};

const cleanIcon = (value: unknown): string | null | undefined => {
    if (value === undefined) return undefined;
    if (value === null) return null; // retour au défaut
    if (typeof value !== 'string' || !iconSet.has(value)) return null;
    return value;
};

const cleanText = (value: unknown): string | null | undefined => {
    if (value === undefined) return undefined;
    const text = typeof value === 'string' ? value.trim() : '';
    if (text.length < 1 || text.length > LIST_ITEM_TEXT_MAX) return null;
    return text;
};

/**
 * Category: free text, trimmed. Distinguishes "absent" (undefined, field not
 * sent), "empty/null → NULL", and "too long → invalid" so the API can 400
 * only on real garbage while an empty string legitimately clears the field.
 */
const parseCategory = (value: unknown): { ok: true; category?: string | null } | { ok: false } => {
    if (value === undefined) return { ok: true };
    if (value === null) return { ok: true, category: null };
    const category = typeof value === 'string' ? value.trim() : '';
    if (category === '') return { ok: true, category: null };
    if (category.length > LIST_CATEGORY_MAX) return { ok: false };
    return { ok: true, category };
};

/** The member profile linked to the actual account, if any. */
const memberIdOf = async (ownerId: string, actualUserId: string | undefined): Promise<string | null> => {
    if (!actualUserId) return null;
    const res = await query(
        'SELECT id FROM family_members WHERE user_id = $1 AND linked_user_id = $2 LIMIT 1',
        [ownerId, actualUserId]
    );
    return res.rows.length > 0 ? String(res.rows[0].id) : null;
};

const mapList = (row: any) => ({
    id: String(row.id),
    name: String(row.name),
    icon: String(row.icon),
    created_by: row.created_by ?? null,
    created_at: row.created_at ?? null,
    counts: {
        total: Number(row.total ?? 0),
        unchecked: Number(row.unchecked ?? 0),
        done: Number(row.done ?? 0),
    },
});

/** Null-safe item mapper. */
const mapItem = (row: any) => ({
    id: String(row.id),
    list_id: String(row.list_id),
    text: String(row.text),
    category: row.category ?? null,
    checked: Boolean(row.checked),
    checked_by: row.checked_by ?? null,
    checked_at: row.checked_at ?? null,
    position: Number(row.position),
    created_by: row.created_by ?? null,
    created_at: row.created_at ?? null,
});

/** The list must belong to the requester's family — 404 otherwise. */
const familyList = async (listId: string, ownerId: string) => {
    const res = await query('SELECT * FROM lists WHERE id = $1 AND user_id = $2', [listId, ownerId]);
    return res.rows.length > 0 ? res.rows[0] : null;
};

// ─── Lists ────────────────────────────────────────────────────────────────────

// GET /api/lists — every list with its counters (LEFT JOIN + aggregates).
// The client sorts (pinned first, then creation order).
router.get('/', async (req: AuthRequest, res) => {
    try {
        const result = await query(
            `SELECT l.id, l.name, l.icon, l.created_by, l.created_at,
                    COUNT(i.id)::int AS total,
                    COUNT(i.id) FILTER (WHERE NOT i.checked)::int AS unchecked,
                    COUNT(i.id) FILTER (WHERE i.checked)::int AS done
             FROM lists l
             LEFT JOIN list_items i ON i.list_id = l.id
             WHERE l.user_id = $1
             GROUP BY l.id
             ORDER BY l.created_at ASC, l.id ASC`,
            [req.userId]
        );
        res.json({ success: true, data: result.rows.map(mapList) });
    } catch (error) {
        console.error('Get lists error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// POST /api/lists — parents only.
router.post('/', requireParent, async (req: AuthRequest, res) => {
    try {
        const name = cleanName(req.body?.name);
        if (name === null || name === undefined) {
            return res.status(400).json({ success: false, error: 'Invalid name' });
        }
        const icon = cleanIcon(req.body?.icon);
        if (icon === null) {
            return res.status(400).json({ success: false, error: 'Invalid icon' });
        }
        const createdBy = await memberIdOf(req.userId!, req.actualUserId);
        const result = await query(
            'INSERT INTO lists (user_id, name, icon, created_by) VALUES ($1, $2, $3, $4) RETURNING *',
            [req.userId, name, icon ?? '📝', createdBy]
        );
        broadcast(req.userId!, { type: 'update', entity: 'lists', action: 'created' });
        res.json({ success: true, data: mapList({ ...result.rows[0], total: 0, unchecked: 0, done: 0 }) });
    } catch (error) {
        console.error('Create list error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// PUT /api/lists/:id — rename and/or change icon, parents only.
router.put('/:id', requireParent, async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;
        if (!(await familyList(id, req.userId!))) {
            return res.status(404).json({ success: false, error: 'List not found' });
        }
        const name = cleanName(req.body?.name);
        if (name === null) return res.status(400).json({ success: false, error: 'Invalid name' });
        const icon = cleanIcon(req.body?.icon);
        if (icon === null) return res.status(400).json({ success: false, error: 'Invalid icon' });
        if (name === undefined && icon === undefined) {
            return res.status(400).json({ success: false, error: 'No fields to update' });
        }
        const updates: string[] = [];
        const values: any[] = [];
        if (name !== undefined) {
            values.push(name);
            updates.push(`name = $${values.length}`);
        }
        if (icon !== undefined) {
            values.push(icon ?? '📝');
            updates.push(`icon = $${values.length}`);
        }
        values.push(id, req.userId);
        const result = await query(
            `UPDATE lists SET ${updates.join(', ')} WHERE id = $${values.length - 1} AND user_id = $${values.length} RETURNING *`,
            values
        );
        broadcast(req.userId!, { type: 'update', entity: 'lists', action: 'updated' });
        res.json({ success: true, data: mapList({ ...result.rows[0], total: 0, unchecked: 0, done: 0 }) });
    } catch (error) {
        console.error('Update list error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// DELETE /api/lists/:id — parents only; items cascade.
router.delete('/:id', requireParent, async (req: AuthRequest, res) => {
    try {
        const result = await query(
            'DELETE FROM lists WHERE id = $1 AND user_id = $2 RETURNING id',
            [req.params.id, req.userId]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'List not found' });
        }
        broadcast(req.userId!, { type: 'update', entity: 'lists', action: 'deleted' });
        res.json({ success: true, message: 'List deleted' });
    } catch (error) {
        console.error('Delete list error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// GET /api/lists/:id/items — items by position + counters per category.
router.get('/:id/items', async (req: AuthRequest, res) => {
    try {
        const list = await familyList(req.params.id, req.userId!);
        if (!list) return res.status(404).json({ success: false, error: 'List not found' });
        const items = await query(
            `SELECT * FROM list_items WHERE list_id = $1 ORDER BY position ASC, id ASC`,
            [list.id]
        );
        const cats = await query(
            `SELECT category,
                    COUNT(*)::int AS total,
                    COUNT(*) FILTER (WHERE NOT checked)::int AS unchecked,
                    MIN(position)::int AS first_position
             FROM list_items WHERE list_id = $1 GROUP BY category`,
            [list.id]
        );
        res.json({
            success: true,
            data: {
                list: mapList({ ...list, total: 0, unchecked: 0, done: 0 }),
                items: items.rows.map(mapItem),
                categories: cats.rows.map((c: any) => ({
                    name: c.category ?? null,
                    total: Number(c.total),
                    unchecked: Number(c.unchecked),
                    firstPosition: Number(c.first_position),
                })),
            },
        });
    } catch (error) {
        console.error('Get list items error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// POST /api/lists/:id/items — every member. position = MAX+1 (creation order).
router.post('/:id/items', async (req: AuthRequest, res) => {
    try {
        const list = await familyList(req.params.id, req.userId!);
        if (!list) return res.status(404).json({ success: false, error: 'List not found' });
        const text = cleanText(req.body?.text);
        if (text === null || text === undefined) {
            return res.status(400).json({ success: false, error: 'Invalid text' });
        }
        const category = parseCategory(req.body?.category);
        if (!category.ok) {
            return res.status(400).json({ success: false, error: 'Invalid category' });
        }
        const createdBy = await memberIdOf(req.userId!, req.actualUserId);
        const result = await query(
            `INSERT INTO list_items (list_id, text, category, position, created_by)
             VALUES ($1, $2, $3, (SELECT COALESCE(MAX(position), 0) + 1 FROM list_items WHERE list_id = $1), $4)
             RETURNING *`,
            [list.id, text, category.category ?? null, createdBy]
        );
        broadcast(req.userId!, { type: 'update', entity: 'lists', action: 'updated' });
        res.json({ success: true, data: mapItem(result.rows[0]) });
    } catch (error) {
        console.error('Create list item error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// PUT /api/lists/:id/category — rename a category on every item (batch, parents only).
router.put('/:id/category', requireParent, async (req: AuthRequest, res) => {
    try {
        const list = await familyList(req.params.id, req.userId!);
        if (!list) return res.status(404).json({ success: false, error: 'List not found' });
        const rawFrom = req.body?.from;
        const from = parseCategory(rawFrom);
        const to = parseCategory(req.body?.to);
        // G2: an explicit `from: null` targets the virtual "Sans catégorie"
        // bucket (category IS NULL). A missing/empty `from` stays invalid
        // (NULL-as-target is the DELETE route's job).
        const fromIsNullBucket = rawFrom === null;
        if (!from.ok || (!fromIsNullBucket && (from.category === null || from.category === undefined))) {
            return res.status(400).json({ success: false, error: 'Invalid from' });
        }
        if (!to.ok || to.category === null || to.category === undefined) {
            return res.status(400).json({ success: false, error: 'Invalid to' });
        }
        // Renaming onto an existing category name MERGES into it (categories
        // are derived from items, there is no separate category table) — same
        // behavior whether the source is a real category or the NULL bucket.
        const result = fromIsNullBucket
            ? await query(
                'UPDATE list_items SET category = $2 WHERE list_id = $1 AND category IS NULL RETURNING id',
                [list.id, to.category]
            )
            : await query(
                'UPDATE list_items SET category = $3 WHERE list_id = $1 AND category = $2 RETURNING id',
                [list.id, from.category, to.category]
            );
        broadcast(req.userId!, { type: 'update', entity: 'lists', action: 'updated' });
        res.json({ success: true, data: { updated: result.rows.length } });
    } catch (error) {
        console.error('Rename category error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// DELETE /api/lists/:id/category — set the category of every item to NULL (parents only).
// The name arrives in the body, or in ?name= (the client's api.delete sends no body).
router.delete('/:id/category', requireParent, async (req: AuthRequest, res) => {
    try {
        const list = await familyList(req.params.id, req.userId!);
        if (!list) return res.status(404).json({ success: false, error: 'List not found' });
        const raw = req.body?.name ?? req.query.name;
        const name = parseCategory(raw);
        if (!name.ok || name.category === null || name.category === undefined) {
            return res.status(400).json({ success: false, error: 'Invalid name' });
        }
        const result = await query(
            'UPDATE list_items SET category = NULL WHERE list_id = $1 AND category = $2 RETURNING id',
            [list.id, name.category]
        );
        broadcast(req.userId!, { type: 'update', entity: 'lists', action: 'updated' });
        res.json({ success: true, data: { updated: result.rows.length } });
    } catch (error) {
        console.error('Delete category error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// ─── Items (mounted at /api/items) ────────────────────────────────────────────

export const itemsRouter = Router();
itemsRouter.use(authMiddleware);

/** The item must belong to a list of the requester's family — 404 otherwise. */
const familyItem = async (itemId: string, ownerId: string) => {
    const res = await query(
        `SELECT i.* FROM list_items i JOIN lists l ON l.id = i.list_id
         WHERE i.id = $1 AND l.user_id = $2`,
        [itemId, ownerId]
    );
    return res.rows.length > 0 ? res.rows[0] : null;
};

// PUT /api/items/:id — every member: edit text/category, check/uncheck.
itemsRouter.put('/:id', async (req: AuthRequest, res) => {
    try {
        const existing = await familyItem(req.params.id, req.userId!);
        if (!existing) return res.status(404).json({ success: false, error: 'Item not found' });

        const text = cleanText(req.body?.text);
        if (text === null) return res.status(400).json({ success: false, error: 'Invalid text' });
        const category = parseCategory(req.body?.category);
        if (!category.ok) return res.status(400).json({ success: false, error: 'Invalid category' });
        const checked = req.body?.checked;
        if (checked !== undefined && typeof checked !== 'boolean') {
            return res.status(400).json({ success: false, error: 'Invalid checked' });
        }
        if (text === undefined && category.category === undefined && checked === undefined) {
            return res.status(400).json({ success: false, error: 'No fields to update' });
        }

        const updates: string[] = [];
        const values: any[] = [];
        if (text !== undefined) {
            values.push(text);
            updates.push(`text = $${values.length}`);
        }
        if (category.category !== undefined) {
            values.push(category.category);
            updates.push(`category = $${values.length}`);
        }
        if (checked !== undefined) {
            values.push(checked);
            updates.push(`checked = $${values.length}`);
            if (checked) {
                const memberId = await memberIdOf(req.userId!, req.actualUserId);
                values.push(memberId);
                updates.push(`checked_by = $${values.length}`);
                updates.push('checked_at = NOW()');
            } else {
                updates.push('checked_by = NULL');
                updates.push('checked_at = NULL');
            }
        }
        values.push(req.params.id, req.userId);
        const result = await query(
            `UPDATE list_items i SET ${updates.join(', ')}
             FROM lists l
             WHERE i.id = $${values.length - 1} AND l.id = i.list_id AND l.user_id = $${values.length}
             RETURNING i.*`,
            values
        );
        broadcast(req.userId!, { type: 'update', entity: 'lists', action: 'updated' });
        res.json({ success: true, data: mapItem(result.rows[0]) });
    } catch (error) {
        console.error('Update list item error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// PUT /api/items/:id/move — every member. Moves the item ONE rank inside its
// category by swapping `position` with the position-adjacent item of the SAME
// category AND same checked state (the displayed order sorts unchecked first
// within a category, so a move only makes sense within the same stratum).
// At a bound there is no neighbor: idempotent no-op { moved: false }.
// No drag & drop in v1; moving across categories stays with the category
// dropdown (PUT /api/items/:id { category }).
itemsRouter.put('/:id/move', async (req: AuthRequest, res) => {
    try {
        const existing = await familyItem(req.params.id, req.userId!);
        if (!existing) return res.status(404).json({ success: false, error: 'Item not found' });
        const direction = req.body?.direction;
        if (direction !== 'up' && direction !== 'down') {
            return res.status(400).json({ success: false, error: 'Invalid direction' });
        }
        const position = Number(existing.position);
        // 'up' = towards the top of the category = smaller position.
        const neighbor = await query(
            `SELECT id, position FROM list_items
             WHERE list_id = $1
               AND category IS NOT DISTINCT FROM $2
               AND checked = $3
               AND ${direction === 'up' ? 'position < $4' : 'position > $4'}
             ORDER BY position ${direction === 'up' ? 'DESC' : 'ASC'}
             LIMIT 1`,
            [existing.list_id, existing.category ?? null, Boolean(existing.checked), position]
        );
        if (neighbor.rows.length === 0) {
            return res.json({ success: true, data: { moved: false, item: mapItem(existing) } });
        }
        const other = neighbor.rows[0];
        await withTransaction(async (tx) => {
            await tx.query('UPDATE list_items SET position = $2 WHERE id = $1', [existing.id, Number(other.position)]);
            await tx.query('UPDATE list_items SET position = $2 WHERE id = $1', [other.id, position]);
        });
        const updated = await familyItem(req.params.id, req.userId!);
        broadcast(req.userId!, { type: 'update', entity: 'lists', action: 'updated' });
        res.json({ success: true, data: { moved: true, item: mapItem(updated) } });
    } catch (error) {
        console.error('Move list item error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// DELETE /api/items/:id — every member.
itemsRouter.delete('/:id', async (req: AuthRequest, res) => {
    try {
        const result = await query(
            `DELETE FROM list_items i USING lists l
             WHERE i.id = $1 AND l.id = i.list_id AND l.user_id = $2
             RETURNING i.id`,
            [req.params.id, req.userId]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Item not found' });
        }
        broadcast(req.userId!, { type: 'update', entity: 'lists', action: 'updated' });
        res.json({ success: true, message: 'Item deleted' });
    } catch (error) {
        console.error('Delete list item error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

export default router;
