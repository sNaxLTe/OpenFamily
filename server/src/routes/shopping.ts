import { Router } from 'express';
import { getClient, query } from '../db';
import { authMiddleware, AuthRequest, requireParent } from '../middleware/auth';
import { toNullIfEmpty, toOptionalNumber } from '../lib/normalize';
import { broadcast } from '../lib/broadcaster';
// Shared constants: the package is a proper ESM package now ("type": "module",
// NodeNext emit with explicit '.js' extensions, checked at build time by
// shared/scripts/check-dist.mjs), so the server can runtime-import it.
import { LIST_ICONS, SHOPPING_STORE_NAME_MAX } from '@openfamily/shared';

const router = Router();

// All routes require authentication
router.use(authMiddleware);

const storeIconSet = new Set<string>(LIST_ICONS as readonly string[]);

/**
 * Validates a store_id coming from the client: undefined = champ absent (on
 * ne touche pas à la colonne), null/'' = retour à « Général » (NULL), une UUID
 * doit appartenir à un magasin de la famille (sinon 404, défense anti-garbage),
 * tout le reste est un 400.
 */
const parseStoreId = async (
    value: unknown,
    userId: string
): Promise<{ ok: true; storeId?: string | null } | { ok: false; status: number; error: string }> => {
    if (value === undefined) return { ok: true };
    if (value === null || value === '') return { ok: true, storeId: null };
    if (typeof value !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(value)) {
        return { ok: false, status: 400, error: 'Invalid store_id' };
    }
    const found = await query('SELECT id FROM shopping_stores WHERE id = $1 AND user_id = $2', [value, userId]);
    if (found.rows.length === 0) return { ok: false, status: 404, error: 'Store not found' };
    return { ok: true, storeId: value };
};

// ─── Shopping stores (annual/0010, fonctionnalité 16 du fork) ────────────────
// Onglets « magasin » de la page Courses. Lecture : tous les membres ;
// création/renommage/suppression : parents seuls (requireParent), cohérent
// avec le module Listes. La suppression laisse les articles dans « Général »
// via la FK ON DELETE SET NULL (jamais de perte).

// List the family's stores, ordered by tab position
router.get('/stores', async (req: AuthRequest, res) => {
    try {
        const result = await query(
            'SELECT id, name, icon, position, created_at FROM shopping_stores WHERE user_id = $1 ORDER BY position, created_at',
            [req.userId]
        );
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error('Get shopping stores error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Create a store (parents only) — position = max+1, tabs append at the end
router.post('/stores', requireParent, async (req: AuthRequest, res) => {
    try {
        const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
        const icon = req.body?.icon === undefined ? '🛒' : req.body.icon;
        if (!name || name.length > SHOPPING_STORE_NAME_MAX) {
            return res.status(400).json({ success: false, error: 'Invalid store name' });
        }
        if (typeof icon !== 'string' || !storeIconSet.has(icon)) {
            return res.status(400).json({ success: false, error: 'Invalid store icon' });
        }
        const result = await query(
            `INSERT INTO shopping_stores (user_id, name, icon, position)
       SELECT $1, $2, $3, COALESCE(MAX(position), 0) + 1 FROM shopping_stores WHERE user_id = $1
       RETURNING id, name, icon, position, created_at`,
            [req.userId, name, icon]
        );
        broadcast(req.userId!, { type: 'update', entity: 'shopping', action: 'created' });
        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error('Create shopping store error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Update a store (parents only). position, when sent, REORDERS the tabs
// (move-with-shift, clamped to [1, count]): stores between the old and the new
// position shift by one, the others keep theirs. No swap: the moved tab lands
// exactly where asked.
router.put('/stores/:id', requireParent, async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;
        const existing = await query(
            'SELECT id, position FROM shopping_stores WHERE id = $1 AND user_id = $2',
            [id, req.userId]
        );
        if (existing.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Store not found' });
        }
        const oldPosition = Number(existing.rows[0].position);

        const name = req.body?.name === undefined ? undefined : typeof req.body.name === 'string' ? req.body.name.trim() : '';
        if (name !== undefined && (!name || name.length > SHOPPING_STORE_NAME_MAX)) {
            return res.status(400).json({ success: false, error: 'Invalid store name' });
        }
        const icon = req.body?.icon;
        if (icon !== undefined && (typeof icon !== 'string' || !storeIconSet.has(icon))) {
            return res.status(400).json({ success: false, error: 'Invalid store icon' });
        }
        let position = req.body?.position;
        if (position !== undefined) {
            position = toOptionalNumber(position);
            if (position === null || !Number.isInteger(position) || position < 1) {
                return res.status(400).json({ success: false, error: 'Invalid store position' });
            }
            position = Math.floor(position);
        }

        const client = await getClient();
        try {
            await client.query('BEGIN');
            if (position !== undefined && position !== oldPosition) {
                const count = await client.query(
                    'SELECT COUNT(*)::int AS n FROM shopping_stores WHERE user_id = $1',
                    [req.userId]
                );
                const target = Math.min(position, count.rows[0].n);
                if (target < oldPosition) {
                    await client.query(
                        'UPDATE shopping_stores SET position = position + 1 WHERE user_id = $1 AND id <> $2 AND position >= $3 AND position < $4',
                        [req.userId, id, target, oldPosition]
                    );
                } else {
                    await client.query(
                        'UPDATE shopping_stores SET position = position - 1 WHERE user_id = $1 AND id <> $2 AND position <= $3 AND position > $4',
                        [req.userId, id, target, oldPosition]
                    );
                }
                await client.query('UPDATE shopping_stores SET position = $1 WHERE id = $2 AND user_id = $3', [
                    target, id, req.userId,
                ]);
            }
            const result = await client.query(
                `UPDATE shopping_stores
         SET name = COALESCE($1, name), icon = COALESCE($2, icon)
         WHERE id = $3 AND user_id = $4
         RETURNING id, name, icon, position, created_at`,
                [name ?? null, icon ?? null, id, req.userId]
            );
            await client.query('COMMIT');
            broadcast(req.userId!, { type: 'update', entity: 'shopping', action: 'updated' });
            res.json({ success: true, data: result.rows[0] });
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Update shopping store error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Delete a store (parents only) — its items fall back to "Général" (store_id
// NULL) through the FK ON DELETE SET NULL
router.delete('/stores/:id', requireParent, async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;
        const result = await query(
            'DELETE FROM shopping_stores WHERE id = $1 AND user_id = $2 RETURNING id',
            [id, req.userId]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Store not found' });
        }
        broadcast(req.userId!, { type: 'update', entity: 'shopping', action: 'deleted' });
        res.json({ success: true, message: 'Store deleted' });
    } catch (error) {
        console.error('Delete shopping store error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Get all shopping items
router.get('/', async (req: AuthRequest, res) => {
    try {
        const result = await query(
            'SELECT * FROM shopping_items WHERE user_id = $1 ORDER BY created_at DESC',
            [req.userId]
        );
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error('Get shopping items error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Create shopping item
router.post('/', async (req: AuthRequest, res) => {
    try {
        const { name, category, quantity, unit, price, notes } = req.body;
        const cleanedName = typeof name === 'string' ? name.trim() : '';
        const cleanedCategory = typeof category === 'string' ? category.trim() : '';
        const parsedQuantity = quantity !== undefined ? toOptionalNumber(quantity) : null;
        const parsedPrice = price !== undefined ? toOptionalNumber(price) : null;

        if (!cleanedName || !cleanedCategory) {
            return res.status(400).json({ success: false, error: 'name and category are required' });
        }

        if (quantity !== undefined && quantity !== '' && parsedQuantity === null) {
            return res.status(400).json({ success: false, error: 'Invalid quantity format' });
        }

        if (price !== undefined && price !== '' && parsedPrice === null) {
            return res.status(400).json({ success: false, error: 'Invalid price format' });
        }

        // store_id optionnel (annual/0010) : null/absent = onglet « Général ».
        const parsedStore = await parseStoreId(req.body.store_id, req.userId!);
        if (!parsedStore.ok) {
            return res.status(parsedStore.status).json({ success: false, error: parsedStore.error });
        }

        const result = await query(
            `INSERT INTO shopping_items (user_id, name, category, quantity, unit, price, notes, store_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
            [
                req.userId,
                cleanedName,
                cleanedCategory,
                parsedQuantity,
                toNullIfEmpty(unit),
                parsedPrice,
                toNullIfEmpty(notes),
                parsedStore.storeId ?? null,
            ]
        );

        broadcast(req.userId!, { type: 'update', entity: 'shopping', action: 'created' });
        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error('Create shopping item error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Update shopping item
router.put('/:id', async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;
        const { name, category, quantity, unit, price, is_checked, notes } = req.body;

        const cleanedName = name !== undefined ? toNullIfEmpty(name) : undefined;
        const cleanedCategory = category !== undefined ? toNullIfEmpty(category) : undefined;
        const parsedQuantity = quantity !== undefined ? toOptionalNumber(quantity) : undefined;
        const parsedPrice = price !== undefined ? toOptionalNumber(price) : undefined;

        if (quantity !== undefined && quantity !== '' && parsedQuantity === null) {
            return res.status(400).json({ success: false, error: 'Invalid quantity format' });
        }

        if (price !== undefined && price !== '' && parsedPrice === null) {
            return res.status(400).json({ success: false, error: 'Invalid price format' });
        }

        // store_id (annual/0010) : clé absente = on garde la valeur, null/''
        // = retour à « Général », UUID valide d'un magasin de la famille =
        // déplacement vers ce magasin (sinon 404).
        const parsedStore = await parseStoreId(req.body.store_id, req.userId!);
        if (!parsedStore.ok) {
            return res.status(parsedStore.status).json({ success: false, error: parsedStore.error });
        }

        const setClauses = [
            'name = COALESCE($1, name)',
            'category = COALESCE($2, category)',
            'quantity = COALESCE($3, quantity)',
            'unit = COALESCE($4, unit)',
            'price = COALESCE($5, price)',
            'is_checked = COALESCE($6, is_checked)',
            'notes = COALESCE($7, notes)',
        ];
        const params: unknown[] = [
            cleanedName,
            cleanedCategory,
            parsedQuantity,
            unit !== undefined ? toNullIfEmpty(unit) : undefined,
            parsedPrice,
            is_checked !== undefined ? Boolean(is_checked) : undefined,
            notes !== undefined ? toNullIfEmpty(notes) : undefined,
        ];
        // COALESCE ne convient pas ici : store_id = NULL doit VRAIMENT passer
        // à NULL (déplacement vers Général), pas conserver l'ancienne valeur.
        if (parsedStore.storeId !== undefined) {
            params.push(parsedStore.storeId);
            setClauses.push(`store_id = $${params.length}`);
        }
        params.push(id, req.userId);

        const result = await query(
            `UPDATE shopping_items
       SET ${setClauses.join(', ')}
       WHERE id = $${params.length - 1} AND user_id = $${params.length} RETURNING *`,
            params
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Item not found' });
        }

        broadcast(req.userId!, { type: 'update', entity: 'shopping', action: 'updated' });
        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error('Update shopping item error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Delete shopping item
router.delete('/:id', async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;

        const result = await query(
            'DELETE FROM shopping_items WHERE id = $1 AND user_id = $2 RETURNING id',
            [id, req.userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Item not found' });
        }

        broadcast(req.userId!, { type: 'update', entity: 'shopping', action: 'deleted' });
        res.json({ success: true, message: 'Item deleted' });
    } catch (error) {
        console.error('Delete shopping item error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Clear checked items
router.delete('/checked/clear', async (req: AuthRequest, res) => {
    try {
        await query(
            'DELETE FROM shopping_items WHERE user_id = $1 AND is_checked = true',
            [req.userId]
        );

        broadcast(req.userId!, { type: 'update', entity: 'shopping', action: 'deleted' });
        res.json({ success: true, message: 'Checked items cleared' });
    } catch (error) {
        console.error('Clear checked items error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Get templates
router.get('/templates', async (req: AuthRequest, res) => {
    try {
        const result = await query(
            'SELECT * FROM shopping_list_templates WHERE user_id = $1 ORDER BY name',
            [req.userId]
        );
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error('Get templates error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Create template
router.post('/templates', async (req: AuthRequest, res) => {
    try {
        const { name, items } = req.body;
        const cleanedName = typeof name === 'string' ? name.trim() : '';
        const normalizedItems = Array.isArray(items) ? items : [];

        if (!cleanedName || normalizedItems.length === 0) {
            return res.status(400).json({ success: false, error: 'name and items are required' });
        }

        const result = await query(
            'INSERT INTO shopping_list_templates (user_id, name, items) VALUES ($1, $2, $3) RETURNING *',
            [req.userId, cleanedName, JSON.stringify(normalizedItems)]
        );

        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error('Create template error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Apply template to shopping list
router.post('/templates/:id/apply', async (req: AuthRequest, res) => {
    const client = await getClient();
    try {
        const { id } = req.params;

        const templateResult = await client.query(
            'SELECT items FROM shopping_list_templates WHERE id = $1 AND user_id = $2',
            [id, req.userId]
        );

        if (templateResult.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Template not found' });
        }

        const rawItems = templateResult.rows[0].items;
        const items = Array.isArray(rawItems) ? rawItems : [];

        if (items.length === 0) {
            return res.status(400).json({ success: false, error: 'Template is empty' });
        }

        await client.query('BEGIN');

        for (const item of items) {
            const itemName = typeof item?.name === 'string' ? item.name.trim() : '';
            const itemCategory = typeof item?.category === 'string' ? item.category.trim() : '';
            if (!itemName || !itemCategory) {
                continue;
            }

            await client.query(
                `INSERT INTO shopping_items (user_id, name, category, quantity, unit, price, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [
                    req.userId,
                    itemName,
                    itemCategory,
                    toOptionalNumber(item?.quantity),
                    toNullIfEmpty(item?.unit),
                    toOptionalNumber(item?.price),
                    toNullIfEmpty(item?.notes),
                ]
            );
        }

        await client.query('COMMIT');
        broadcast(req.userId!, { type: 'update', entity: 'shopping', action: 'created' });
        res.json({ success: true, message: 'Template applied' });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Apply template error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    } finally {
        client.release();
    }
});

// Delete template
router.delete('/templates/:id', async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;
        const result = await query(
            'DELETE FROM shopping_list_templates WHERE id = $1 AND user_id = $2 RETURNING id',
            [id, req.userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Template not found' });
        }

        res.json({ success: true, message: 'Template deleted' });
    } catch (error) {
        console.error('Delete template error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

export default router;
