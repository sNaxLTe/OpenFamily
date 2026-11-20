import { Router, Response } from 'express';
import { query, getClient } from '../db';
import { authMiddleware, AuthRequest, requireParent } from '../middleware/auth';
import { toNullIfEmpty, toOptionalNumber } from '../lib/normalize';
import { broadcast } from '../lib/broadcaster';
import {
    type RecurringFrequency,
    normalizeRecurringFrequency,
    normalizeRecurringInterval,
    parseDateOnly,
    formatDateOnly,
    expandRecurringTransactions,
} from '../lib/budgetRecurrence';
import {
    paperlessConfig,
    paperlessConfigured,
    paperlessDocumentUrl,
    searchPaperlessDocuments,
    getPaperlessPrefill,
} from '../services/integrations/paperless';

const router = Router();
router.use(authMiddleware);

// A budget entry can be assigned to a family member, and that id comes from the
// client — so verify it belongs to THIS family before storing it (same guard as
// planning / tasks / appointments / rewards). Without it a family could store
// another family's member id and read its name/color back through the JOINs below.
const ensureMemberBelongsToUser = async (memberId: unknown, userId: string): Promise<boolean> => {
    if (typeof memberId !== 'string' || !memberId.trim()) {
        return false;
    }
    const result = await query(
        'SELECT id FROM family_members WHERE id = $1 AND user_id = $2',
        [memberId, userId]
    );
    return result.rows.length > 0;
};

const toNumber = (value: unknown): number => {
    if (typeof value === 'number') {
        return value;
    }
    if (typeof value === 'string') {
        const parsed = parseFloat(value);
        return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
};

const mapBudgetEntry = (row: any) => ({
    ...row,
    amount: toNumber(row.amount),
    is_expense: Boolean(row.is_expense),
});

const mapBudgetLimit = (row: any) => ({
    ...row,
    monthly_limit: toNumber(row.monthly_limit),
    // month is NULL for an annual limit (annual/0002): keep the null, never 0.
    month: row.month === null || row.month === undefined ? null : toNumber(row.month),
    year: toNumber(row.year),
});

const dateOnlyValue = (value: unknown): string => {
    if (value instanceof Date) {
        return formatDateOnly(value);
    }
    return String(value ?? '').slice(0, 10);
};

const calendarDayTimes = (dateValue: unknown) => {
    const date = dateOnlyValue(dateValue);
    return {
        start: `${date}T00:00:00`,
        end: `${date}T23:59:59`,
    };
};

// Keep a one-time Budget entry linked to one all-day Calendar Event.
// enabled === undefined means "sync it if it is already linked, but don't
// create a new Calendar Event".
const syncBudgetEntryCalendar = async (
    userId: string,
    entry: any,
    enabled?: boolean
) => {
    const existing = await query(
        `SELECT id
         FROM appointments
         WHERE user_id = $1 AND linked_budget_entry_id = $2
         LIMIT 1`,
        [userId, entry.id]
    );

    const alreadyLinked = existing.rows.length > 0;
    const shouldHaveCalendar =
        enabled === undefined ? alreadyLinked : Boolean(enabled);

    if (!shouldHaveCalendar) {
        if (alreadyLinked) {
            await query(
                `DELETE FROM appointments
                 WHERE user_id = $1 AND linked_budget_entry_id = $2`,
                [userId, entry.id]
            );
            broadcast(userId, {
                type: 'update',
                entity: 'appointments',
                action: 'deleted',
            });
        }
        return;
    }

    const times = calendarDayTimes(entry.date);
    const title =
        String(entry.description || '').trim() ||
        String(entry.category || 'Budget');
    const defaultColor = entry.is_expense === false ? '#10B981' : '#DC4A60';

    if (alreadyLinked) {
        await query(
            `UPDATE appointments
             SET title = $1,
                 start_time = $2,
                 end_time = $3,
                 is_all_day = true,
                 recurrence_frequency = 'none',
                 recurrence_interval = 1,
                 recurrence_until = NULL
             WHERE id = $4 AND user_id = $5`,
            [
                title,
                times.start,
                times.end,
                existing.rows[0].id,
                userId,
            ]
        );
    } else {
        await query(
            `INSERT INTO appointments (
                user_id,
                title,
                description,
                start_time,
                end_time,
                location,
                family_member_ids,
                reminder_30min,
                reminder_1hour,
                notes,
                recurrence_frequency,
                recurrence_interval,
                recurrence_until,
                color,
                is_all_day,
                linked_budget_entry_id
             )
             VALUES (
                $1, $2, NULL, $3, $4, NULL, '[]'::jsonb,
                false, false, NULL,
                'none', 1, NULL, $5, true, $6
             )`,
            [userId, title, times.start, times.end, defaultColor, entry.id]
        );
    }

    broadcast(userId, {
        type: 'update',
        entity: 'appointments',
        action: alreadyLinked ? 'updated' : 'created',
    });
};

// Keep a recurring Budget transaction linked to an all-day recurring Calendar Event.
const syncRecurringTransactionCalendar = async (
    userId: string,
    recurring: any,
    enabled?: boolean
) => {
    const existing = await query(
        `SELECT id
         FROM appointments
         WHERE user_id = $1 AND linked_recurring_expense_id = $2
         LIMIT 1`,
        [userId, recurring.id]
    );

    const alreadyLinked = existing.rows.length > 0;
    const shouldHaveCalendar =
        enabled === undefined ? alreadyLinked : Boolean(enabled);

    if (!shouldHaveCalendar) {
        if (alreadyLinked) {
            await query(
                `DELETE FROM appointments
                 WHERE user_id = $1 AND linked_recurring_expense_id = $2`,
                [userId, recurring.id]
            );
            broadcast(userId, {
                type: 'update',
                entity: 'appointments',
                action: 'deleted',
            });
        }
        return;
    }

    const times = calendarDayTimes(recurring.start_date);
    const frequency =
        normalizeRecurringFrequency(recurring.recurrence_frequency);
    const interval =
        normalizeRecurringInterval(recurring.recurrence_interval);
    const untilValue = recurring.recurrence_until
        ? dateOnlyValue(recurring.recurrence_until)
        : null;
    const defaultColor = recurring.is_expense === false ? '#10B981' : '#DC4A60';

    if (alreadyLinked) {
        await query(
            `UPDATE appointments
             SET title = $1,
                 start_time = $2,
                 end_time = $3,
                 is_all_day = true,
                 recurrence_frequency = $4,
                 recurrence_interval = $5,
                 recurrence_until = $6::date
             WHERE id = $7 AND user_id = $8`,
            [
                recurring.label,
                times.start,
                times.end,
                frequency,
                interval,
                untilValue,
                existing.rows[0].id,
                userId,
            ]
        );
    } else {
        await query(
            `INSERT INTO appointments (
                user_id,
                title,
                description,
                start_time,
                end_time,
                location,
                family_member_ids,
                reminder_30min,
                reminder_1hour,
                notes,
                recurrence_frequency,
                recurrence_interval,
                recurrence_until,
                color,
                is_all_day,
                linked_recurring_expense_id
             )
             VALUES (
                $1, $2, NULL, $3, $4, NULL, '[]'::jsonb,
                false, false, NULL,
                $5, $6, $7::date, $8, true, $9
             )`,
            [
                userId,
                recurring.label,
                times.start,
                times.end,
                frequency,
                interval,
                untilValue,
                defaultColor,
                recurring.id,
            ]
        );
    }

    broadcast(userId, {
        type: 'update',
        entity: 'appointments',
        action: alreadyLinked ? 'updated' : 'created',
    });
};

// Get budget entries
router.get('/entries', async (req: AuthRequest, res) => {
    try {
        const { start_date, end_date, category, assigned_to } = req.query;

        let queryText = `SELECT be.*,
                   (SELECT a.id
                    FROM appointments a
                    WHERE a.user_id = be.user_id
                      AND a.linked_budget_entry_id = be.id
                    LIMIT 1) as linked_calendar_event_id,
                   fm.name as assigned_to_name,
                   fm.color as assigned_to_color
            FROM budget_entries be
            LEFT JOIN family_members fm ON be.assigned_to = fm.id AND fm.user_id = be.user_id
            WHERE be.user_id = $1`;
        const params: any[] = [req.userId];

        if (start_date) {
            params.push(start_date);
            queryText += ` AND be.date >= $${params.length}`;
        }

        if (end_date) {
            params.push(end_date);
            queryText += ` AND be.date <= $${params.length}`;
        }

        if (category) {
            params.push(category);
            queryText += ` AND be.category = $${params.length}`;
        }

        if (assigned_to) {
            params.push(assigned_to);
            queryText += ` AND be.assigned_to = $${params.length}`;
        }

        queryText += ' ORDER BY be.date DESC';

        const result = await query(queryText, params);
        res.json({ success: true, data: result.rows.map(mapBudgetEntry) });
    } catch (error) {
        console.error('Get budget entries error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Create budget entry
router.post('/entries', requireParent, async (req: AuthRequest, res) => {
    try {
        const {
            category,
            amount,
            description,
            date,
            is_expense,
            assigned_to,
            add_to_calendar,
            paperless_document_id,
        } = req.body;
        const parsedAmount = toOptionalNumber(amount);

        if (!category || parsedAmount === null || !date) {
            return res.status(400).json({ success: false, error: 'category, amount and date are required' });
        }

        // Feature 13: optional Paperless link (positive integer or null).
        const paperless = parsePaperlessDocumentId(paperless_document_id);
        if (!paperless.ok) {
            return res.status(400).json({ success: false, error: 'paperless_document_id must be a positive integer or null' });
        }
        const paperlessId = paperless.id ?? null;
        // The URL is derived server-side from PAPERLESS_URL, never from the client.
        const paperlessUrl = derivePaperlessUrl(paperlessId);

        const assignedTo = toNullIfEmpty(assigned_to) as string | null;
        if (assignedTo && !(await ensureMemberBelongsToUser(assignedTo, req.userId!))) {
            return res.status(400).json({ success: false, error: 'Member not found' });
        }

        const result = await query(
            `INSERT INTO budget_entries (user_id, category, amount, description, date, is_expense, assigned_to, paperless_document_id, paperless_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
            [req.userId, category, parsedAmount, toNullIfEmpty(description), date, Boolean(is_expense), assignedTo, paperlessId, paperlessUrl]
        );

        await syncBudgetEntryCalendar(
            req.userId!,
            result.rows[0],
            Boolean(add_to_calendar)
        );

        // Re-fetch with JOIN to get member name/color
        const full = await query(
            `SELECT be.*, fm.name as assigned_to_name, fm.color as assigned_to_color
             FROM budget_entries be LEFT JOIN family_members fm ON be.assigned_to = fm.id AND fm.user_id = be.user_id
             WHERE be.id = $1 AND be.user_id = $2`, [result.rows[0].id, req.userId]
        );

        broadcast(req.userId!, { type: 'update', entity: 'budget', action: 'created' });
        res.json({ success: true, data: mapBudgetEntry(full.rows[0]) });
    } catch (error) {
        console.error('Create budget entry error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Update budget entry
router.put('/entries/:id', requireParent, async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;
        const {
            category,
            amount,
            description,
            date,
            is_expense,
            assigned_to,
            add_to_calendar,
            paperless_document_id,
        } = req.body;
        const parsedAmount = amount !== undefined ? toOptionalNumber(amount) : undefined;

        if (amount !== undefined && parsedAmount === null) {
            return res.status(400).json({ success: false, error: 'Invalid amount format' });
        }

        // Feature 13: the Paperless link is only touched when the field is
        // present in the body — null unlinks, a positive integer links.
        const hasPaperless = paperless_document_id !== undefined;
        const paperless = parsePaperlessDocumentId(paperless_document_id);
        if (!paperless.ok) {
            return res.status(400).json({ success: false, error: 'paperless_document_id must be a positive integer or null' });
        }
        const paperlessId = paperless.id ?? null;
        const paperlessUrl = derivePaperlessUrl(paperlessId);

        // Handle assigned_to: allow explicit null to unassign
        const assignedToValue = assigned_to === '' || assigned_to === null ? null : assigned_to;

        if (assignedToValue && !(await ensureMemberBelongsToUser(assignedToValue, req.userId!))) {
            return res.status(400).json({ success: false, error: 'Member not found' });
        }

        const result = await query(
            `UPDATE budget_entries
       SET category = COALESCE($1, category),
           amount = COALESCE($2, amount),
           description = COALESCE($3, description),
           date = COALESCE($4, date),
           is_expense = COALESCE($5, is_expense),
           assigned_to = $6,
           paperless_document_id = CASE WHEN $7 THEN $8::integer ELSE paperless_document_id END,
           paperless_url = CASE WHEN $7 THEN $9::text ELSE paperless_url END
       WHERE id = $10 AND user_id = $11 RETURNING *`,
            [
                toNullIfEmpty(category),
                parsedAmount,
                toNullIfEmpty(description),
                toNullIfEmpty(date),
                is_expense !== undefined ? Boolean(is_expense) : undefined,
                assignedToValue !== undefined ? assignedToValue : null,
                hasPaperless,
                hasPaperless ? paperlessId : null,
                hasPaperless ? paperlessUrl : null,
                id,
                req.userId,
            ]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Budget entry not found' });
        }

        await syncBudgetEntryCalendar(
            req.userId!,
            result.rows[0],
            add_to_calendar !== undefined
                ? Boolean(add_to_calendar)
                : undefined
        );

        // Re-fetch with JOIN
        const full = await query(
            `SELECT be.*, fm.name as assigned_to_name, fm.color as assigned_to_color
             FROM budget_entries be LEFT JOIN family_members fm ON be.assigned_to = fm.id AND fm.user_id = be.user_id
             WHERE be.id = $1 AND be.user_id = $2`, [id, req.userId]
        );

        broadcast(req.userId!, { type: 'update', entity: 'budget', action: 'updated' });
        res.json({ success: true, data: mapBudgetEntry(full.rows[0]) });
    } catch (error) {
        console.error('Update budget entry error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Delete budget entry
router.delete('/entries/:id', requireParent, async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;

        await query(
            `DELETE FROM appointments
             WHERE linked_budget_entry_id = $1 AND user_id = $2`,
            [id, req.userId]
        );

        const result = await query(
            'DELETE FROM budget_entries WHERE id = $1 AND user_id = $2 RETURNING id',
            [id, req.userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Budget entry not found' });
        }

        broadcast(req.userId!, { type: 'update', entity: 'budget', action: 'deleted' });
        res.json({ success: true, message: 'Budget entry deleted' });
    } catch (error) {
        console.error('Delete budget entry error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// ─── Paperless bridge (feature 13) ───────────────────────────────────────────
// Server-side proxy to a Paperless-ngx instance configured via PAPERLESS_URL /
// PAPERLESS_TOKEN (env, never sent to the client). STRICTLY READ-ONLY towards
// Paperless (GET only). When the env is missing, the data routes answer 503
// with a clear message and the status route reports configured:false so the
// UI hides the button.

// Feature 13 validation: undefined = field not sent, null = explicit unlink,
// a positive integer = link. Anything else is refused with a 400.
const parsePaperlessDocumentId = (value: unknown): { ok: true; id: number | null } | { ok: false } => {
    if (value === undefined) return { ok: true, id: undefined as unknown as null };
    if (value === null || value === '') return { ok: true, id: null };
    const n = typeof value === 'number'
        ? value
        : typeof value === 'string' && /^\d+$/.test(value.trim())
            ? Number(value.trim())
            : NaN;
    if (!Number.isInteger(n) || n <= 0 || n > Number.MAX_SAFE_INTEGER) return { ok: false };
    return { ok: true, id: n };
};

// The stored paperless_url is ALWAYS derived by the server from its own
// PAPERLESS_URL — a client-sent URL is never stored, so no arbitrary link
// can be attached to an entry.
const derivePaperlessUrl = (id: number | null): string | null => {
    if (id === null) return null;
    const cfg = paperlessConfig();
    return cfg ? paperlessDocumentUrl(cfg.baseUrl, id) : null;
};

// Lightweight liveness for the UI: leaks nothing (no URL, no token).
router.get('/paperless/status', async (req: AuthRequest, res) => {
    res.json({ success: true, data: { configured: paperlessConfigured() } });
});

// Search / recent documents. Parents only (the link is written by parents).
router.get('/paperless/documents', requireParent, async (req: AuthRequest, res) => {
    const cfg = paperlessConfig();
    if (!cfg) {
        return res.status(503).json({
            success: false,
            error: 'Paperless is not configured on this server (set PAPERLESS_URL and PAPERLESS_TOKEN)',
        });
    }
    try {
        const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 200) : '';
        const limitRaw = toOptionalNumber(req.query.limit);
        const limit = limitRaw === null ? 20 : Math.min(50, Math.max(1, Math.trunc(limitRaw)));
        const documents = await searchPaperlessDocuments(cfg, q, limit);
        res.json({ success: true, data: documents });
    } catch (error) {
        console.error('Paperless documents error:', error instanceof Error ? error.message : error);
        res.status(502).json({ success: false, error: 'Paperless is unreachable or answered an error' });
    }
});

// OCR-based prefill for one document. Parents only.
router.get('/paperless/documents/:id/prefill', requireParent, async (req: AuthRequest, res) => {
    const cfg = paperlessConfig();
    if (!cfg) {
        return res.status(503).json({
            success: false,
            error: 'Paperless is not configured on this server (set PAPERLESS_URL and PAPERLESS_TOKEN)',
        });
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ success: false, error: 'Invalid document id' });
    }
    try {
        const prefill = await getPaperlessPrefill(cfg, id);
        if (!prefill) {
            return res.status(404).json({ success: false, error: 'Document not found in Paperless' });
        }
        res.json({ success: true, data: prefill });
    } catch (error) {
        console.error('Paperless prefill error:', error instanceof Error ? error.message : error);
        res.status(502).json({ success: false, error: 'Paperless is unreachable or answered an error' });
    }
});

// Get budget limits
router.get('/limits', async (req: AuthRequest, res) => {
    try {
        const { month, year } = req.query;

        let queryText = 'SELECT * FROM budget_limits WHERE user_id = $1';
        const params: any[] = [req.userId];

        if (month) {
            params.push(month);
            queryText += ` AND month = $${params.length}`;
        }

        if (year) {
            params.push(year);
            queryText += ` AND year = $${params.length}`;
        }

        const result = await query(queryText, params);
        res.json({ success: true, data: result.rows.map(mapBudgetLimit) });
    } catch (error) {
        console.error('Get budget limits error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Set budget limit
router.post('/limits', requireParent, async (req: AuthRequest, res) => {
    try {
        const { category, monthly_limit, month, year } = req.body;
        const parsedLimit = toOptionalNumber(monthly_limit);
        const parsedMonth = toOptionalNumber(month);
        const parsedYear = toOptionalNumber(year);

        if (!category || parsedLimit === null || parsedMonth === null || parsedYear === null) {
            return res.status(400).json({ success: false, error: 'category, monthly_limit, month and year are required' });
        }

        const result = await query(
            `INSERT INTO budget_limits (user_id, category, monthly_limit, month, year)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, category, month, year)
       DO UPDATE SET monthly_limit = $3
       RETURNING *`,
            [req.userId, category, parsedLimit, parsedMonth, parsedYear]
        );

        broadcast(req.userId!, { type: 'update', entity: 'budget', action: 'updated' });
        res.json({ success: true, data: mapBudgetLimit(result.rows[0]) });
    } catch (error) {
        console.error('Set budget limit error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// ─── Annual category limits (month = NULL, migration annual/0002) ────────────
// Dedicated routes because POST /limits above requires a month and its
// ON CONFLICT (user_id, category, month, year) never matches NULL. Monthly
// rows and the dashboard alerts are untouched: they join on bl.month, which
// never matches NULL.

// List annual limits, optionally for one year only.
router.get('/limits/annual', async (req: AuthRequest, res) => {
    try {
        const parsedYear = toOptionalNumber(req.query.year);
        if (req.query.year !== undefined && parsedYear === null) {
            return res.status(400).json({ success: false, error: 'year must be a number' });
        }

        let queryText = 'SELECT * FROM budget_limits WHERE user_id = $1 AND month IS NULL';
        const params: any[] = [req.userId];
        if (parsedYear !== null) {
            params.push(parsedYear);
            queryText += ` AND year = $${params.length}`;
        }
        queryText += ' ORDER BY category ASC';

        const result = await query(queryText, params);
        res.json({ success: true, data: result.rows.map(mapBudgetLimit) });
    } catch (error) {
        console.error('Get annual budget limits error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Create or update the annual limit of a category for a year (parents only).
router.put('/limits/annual', requireParent, async (req: AuthRequest, res) => {
    try {
        const { category, annual_limit, year } = req.body;
        const parsedLimit = toOptionalNumber(annual_limit);
        const parsedYear = toOptionalNumber(year);

        if (
            typeof category !== 'string' || !category.trim() ||
            parsedLimit === null ||
            parsedYear === null || !Number.isInteger(parsedYear)
        ) {
            return res.status(400).json({ success: false, error: 'category, annual_limit and an integer year are required' });
        }

        const result = await query(
            `INSERT INTO budget_limits (user_id, category, monthly_limit, month, year)
       VALUES ($1, $2, $3, NULL, $4)
       ON CONFLICT (user_id, category, year) WHERE month IS NULL
       DO UPDATE SET monthly_limit = EXCLUDED.monthly_limit
       RETURNING *`,
            [req.userId, category.trim().slice(0, 50), parsedLimit, parsedYear]
        );

        broadcast(req.userId!, { type: 'update', entity: 'budget', action: 'updated' });
        res.json({ success: true, data: mapBudgetLimit(result.rows[0]) });
    } catch (error) {
        console.error('Set annual budget limit error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Delete one annual limit by id (parents only).
router.delete('/limits/annual/:id', requireParent, async (req: AuthRequest, res) => {
    try {
        const result = await query(
            'DELETE FROM budget_limits WHERE id = $1 AND user_id = $2 AND month IS NULL RETURNING id',
            [req.params.id, req.userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Annual limit not found' });
        }

        broadcast(req.userId!, { type: 'update', entity: 'budget', action: 'deleted' });
        res.json({ success: true, message: 'Annual limit deleted' });
    } catch (error) {
        console.error('Delete annual budget limit error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Get budget statistics
router.get('/statistics', async (req: AuthRequest, res) => {
    try {
        const { month, year } = req.query;
        const parsedMonth = toOptionalNumber(month);
        const parsedYear = toOptionalNumber(year);

        if (parsedMonth === null || parsedYear === null) {
            return res.status(400).json({ success: false, error: 'month and year are required' });
        }

        const entryCategories = await query(
            `SELECT category, SUM(amount) as category_total
             FROM budget_entries
             WHERE user_id = $1
               AND is_expense = true
               AND EXTRACT(MONTH FROM date) = $2
               AND EXTRACT(YEAR FROM date) = $3
             GROUP BY category`,
            [req.userId, parsedMonth, parsedYear]
        );

        const entryTotals = await query(
            `SELECT
                 SUM(amount) FILTER (WHERE is_expense = true) as total_expenses,
                 SUM(amount) FILTER (WHERE is_expense = false) as total_income
             FROM budget_entries
             WHERE user_id = $1
               AND EXTRACT(MONTH FROM date) = $2
               AND EXTRACT(YEAR FROM date) = $3`,
            [req.userId, parsedMonth, parsedYear]
        );

        const byMember = await query(
            `SELECT
                 fm.id as assigned_to,
                 fm.name as member_name,
                 fm.color as member_color,
                 be.category,
                 SUM(be.amount) as amount
             FROM budget_entries be
             INNER JOIN family_members fm
                ON be.assigned_to = fm.id AND fm.user_id = be.user_id
             WHERE be.user_id = $1
               AND be.is_expense = true
               AND EXTRACT(MONTH FROM be.date) = $2
               AND EXTRACT(YEAR FROM be.date) = $3
             GROUP BY fm.id, fm.name, fm.color, be.category
             ORDER BY fm.name, be.category`,
            [req.userId, parsedMonth, parsedYear]
        );

        const range = getMonthRange(parsedYear, parsedMonth);
        const recurringSeriesResult = await query(
            `SELECT *
             FROM recurring_expenses
             WHERE user_id = $1
               AND is_active = true
               AND start_date <= $3::date
               AND (recurrence_until IS NULL OR recurrence_until >= $2::date)`,
            [req.userId, range.start, range.end]
        );

        const recurringOccurrences = expandRecurringTransactions(
            recurringSeriesResult.rows.map(mapRecurringTransaction),
            range.start,
            range.end
        );

        let recurringExpenses = 0;
        let recurringIncome = 0;
        const categoryTotals = new Map<string, number>();

        for (const row of entryCategories.rows) {
            categoryTotals.set(row.category, toNumber(row.category_total));
        }

        for (const occurrence of recurringOccurrences) {
            const amount = toNumber(occurrence.amount);
            if (occurrence.is_expense) {
                recurringExpenses += amount;
                const category = String(occurrence.category || 'Autre');
                categoryTotals.set(category, (categoryTotals.get(category) || 0) + amount);
            } else {
                recurringIncome += amount;
            }
        }

        const totalExpenses =
            toNumber(entryTotals.rows[0]?.total_expenses) + recurringExpenses;
        const totalIncome =
            toNumber(entryTotals.rows[0]?.total_income) + recurringIncome;

        res.json({
            success: true,
            data: {
                totalExpenses,
                totalIncome,
                balance: totalIncome - totalExpenses,
                byCategory: Array.from(categoryTotals.entries()).map(
                    ([category, category_total]) => ({ category, category_total })
                ),
                byMember: byMember.rows.map((row) => ({
                    assigned_to: row.assigned_to,
                    member_name: row.member_name,
                    member_color: row.member_color,
                    category: row.category,
                    amount: toNumber(row.amount),
                })),
            }
        });
    } catch (error) {
        console.error('Get budget statistics error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// The 12-month series of a year: one-off entries grouped by month plus the
// virtual recurring occurrences bucketed by month (same series filter as
// everywhere: active, started, not past recurrence_until). Shared by
// /statistics/monthly and /statistics/annual so the annual totals are
// exactly the sum of the 12 months it returns.
const getMonthlySeries = async (userId: string, year: number) => {
    const result = await query(
        `SELECT
             EXTRACT(MONTH FROM date)::int as month,
             SUM(amount) FILTER (WHERE is_expense = true) as total_expenses,
             SUM(amount) FILTER (WHERE is_expense = false) as total_income
         FROM budget_entries
         WHERE user_id = $1
           AND EXTRACT(YEAR FROM date) = $2
         GROUP BY EXTRACT(MONTH FROM date)
         ORDER BY month`,
        [userId, year]
    );

    const yearStart = `${year}-01-01`;
    const yearEnd = `${year}-12-31`;

    const recurringSeriesResult = await query(
        `SELECT *
         FROM recurring_expenses
         WHERE user_id = $1
           AND is_active = true
           AND start_date <= $3::date
           AND (recurrence_until IS NULL OR recurrence_until >= $2::date)`,
        [userId, yearStart, yearEnd]
    );

    const recurringOccurrences = expandRecurringTransactions(
        recurringSeriesResult.rows.map(mapRecurringTransaction),
        yearStart,
        yearEnd
    );

    const recurringByMonth = new Map<number, { income: number; expenses: number }>();

    for (const occurrence of recurringOccurrences) {
        const monthNum = Number(String(occurrence.occurrence_date).slice(5, 7));
        const bucket = recurringByMonth.get(monthNum) || { income: 0, expenses: 0 };
        if (occurrence.is_expense) {
            bucket.expenses += toNumber(occurrence.amount);
        } else {
            bucket.income += toNumber(occurrence.amount);
        }
        recurringByMonth.set(monthNum, bucket);
    }

    return Array.from({ length: 12 }, (_, i) => {
        const monthNum = i + 1;
        const row = result.rows.find((r) => r.month === monthNum);
        const recurring = recurringByMonth.get(monthNum) || { income: 0, expenses: 0 };
        const totalExpenses = (row ? toNumber(row.total_expenses) : 0) + recurring.expenses;
        const totalIncome = (row ? toNumber(row.total_income) : 0) + recurring.income;

        return {
            month: monthNum,
            totalExpenses,
            totalIncome,
            recurringExpenses: recurring.expenses,
            recurringIncome: recurring.income,
            balance: totalIncome - totalExpenses,
        };
    });
};

// Get monthly budget statistics for a year
router.get('/statistics/monthly', async (req: AuthRequest, res) => {
    try {
        const { year } = req.query;
        const parsedYear = toOptionalNumber(year);

        if (parsedYear === null) {
            return res.status(400).json({ success: false, error: 'year is required' });
        }

        const monthlyData = await getMonthlySeries(req.userId!, parsedYear);

        res.json({ success: true, data: monthlyData });
    } catch (error) {
        console.error('Get monthly budget statistics error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Get annual budget statistics for a year: the totals of the same 12-month
// series /statistics/monthly returns (one-off entries + virtual recurring
// occurrences), savings rate, average monthly balance, best/worst month and
// the previous year for comparison. Read-only; no schema involved.
router.get('/statistics/annual', async (req: AuthRequest, res) => {
    try {
        const { year } = req.query;
        const parsedYear = toOptionalNumber(year);

        if (parsedYear === null || !Number.isInteger(parsedYear)) {
            return res.status(400).json({ success: false, error: 'year is required' });
        }

        const monthly = await getMonthlySeries(req.userId!, parsedYear);

        const totalExpenses = monthly.reduce((sum, m) => sum + m.totalExpenses, 0);
        const totalIncome = monthly.reduce((sum, m) => sum + m.totalIncome, 0);
        const balance = totalIncome - totalExpenses;
        const hasActivity = totalExpenses !== 0 || totalIncome !== 0;

        const best = hasActivity
            ? monthly.reduce((a, b) => (b.balance > a.balance ? b : a))
            : null;
        const worst = hasActivity
            ? monthly.reduce((a, b) => (b.balance < a.balance ? b : a))
            : null;

        const previousMonthly = await getMonthlySeries(req.userId!, parsedYear - 1);
        const previousYearIncome = previousMonthly.reduce((sum, m) => sum + m.totalIncome, 0);
        const previousYearExpenses = previousMonthly.reduce((sum, m) => sum + m.totalExpenses, 0);

        res.json({
            success: true,
            data: {
                year: parsedYear,
                totalIncome,
                totalExpenses,
                balance,
                savingsRate: totalIncome > 0 ? balance / totalIncome : 0,
                monthlyAverage: balance / 12,
                bestMonth: best ? { month: best.month, balance: best.balance } : null,
                worstMonth: worst ? { month: worst.month, balance: worst.balance } : null,
                previousYear: {
                    totalIncome: previousYearIncome,
                    totalExpenses: previousYearExpenses,
                    balance: previousYearIncome - previousYearExpenses,
                },
            },
        });
    } catch (error) {
        console.error('Get annual budget statistics error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});


// Create or synchronize the Budget item linked to a Calendar Event.
// The Budget's existing parent-only permission still applies here.
router.post(
    '/from-appointment/:appointmentId',
    requireParent,
    async (req: AuthRequest, res) => {
        // Several writes (budget item, calendar link) that must land together:
        // one client, one transaction, so a failure never leaves an orphan.
        const client = await getClient();
        try {
            await client.query('BEGIN');
            const appointmentResult = await client.query(
                `SELECT *
                 FROM appointments
                 WHERE id = $1 AND user_id = $2`,
                [req.params.appointmentId, req.userId]
            );

            if (appointmentResult.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    error: 'Calendar event not found',
                });
            }

            const appointment = appointmentResult.rows[0];
            const startDate = parseDateOnly(String(appointment.start_time).slice(0, 10));

            if (!startDate) {
                return res.status(400).json({
                    success: false,
                    error: 'Calendar event has an invalid start date',
                });
            }

            let existingAmount: number | null = null;
            let existingCategory: string | null = null;
            let existingIsExpense: boolean | null = null;

            if (appointment.linked_budget_entry_id) {
                const existing = await client.query(
                    `SELECT amount, category, is_expense
                     FROM budget_entries
                     WHERE id = $1 AND user_id = $2`,
                    [appointment.linked_budget_entry_id, req.userId]
                );
                if (existing.rows.length > 0) {
                    existingAmount = toNumber(existing.rows[0].amount);
                    existingCategory = existing.rows[0].category;
                    existingIsExpense = Boolean(existing.rows[0].is_expense);
                }
            }

            if (appointment.linked_recurring_expense_id) {
                const existing = await client.query(
                    `SELECT amount, category, is_expense
                     FROM recurring_expenses
                     WHERE id = $1 AND user_id = $2`,
                    [appointment.linked_recurring_expense_id, req.userId]
                );
                if (existing.rows.length > 0) {
                    existingAmount = toNumber(existing.rows[0].amount);
                    existingCategory = existing.rows[0].category;
                    existingIsExpense = Boolean(existing.rows[0].is_expense);
                }
            }

            const requestedAmount =
                req.body.amount !== undefined ? toOptionalNumber(req.body.amount) : null;
            const amount = requestedAmount !== null ? requestedAmount : existingAmount;

            if (amount === null || amount <= 0) {
                return res.status(400).json({
                    success: false,
                    error: 'A positive amount is required',
                });
            }

            const category =
                typeof req.body.category === 'string' && req.body.category.trim()
                    ? req.body.category.trim()
                    : existingCategory || 'Autre';

            const isExpense =
                req.body.is_expense !== undefined
                    ? Boolean(req.body.is_expense)
                    : existingIsExpense ?? true;

            const title = String(appointment.title || '').trim() || 'Calendar budget entry';
            const startDateValue = formatDateOnly(startDate);
            const recurrenceFrequency =
                String(appointment.recurrence_frequency || 'none').toLowerCase();

            let linkedBudgetEntryId: string | null = null;
            let linkedRecurringExpenseId: string | null = null;

            if (recurrenceFrequency === 'none') {
                if (appointment.linked_recurring_expense_id) {
                    // The event stopped repeating. End the series the day before
                    // instead of deleting it: deleting would cascade to every
                    // month already marked as paid, and that is the family's
                    // bookkeeping, not a detail of the calendar event.
                    await client.query(
                        `UPDATE recurring_expenses
                         SET recurrence_until = LEAST(
                                 COALESCE(recurrence_until, $1::date - 1),
                                 $1::date - 1
                             ),
                             updated_at = NOW()
                         WHERE id = $2 AND user_id = $3`,
                        [startDateValue, appointment.linked_recurring_expense_id, req.userId]
                    );
                }

                if (appointment.linked_budget_entry_id) {
                    const updated = await client.query(
                        `UPDATE budget_entries
                         SET category = $1,
                             amount = $2,
                             description = $3,
                             date = $4::date,
                             is_expense = $5
                         WHERE id = $6 AND user_id = $7
                         RETURNING id`,
                        [
                            category,
                            amount,
                            title,
                            startDateValue,
                            isExpense,
                            appointment.linked_budget_entry_id,
                            req.userId,
                        ]
                    );
                    if (updated.rows.length > 0) {
                        linkedBudgetEntryId = updated.rows[0].id;
                    }
                }

                if (!linkedBudgetEntryId) {
                    const created = await client.query(
                        `INSERT INTO budget_entries (
                            user_id, category, amount, description, date, is_expense, assigned_to
                         )
                         VALUES ($1, $2, $3, $4, $5::date, $6, NULL)
                         RETURNING id`,
                        [req.userId, category, amount, title, startDateValue, isExpense]
                    );
                    linkedBudgetEntryId = created.rows[0].id;
                }

                await client.query(
                    `UPDATE appointments
                     SET linked_budget_entry_id = $1,
                         linked_recurring_expense_id = NULL
                     WHERE id = $2 AND user_id = $3`,
                    [linkedBudgetEntryId, appointment.id, req.userId]
                );
            } else {
                if (appointment.linked_budget_entry_id) {
                    await client.query(
                        `DELETE FROM budget_entries
                         WHERE id = $1 AND user_id = $2`,
                        [appointment.linked_budget_entry_id, req.userId]
                    );
                }

                const frequency = normalizeRecurringFrequency(recurrenceFrequency);
                const interval = normalizeRecurringInterval(appointment.recurrence_interval);
                const untilValue = appointment.recurrence_until
                    ? String(appointment.recurrence_until).slice(0, 10)
                    : null;

                if (appointment.linked_recurring_expense_id) {
                    const updated = await client.query(
                        `UPDATE recurring_expenses
                         SET label = $1,
                             amount = $2,
                             category = $3,
                             debit_day = $4,
                             start_date = $5::date,
                             recurrence_frequency = $6,
                             recurrence_interval = $7,
                             recurrence_until = $8::date,
                             is_expense = $9,
                             is_active = true,
                             updated_at = NOW()
                         WHERE id = $10 AND user_id = $11
                         RETURNING id`,
                        [
                            title, amount, category, startDate.getUTCDate(), startDateValue,
                            frequency, interval, untilValue, isExpense,
                            appointment.linked_recurring_expense_id, req.userId,
                        ]
                    );
                    if (updated.rows.length > 0) {
                        linkedRecurringExpenseId = updated.rows[0].id;
                    }
                }

                if (!linkedRecurringExpenseId) {
                    const created = await client.query(
                        `INSERT INTO recurring_expenses (
                            user_id, label, amount, category, debit_day, start_date,
                            recurrence_frequency, recurrence_interval, recurrence_until, is_expense
                         )
                         VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8, $9::date, $10)
                         RETURNING id`,
                        [
                            req.userId, title, amount, category, startDate.getUTCDate(),
                            startDateValue, frequency, interval, untilValue, isExpense,
                        ]
                    );
                    linkedRecurringExpenseId = created.rows[0].id;
                }

                await client.query(
                    `UPDATE appointments
                     SET linked_budget_entry_id = NULL,
                         linked_recurring_expense_id = $1
                     WHERE id = $2 AND user_id = $3`,
                    [linkedRecurringExpenseId, appointment.id, req.userId]
                );
            }

            await client.query('COMMIT');

            broadcast(req.userId!, {
                type: 'update',
                entity: 'budget',
                action: 'updated',
            });

            res.json({
                success: true,
                data: {
                    linked_budget_entry_id: linkedBudgetEntryId,
                    linked_recurring_expense_id: linkedRecurringExpenseId,
                    is_expense: isExpense,
                },
            });
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            console.error('Calendar to Budget sync error:', error);
            res.status(500).json({
                success: false,
                error: 'Internal server error',
            });
        } finally {
            // Early returns (404, 400) leave the transaction open with nothing
            // written; ROLLBACK is a no-op after COMMIT.
            await client.query('ROLLBACK').catch(() => {});
            client.release();
        }
    }
);

// ─── Recurring Budget Transactions ────────────────────────────────────────────

const mapRecurringTransaction = (row: any) => ({
    ...row,
    amount: toNumber(row.amount),
    debit_day: toNumber(row.debit_day),
    recurrence_interval: normalizeRecurringInterval(row.recurrence_interval),
    recurrence_frequency: normalizeRecurringFrequency(row.recurrence_frequency),
    start_date: row.start_date ? String(row.start_date).slice(0, 10) : null,
    recurrence_until: row.recurrence_until ? String(row.recurrence_until).slice(0, 10) : null,
    is_active: Boolean(row.is_active),
    is_expense: row.is_expense === undefined ? true : Boolean(row.is_expense),
    is_pointed: Boolean(row.is_pointed),
});

const getMonthRange = (year: number, month: number) => {
    const start = new Date(Date.UTC(year, month - 1, 1));
    const end = new Date(Date.UTC(year, month, 0));
    return {
        start: formatDateOnly(start),
        end: formatDateOnly(end),
    };
};

// List recurring transaction OCCURRENCES for a given month/year.
router.get('/recurring', async (req: AuthRequest, res) => {
    try {
        const parsedMonth = toOptionalNumber(req.query.month);
        const parsedYear = toOptionalNumber(req.query.year);

        const now = new Date();
        const month = parsedMonth ?? now.getUTCMonth() + 1;
        const year = parsedYear ?? now.getUTCFullYear();

        if (month < 1 || month > 12) {
            return res.status(400).json({ success: false, error: 'invalid month' });
        }

        const range = getMonthRange(year, month);

        const seriesResult = await query(
            `SELECT re.*,
                    (SELECT a.id
                     FROM appointments a
                     WHERE a.user_id = re.user_id
                       AND a.linked_recurring_expense_id = re.id
                     LIMIT 1) as linked_calendar_event_id
             FROM recurring_expenses re
             WHERE re.user_id = $1
               AND re.is_active = true
               AND re.start_date <= $3::date
               AND (re.recurrence_until IS NULL OR re.recurrence_until >= $2::date)
             ORDER BY re.start_date ASC, re.label ASC`,
            [req.userId, range.start, range.end]
        );

        const occurrences = expandRecurringTransactions(
            seriesResult.rows.map(mapRecurringTransaction),
            range.start,
            range.end
        );

        const logsResult = await query(
            `SELECT recurring_expense_id, occurrence_date, is_pointed, pointed_at
             FROM recurring_expense_logs
             WHERE user_id = $1
               AND occurrence_date >= $2::date
               AND occurrence_date <= $3::date`,
            [req.userId, range.start, range.end]
        );

        const logs = new Map(
            logsResult.rows.map((log: any) => [
                `${log.recurring_expense_id}:${String(log.occurrence_date).slice(0, 10)}`,
                log,
            ])
        );

        const data = occurrences
            .map((occurrence) => {
                const key = `${occurrence.series_id}:${occurrence.occurrence_date}`;
                const log = logs.get(key) as any;
                return mapRecurringTransaction({
                    ...occurrence,
                    is_pointed: Boolean(log?.is_pointed),
                    pointed_at: log?.pointed_at ?? null,
                });
            })
            .sort((a, b) =>
                String(a.occurrence_date).localeCompare(String(b.occurrence_date)) ||
                String(a.label).localeCompare(String(b.label))
            );

        res.json({ success: true, data });
    } catch (error) {
        console.error('Get recurring expenses error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// List recurring transaction OCCURRENCES over any date range (the annual
// schedule, feature 2): virtual occurrences from expandRecurringTransactions,
// never materialised. Same series filter as everywhere else (active, started,
// not past recurrence_until). The client groups by month itself.
router.get('/recurring/schedule', async (req: AuthRequest, res) => {
    try {
        const start = parseDateOnly(req.query.start_date ?? req.query.start);
        const end = parseDateOnly(req.query.end_date ?? req.query.end);

        if (!start || !end) {
            return res.status(400).json({ success: false, error: 'valid start_date and end_date are required' });
        }

        const startValue = formatDateOnly(start);
        const endValue = formatDateOnly(end);

        if (startValue > endValue) {
            return res.status(400).json({ success: false, error: 'start_date must not be after end_date' });
        }

        // A daily series over a century would be tens of thousands of rows;
        // five years covers the annual views and then some.
        if ((end.getTime() - start.getTime()) / 86400000 > 5 * 366) {
            return res.status(400).json({ success: false, error: 'date range too large (5 years max)' });
        }

        const seriesResult = await query(
            `SELECT re.*,
                    (SELECT a.id
                     FROM appointments a
                     WHERE a.user_id = re.user_id
                       AND a.linked_recurring_expense_id = re.id
                     LIMIT 1) as linked_calendar_event_id
             FROM recurring_expenses re
             WHERE re.user_id = $1
               AND re.is_active = true
               AND re.start_date <= $3::date
               AND (re.recurrence_until IS NULL OR re.recurrence_until >= $2::date)
             ORDER BY re.start_date ASC, re.label ASC`,
            [req.userId, startValue, endValue]
        );

        const occurrences = expandRecurringTransactions(
            seriesResult.rows.map(mapRecurringTransaction),
            startValue,
            endValue
        )
            .map((occurrence) => mapRecurringTransaction(occurrence))
            .sort((a, b) =>
                String(a.occurrence_date).localeCompare(String(b.occurrence_date)) ||
                String(a.label).localeCompare(String(b.label))
            );

        res.json({ success: true, data: occurrences });
    } catch (error) {
        console.error('Get recurring schedule error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Create recurring transaction series.
router.post('/recurring', requireParent, async (req: AuthRequest, res) => {
    try {
        const {
            label,
            amount,
            category,
            start_date,
            recurrence_frequency,
            recurrence_interval,
            recurrence_until,
            is_expense,
            add_to_calendar,
        } = req.body;

        const parsedAmount = toOptionalNumber(amount);
        const startDate = parseDateOnly(start_date);
        const frequency = normalizeRecurringFrequency(recurrence_frequency);
        const interval = normalizeRecurringInterval(recurrence_interval);
        const untilDate = recurrence_until ? parseDateOnly(recurrence_until) : null;

        if (!label || parsedAmount === null || parsedAmount <= 0 || !startDate) {
            return res.status(400).json({
                success: false,
                error: 'label, amount and valid start_date are required',
            });
        }

        const startDateValue = formatDateOnly(startDate);
        const untilValue = untilDate ? formatDateOnly(untilDate) : null;

        if (untilValue && untilValue < startDateValue) {
            return res.status(400).json({
                success: false,
                error: 'recurrence_until cannot be before start_date',
            });
        }

        const result = await query(
            `INSERT INTO recurring_expenses (
                user_id,
                label,
                amount,
                category,
                debit_day,
                start_date,
                recurrence_frequency,
                recurrence_interval,
                recurrence_until,
                is_expense
             )
             VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8, $9::date, $10)
             RETURNING *`,
            [
                req.userId,
                label,
                parsedAmount,
                category || 'Maison',
                startDate.getUTCDate(),
                startDateValue,
                frequency,
                interval,
                untilValue,
                is_expense === undefined ? true : Boolean(is_expense),
            ]
        );

        await syncRecurringTransactionCalendar(
            req.userId!,
            result.rows[0],
            Boolean(add_to_calendar)
        );

        broadcast(req.userId!, { type: 'update', entity: 'budget', action: 'created' });
        res.json({
            success: true,
            data: mapRecurringTransaction({ ...result.rows[0], is_pointed: false }),
        });
    } catch (error) {
        console.error('Create recurring transaction error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Update an entire recurring transaction series.
router.put('/recurring/:id', requireParent, async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;

        const existingResult = await query(
            `SELECT *
             FROM recurring_expenses
             WHERE id = $1 AND user_id = $2`,
            [id, req.userId]
        );

        if (existingResult.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Recurring transaction not found' });
        }

        const existing = mapRecurringTransaction(existingResult.rows[0]);

        const label = req.body.label ?? existing.label;
        const category = req.body.category ?? existing.category;
        const amount = req.body.amount !== undefined
            ? toOptionalNumber(req.body.amount)
            : existing.amount;
        const startDate = parseDateOnly(req.body.start_date ?? existing.start_date);
        const frequency = req.body.recurrence_frequency !== undefined
            ? normalizeRecurringFrequency(req.body.recurrence_frequency)
            : existing.recurrence_frequency;
        const interval = req.body.recurrence_interval !== undefined
            ? normalizeRecurringInterval(req.body.recurrence_interval)
            : existing.recurrence_interval;
        const isExpense = req.body.is_expense !== undefined
            ? Boolean(req.body.is_expense)
            : existing.is_expense;

        const rawUntil = req.body.recurrence_until !== undefined
            ? req.body.recurrence_until
            : existing.recurrence_until;
        const untilDate = rawUntil ? parseDateOnly(rawUntil) : null;

        if (!label || amount === null || amount <= 0 || !startDate) {
            return res.status(400).json({
                success: false,
                error: 'label, amount and valid start_date are required',
            });
        }

        const startDateValue = formatDateOnly(startDate);
        const untilValue = untilDate ? formatDateOnly(untilDate) : null;

        if (rawUntil && !untilDate) {
            return res.status(400).json({ success: false, error: 'invalid recurrence_until' });
        }

        if (untilValue && untilValue < startDateValue) {
            return res.status(400).json({
                success: false,
                error: 'recurrence_until cannot be before start_date',
            });
        }

        const result = await query(
            `UPDATE recurring_expenses
             SET label = $1,
                 amount = $2,
                 category = $3,
                 debit_day = $4,
                 start_date = $5::date,
                 recurrence_frequency = $6,
                 recurrence_interval = $7,
                 recurrence_until = $8::date,
                 is_expense = $9,
                 is_active = $10,
                 updated_at = NOW()
             WHERE id = $11 AND user_id = $12
             RETURNING *`,
            [
                label,
                amount,
                category,
                startDate.getUTCDate(),
                startDateValue,
                frequency,
                interval,
                untilValue,
                isExpense,
                req.body.is_active !== undefined
                    ? Boolean(req.body.is_active)
                    : existing.is_active,
                id,
                req.userId,
            ]
        );

        await syncRecurringTransactionCalendar(
            req.userId!,
            result.rows[0],
            req.body.add_to_calendar !== undefined
                ? Boolean(req.body.add_to_calendar)
                : undefined
        );

        broadcast(req.userId!, { type: 'update', entity: 'budget', action: 'updated' });
        res.json({
            success: true,
            data: mapRecurringTransaction({ ...result.rows[0], is_pointed: false }),
        });
    } catch (error) {
        console.error('Update recurring transaction error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Delete recurring transaction series.
router.delete('/recurring/:id', requireParent, async (req: AuthRequest, res) => {
    try {
        await query(
            `DELETE FROM appointments
             WHERE linked_recurring_expense_id = $1 AND user_id = $2`,
            [req.params.id, req.userId]
        );

        const result = await query(
            'DELETE FROM recurring_expenses WHERE id = $1 AND user_id = $2 RETURNING id',
            [req.params.id, req.userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Recurring transaction not found' });
        }

        broadcast(req.userId!, { type: 'update', entity: 'budget', action: 'deleted' });
        res.json({ success: true, message: 'Recurring expense deleted' });
    } catch (error) {
        console.error('Delete recurring transaction error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Set or clear the budget reminder ("J-X days") of a recurring series
// (feature 3, mechanism B; the linked all-day calendar event with its own
// reminders is mechanism A and stays independent). Parents only, like every
// write on a recurring series. NULL clears the reminder.
router.put('/recurring/:id/reminder', requireParent, async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;
        const raw = req.body?.reminder_days;

        if (raw === undefined) {
            return res.status(400).json({ success: false, error: 'reminder_days is required (integer 0-365, or null to clear)' });
        }

        let reminderDays: number | null = null;
        if (raw !== null) {
            const parsed = typeof raw === 'number' ? raw : Number(raw);
            if (!Number.isInteger(parsed) || parsed < 0 || parsed > 365) {
                return res.status(400).json({ success: false, error: 'reminder_days must be an integer between 0 and 365, or null' });
            }
            reminderDays = parsed;
        }

        const result = await query(
            `UPDATE recurring_expenses
             SET reminder_days = $1, updated_at = NOW()
             WHERE id = $2 AND user_id = $3
             RETURNING *`,
            [reminderDays, id, req.userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Recurring transaction not found' });
        }

        broadcast(req.userId!, { type: 'update', entity: 'budget', action: 'updated' });
        res.json({
            success: true,
            data: mapRecurringTransaction({ ...result.rows[0], is_pointed: false }),
        });
    } catch (error) {
        console.error('Set recurring reminder error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Pointing is reconciliation only. It no longer controls Current Balance.
router.post('/recurring/:id/point', requireParent, async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;
        const occurrenceDate = parseDateOnly(req.body.occurrence_date);

        if (!occurrenceDate) {
            return res.status(400).json({
                success: false,
                error: 'valid occurrence_date is required',
            });
        }

        const check = await query(
            'SELECT id FROM recurring_expenses WHERE id = $1 AND user_id = $2',
            [id, req.userId]
        );

        if (check.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Recurring transaction not found' });
        }

        const occurrenceDateValue = formatDateOnly(occurrenceDate);
        const pointed = Boolean(req.body.is_pointed);
        const month = occurrenceDate.getUTCMonth() + 1;
        const year = occurrenceDate.getUTCFullYear();

        const result = await query(
            `INSERT INTO recurring_expense_logs (
                recurring_expense_id,
                user_id,
                month,
                year,
                occurrence_date,
                is_pointed,
                pointed_at
             )
             VALUES ($1, $2, $3, $4, $5::date, $6, $7)
             ON CONFLICT (recurring_expense_id, occurrence_date)
             DO UPDATE SET
                month = EXCLUDED.month,
                year = EXCLUDED.year,
                is_pointed = EXCLUDED.is_pointed,
                pointed_at = EXCLUDED.pointed_at
             RETURNING *`,
            [
                id,
                req.userId,
                month,
                year,
                occurrenceDateValue,
                pointed,
                pointed ? new Date() : null,
            ]
        );

        broadcast(req.userId!, { type: 'update', entity: 'budget', action: 'updated' });
        res.json({
            success: true,
            data: {
                ...result.rows[0],
                occurrence_date: occurrenceDateValue,
                is_pointed: Boolean(result.rows[0].is_pointed),
            },
        });
    } catch (error) {
        console.error('Reconcile recurring transaction error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// ─── Forecast projection (feature 11): GET /api/budget/forecast?months=N ─────
// With months=N (integer 1..24) the route projects the N months AFTER the
// current one: recurring occurrences via expandRecurringTransactions (same
// series filter as everywhere), the one-off ("variable") part estimated as the
// average per month of the last variable_months real months (default 6, 0 =
// recurring only), and the cumulative balance opened on what is realized
// through the end of the current month. Pointed recurring payments live in
// recurring_expense_logs, never in budget_entries, so nothing is counted twice.
// Without the months param, the month/year behaviour of the route is unchanged.

const shiftMonth = (year: number, month: number, offset: number) => {
    const total = year * 12 + (month - 1) + offset;
    return { year: Math.floor(total / 12), month: (total % 12) + 1 };
};

const handleForecastProjection = async (req: AuthRequest, res: Response) => {
    const months = toOptionalNumber(req.query.months);
    if (months === null || !Number.isInteger(months) || months < 1 || months > 24) {
        return res.status(400).json({ success: false, error: 'months must be an integer between 1 and 24' });
    }
    const rawVariableMonths = req.query.variable_months;
    const variableMonths = rawVariableMonths === undefined ? 6 : toOptionalNumber(rawVariableMonths);
    if (variableMonths === null || !Number.isInteger(variableMonths) || variableMonths < 0 || variableMonths > 36) {
        return res.status(400).json({ success: false, error: 'variable_months must be an integer between 0 and 36' });
    }

    // "Today" follows the client's local date, like the month/year mode below.
    const requestedAsOf = parseDateOnly(req.query.as_of);
    const fallbackNow = new Date();
    const asOf = requestedAsOf ?? new Date(Date.UTC(
        fallbackNow.getUTCFullYear(),
        fallbackNow.getUTCMonth(),
        fallbackNow.getUTCDate()
    ));
    const asOfValue = formatDateOnly(asOf);
    const currentYear = asOf.getUTCFullYear();
    const currentMonth = asOf.getUTCMonth() + 1;
    const currentRange = getMonthRange(currentYear, currentMonth);

    // Opening balance: everything realized through the end of the current
    // month — one-off entries plus every recurring occurrence up to then
    // (series that have since ended included), same semantics as statistics.
    const entriesHist = await query(
        `SELECT
             SUM(amount) FILTER (WHERE is_expense = false) as total_income,
             SUM(amount) FILTER (WHERE is_expense = true) as total_expenses
         FROM budget_entries
         WHERE user_id = $1 AND date <= $2::date`,
        [req.userId, currentRange.end]
    );
    const histSeries = await query(
        `SELECT *
         FROM recurring_expenses
         WHERE user_id = $1
           AND is_active = true
           AND start_date <= $2::date`,
        [req.userId, currentRange.end]
    );
    let opening =
        toNumber(entriesHist.rows[0]?.total_income) -
        toNumber(entriesHist.rows[0]?.total_expenses);
    for (const row of histSeries.rows) {
        const series = mapRecurringTransaction(row);
        if (!series.start_date || series.start_date > currentRange.end) continue;
        for (const occurrence of expandRecurringTransactions([series], series.start_date, currentRange.end)) {
            if (occurrence.is_expense) opening -= toNumber(occurrence.amount);
            else opening += toNumber(occurrence.amount);
        }
    }

    // Variable (one-off) estimate: average per month over the last
    // variable_months real months, ending with the current one.
    let estimatedVariable = 0;
    let estimatedVariableIncome = 0;
    if (variableMonths > 0) {
        const windowFirst = shiftMonth(currentYear, currentMonth, -(variableMonths - 1));
        const windowStart = getMonthRange(windowFirst.year, windowFirst.month).start;
        const variableRows = await query(
            `SELECT
                 SUM(amount) FILTER (WHERE is_expense = true) as expenses,
                 SUM(amount) FILTER (WHERE is_expense = false) as income
             FROM budget_entries
             WHERE user_id = $1
               AND date >= $2::date
               AND date <= $3::date`,
            [req.userId, windowStart, currentRange.end]
        );
        estimatedVariable = toNumber(variableRows.rows[0]?.expenses) / variableMonths;
        estimatedVariableIncome = toNumber(variableRows.rows[0]?.income) / variableMonths;
    }

    // Horizon: the N months after the current one.
    const horizon: Array<Record<string, unknown>> = [];
    let cumulative = opening;
    for (let i = 1; i <= months; i++) {
        const { year, month } = shiftMonth(currentYear, currentMonth, i);
        const range = getMonthRange(year, month);
        const seriesResult = await query(
            `SELECT *
             FROM recurring_expenses
             WHERE user_id = $1
               AND is_active = true
               AND start_date <= $3::date
               AND (recurrence_until IS NULL OR recurrence_until >= $2::date)`,
            [req.userId, range.start, range.end]
        );

        let recurringExpenses = 0;
        let recurringIncome = 0;
        for (const occurrence of expandRecurringTransactions(
            seriesResult.rows.map(mapRecurringTransaction),
            range.start,
            range.end
        )) {
            if (occurrence.is_expense) recurringExpenses += toNumber(occurrence.amount);
            else recurringIncome += toNumber(occurrence.amount);
        }

        const projectedExpenses = recurringExpenses + estimatedVariable;
        const projectedIncome = recurringIncome + estimatedVariableIncome;
        const monthlyBalance = projectedIncome - projectedExpenses;
        cumulative += monthlyBalance;

        horizon.push({
            month: `${year}-${String(month).padStart(2, '0')}`,
            recurring_expenses: recurringExpenses,
            recurring_income: recurringIncome,
            estimated_variable: estimatedVariable,
            estimated_variable_income: estimatedVariableIncome,
            projected_expenses: projectedExpenses,
            projected_income: projectedIncome,
            monthly_balance: monthlyBalance,
            cumulative_balance: cumulative,
        });
    }

    return res.json({
        success: true,
        data: {
            generated_at: new Date().toISOString(),
            as_of: asOfValue,
            horizon: months,
            variable_months: variableMonths,
            opening_balance: opening,
            months: horizon,
            assumptions: {
                base: 'balance realized through the end of the current month (entries + recurring occurrences)',
                variable_window_months: variableMonths,
                no_double_count: 'pointed recurring payments live in recurring_expense_logs, not budget_entries',
            },
        },
    });
};

// Current Balance carries forward every prior Budget transaction and includes
// recurring occurrences in the selected month only once their due date arrives.
// Forecast Balance also includes upcoming recurring income and expenses.
// With ?months=N (feature 11) this same route projects the N following months
// instead; without it, the behaviour below is exactly what it always was.
router.get('/forecast', async (req: AuthRequest, res) => {
    try {
        if (req.query.months !== undefined) {
            return handleForecastProjection(req, res);
        }

        const parsedMonth = toOptionalNumber(req.query.month);
        const parsedYear = toOptionalNumber(req.query.year);

        if (
            parsedMonth === null ||
            parsedYear === null ||
            parsedMonth < 1 ||
            parsedMonth > 12
        ) {
            return res.status(400).json({
                success: false,
                error: 'valid month and year are required',
            });
        }

        const range = getMonthRange(parsedYear, parsedMonth);

        const totals = await query(
            `SELECT
                 SUM(amount) FILTER (WHERE is_expense = false) as total_income,
                 SUM(amount) FILTER (WHERE is_expense = true) as total_expenses
             FROM budget_entries
             WHERE user_id = $1
               AND EXTRACT(MONTH FROM date) = $2
               AND EXTRACT(YEAR FROM date) = $3`,
            [req.userId, parsedMonth, parsedYear]
        );

        // Carry forward every one-time entry dated before the selected month.
        const historicalEntries = await query(
            `SELECT
                 SUM(amount) FILTER (WHERE is_expense = false) as total_income,
                 SUM(amount) FILTER (WHERE is_expense = true) as total_expenses
             FROM budget_entries
             WHERE user_id = $1
               AND date < $2::date`,
            [req.userId, range.start]
        );

        // Current selected-month recurring series.
        const seriesResult = await query(
            `SELECT *
             FROM recurring_expenses
             WHERE user_id = $1
               AND is_active = true
               AND start_date <= $3::date
               AND (recurrence_until IS NULL OR recurrence_until >= $2::date)`,
            [req.userId, range.start, range.end]
        );

        const occurrences = expandRecurringTransactions(
            seriesResult.rows.map(mapRecurringTransaction),
            range.start,
            range.end
        );

        // Historical recurring series must also be included in carry-forward,
        // including series whose recurrence ended before this month.
        const historicalSeriesResult = await query(
            `SELECT *
             FROM recurring_expenses
             WHERE user_id = $1
               AND is_active = true
               AND start_date < $2::date`,
            [req.userId, range.start]
        );

        const rangeStartDate = parseDateOnly(range.start)!;
        rangeStartDate.setUTCDate(rangeStartDate.getUTCDate() - 1);
        const historicalEnd = formatDateOnly(rangeStartDate);

        const historicalOccurrences = historicalSeriesResult.rows.flatMap((row) => {
            const recurring = mapRecurringTransaction(row);
            if (!recurring.start_date || recurring.start_date > historicalEnd) return [];
            return expandRecurringTransactions(
                [recurring],
                recurring.start_date,
                historicalEnd
            );
        });

        let openingRecurringIncome = 0;
        let openingRecurringExpenses = 0;

        for (const occurrence of historicalOccurrences) {
            if (occurrence.is_expense) {
                openingRecurringExpenses += toNumber(occurrence.amount);
            } else {
                openingRecurringIncome += toNumber(occurrence.amount);
            }
        }

        const openingBalance =
            toNumber(historicalEntries.rows[0]?.total_income)
            - toNumber(historicalEntries.rows[0]?.total_expenses)
            + openingRecurringIncome
            - openingRecurringExpenses;

        // The client sends its local date so "today" follows the family's timezone
        // rather than the Docker/server timezone.
        const requestedAsOf = parseDateOnly(req.query.as_of);
        const fallbackNow = new Date();
        const asOf = requestedAsOf ?? new Date(Date.UTC(
            fallbackNow.getUTCFullYear(),
            fallbackNow.getUTCMonth(),
            fallbackNow.getUTCDate()
        ));
        const asOfValue = formatDateOnly(asOf);

        let cutoff: string;

        if (asOfValue < range.start) {
            cutoff = '';
        } else if (asOfValue > range.end) {
            cutoff = range.end;
        } else {
            cutoff = asOfValue;
        }

        let dueRecurringIncome = 0;
        let dueRecurringExpenses = 0;
        let upcomingRecurringIncome = 0;
        let upcomingRecurringExpenses = 0;

        for (const occurrence of occurrences) {
            const amount = toNumber(occurrence.amount);
            const due = Boolean(cutoff && occurrence.occurrence_date <= cutoff);

            if (occurrence.is_expense) {
                if (due) dueRecurringExpenses += amount;
                else upcomingRecurringExpenses += amount;
            } else {
                if (due) dueRecurringIncome += amount;
                else upcomingRecurringIncome += amount;
            }
        }

        const oneTimeIncome = toNumber(totals.rows[0]?.total_income);
        const oneTimeExpenses = toNumber(totals.rows[0]?.total_expenses);

        const currentBalance =
            openingBalance
            + oneTimeIncome
            - oneTimeExpenses
            + dueRecurringIncome
            - dueRecurringExpenses;

        const forecastBalance =
            currentBalance
            + upcomingRecurringIncome
            - upcomingRecurringExpenses;

        res.json({
            success: true,
            data: {
                openingBalance,
                oneTimeIncome,
                oneTimeExpenses,
                dueRecurringIncome,
                dueRecurringExpenses,
                upcomingRecurringIncome,
                upcomingRecurringExpenses,

                // Compatibility aliases for older clients.
                income: oneTimeIncome,
                pointedRecurring: dueRecurringExpenses,
                unpointedRecurring: upcomingRecurringExpenses,

                currentBalance,
                forecastBalance,
            },
        });
    } catch (error) {
        console.error('Get forecast error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// ─── GET /api/budget/report — ad-hoc report (feature 10, "Explorateur") ───────
//
// Query params:
//   range_preset  = this_year | last_year | last_12_months | custom
//                   "custom" (or no preset) requires start_date + end_date.
//   start_date, end_date = YYYY-MM-DD, the custom range (with or without
//                   range_preset=custom).
//   as_of         = YYYY-MM-DD, the client's local "today"; resolves the
//                   presets (default: server today, UTC). last_12_months =
//                   first day of the month 11 months back .. last day of the
//                   as_of month.
//   type          = expenses | income | net   (default expenses). net:
//                   total = income − expenses per row.
//   split         = month | category | member (default month). month fills
//                   empty months (key 'YYYY-MM'); member keys on assigned_to
//                   (key null, label null = unassigned, where recurring
//                   occurrences always land).
//   include_recurring = true | false (default true): virtual occurrences from
//                   expandRecurringTransactions, same series filter as the
//                   statistics (active, started, not past recurrence_until).
//   categories    = comma list (or repeated param), same semantics as the
//                   category filter of GET /entries.
//   members       = comma list of family member ids (or repeated param), same
//                   semantics as assigned_to in GET /entries. It does NOT
//                   filter recurring occurrences: they have no member.
//   No payee filter: budget_entries has no payee column.
//
// Output: { success, data: { range, params, summary: { total, count, average,
//   recurring_total }, rows: [{ key, label, total, count, average,
//   recurring_total }] } } — average = total / count (0 when count is 0),
// recurring_total = the signed recurring part of total (0 when
// include_recurring=false). Read-only; every account of the family may read,
// like the statistics. Zero migration, zero write.

const REPORT_PRESETS = ['this_year', 'last_year', 'last_12_months', 'custom'] as const;
const REPORT_TYPES = ['expenses', 'income', 'net'] as const;
const REPORT_SPLITS = ['month', 'category', 'member'] as const;

const parseListParam = (value: unknown): string[] => {
    if (value === undefined) return [];
    const raw = Array.isArray(value) ? value : [value];
    return raw
        .flatMap((item) => String(item).split(','))
        .map((item) => item.trim())
        .filter(Boolean);
};

const round2 = (value: number): number => Math.round(value * 100) / 100;

router.get('/report', async (req: AuthRequest, res) => {
    try {
        const q = req.query;

        // Range: preset or explicit dates.
        const preset = typeof q.range_preset === 'string' ? q.range_preset : undefined;
        if (preset !== undefined && !(REPORT_PRESETS as readonly string[]).includes(preset)) {
            return res.status(400).json({
                success: false,
                error: `range_preset must be one of ${REPORT_PRESETS.join(', ')}`,
            });
        }

        const requestedAsOf = parseDateOnly(q.as_of);
        const fallbackNow = new Date();
        const asOf = requestedAsOf ?? new Date(Date.UTC(
            fallbackNow.getUTCFullYear(),
            fallbackNow.getUTCMonth(),
            fallbackNow.getUTCDate()
        ));
        const asOfYear = asOf.getUTCFullYear();
        const asOfMonth = asOf.getUTCMonth() + 1;

        let rangeStart: string;
        let rangeEnd: string;

        if (preset === 'this_year') {
            rangeStart = `${asOfYear}-01-01`;
            rangeEnd = `${asOfYear}-12-31`;
        } else if (preset === 'last_year') {
            rangeStart = `${asOfYear - 1}-01-01`;
            rangeEnd = `${asOfYear - 1}-12-31`;
        } else if (preset === 'last_12_months') {
            const first = shiftMonth(asOfYear, asOfMonth, -11);
            rangeStart = getMonthRange(first.year, first.month).start;
            rangeEnd = getMonthRange(asOfYear, asOfMonth).end;
        } else {
            const start = parseDateOnly(q.start_date);
            const end = parseDateOnly(q.end_date);
            if (!start || !end) {
                return res.status(400).json({
                    success: false,
                    error: 'range_preset (this_year, last_year, last_12_months) or start_date + end_date are required',
                });
            }
            rangeStart = formatDateOnly(start);
            rangeEnd = formatDateOnly(end);
        }

        if (rangeStart > rangeEnd) {
            return res.status(400).json({ success: false, error: 'start_date must not be after end_date' });
        }
        if ((parseDateOnly(rangeEnd)!.getTime() - parseDateOnly(rangeStart)!.getTime()) / 86400000 > 5 * 366) {
            return res.status(400).json({ success: false, error: 'date range too large (5 years max)' });
        }

        const typeParam = typeof q.type === 'string' ? q.type : undefined;
        if (typeParam !== undefined && !(REPORT_TYPES as readonly string[]).includes(typeParam)) {
            return res.status(400).json({ success: false, error: `type must be one of ${REPORT_TYPES.join(', ')}` });
        }
        const type = (typeParam ?? 'expenses') as 'expenses' | 'income' | 'net';

        const splitParam = typeof q.split === 'string' ? q.split : undefined;
        if (splitParam !== undefined && !(REPORT_SPLITS as readonly string[]).includes(splitParam)) {
            return res.status(400).json({ success: false, error: `split must be one of ${REPORT_SPLITS.join(', ')}` });
        }
        const split = (splitParam ?? 'month') as 'month' | 'category' | 'member';

        const includeRecurring = q.include_recurring === undefined
            ? true
            : !(q.include_recurring === 'false' || q.include_recurring === '0');

        const categories = parseListParam(q.categories);
        const members = parseListParam(q.members);

        // One-off entries: exactly the GET /entries filter semantics.
        let entriesSql = `SELECT be.date, be.category, be.assigned_to, be.amount, be.is_expense
            FROM budget_entries be
            WHERE be.user_id = $1
              AND be.date >= $2::date
              AND be.date <= $3::date`;
        const params: any[] = [req.userId, rangeStart, rangeEnd];
        if (type === 'expenses') entriesSql += ' AND be.is_expense = true';
        if (type === 'income') entriesSql += ' AND be.is_expense = false';
        if (categories.length > 0) {
            params.push(categories);
            entriesSql += ` AND be.category = ANY($${params.length}::text[])`;
        }
        if (members.length > 0) {
            params.push(members);
            entriesSql += ` AND be.assigned_to::text = ANY($${params.length}::text[])`;
        }
        const entriesResult = await query(entriesSql, params);

        // Virtual recurring occurrences over the range (same series filter as
        // the statistics routes). The members filter does not apply: an
        // occurrence has no assigned member.
        let occurrences: any[] = [];
        if (includeRecurring) {
            let seriesSql = `SELECT *
                FROM recurring_expenses
                WHERE user_id = $1
                  AND is_active = true
                  AND start_date <= $3::date
                  AND (recurrence_until IS NULL OR recurrence_until >= $2::date)`;
            const seriesParams: any[] = [req.userId, rangeStart, rangeEnd];
            if (type === 'expenses') seriesSql += ' AND is_expense = true';
            if (type === 'income') seriesSql += ' AND is_expense = false';
            if (categories.length > 0) {
                seriesParams.push(categories);
                seriesSql += ` AND category = ANY($${seriesParams.length}::text[])`;
            }
            const seriesResult = await query(seriesSql, seriesParams);
            occurrences = expandRecurringTransactions(
                seriesResult.rows.map(mapRecurringTransaction),
                rangeStart,
                rangeEnd
            );
        }

        // Bucketing. Signed amount: expenses and income count positive in their
        // own type; net = income − expenses.
        const signed = (amount: number, isExpense: boolean): number =>
            type === 'net' ? (isExpense ? -amount : amount) : amount;

        const buckets = new Map<string | null, { total: number; count: number; recurring_total: number }>();
        const bucketFor = (key: string | null) => {
            const bucket = buckets.get(key);
            if (bucket) return bucket;
            const created = { total: 0, count: 0, recurring_total: 0 };
            buckets.set(key, created);
            return created;
        };

        const keyOf = (dateValue: unknown, category: unknown, assignedTo: unknown): string | null => {
            if (split === 'month') return String(dateValue).slice(0, 7);
            if (split === 'category') return String(category ?? '');
            return assignedTo ? String(assignedTo) : null;
        };

        for (const row of entriesResult.rows as Array<{ date: unknown; category: string; assigned_to: unknown; amount: unknown; is_expense: boolean }>) {
            const bucket = bucketFor(keyOf(row.date, row.category, row.assigned_to));
            bucket.total += signed(toNumber(row.amount), Boolean(row.is_expense));
            bucket.count += 1;
        }
        for (const occurrence of occurrences) {
            const bucket = bucketFor(keyOf(occurrence.occurrence_date, occurrence.category, null));
            const value = signed(toNumber(occurrence.amount), Boolean(occurrence.is_expense));
            bucket.total += value;
            bucket.count += 1;
            bucket.recurring_total += value;
        }

        // Labels for the member split.
        let memberNames = new Map<string, string>();
        if (split === 'member') {
            const ids = [...buckets.keys()].filter((key): key is string => key !== null);
            if (ids.length > 0) {
                const membersResult = await query(
                    'SELECT id, name FROM family_members WHERE user_id = $1 AND id::text = ANY($2::text[])',
                    [req.userId, ids]
                );
                memberNames = new Map(membersResult.rows.map((m: any) => [String(m.id), String(m.name)]));
            }
        }

        const toRow = (key: string | null, bucket: { total: number; count: number; recurring_total: number }) => ({
            key,
            label: split === 'member' ? (key === null ? null : memberNames.get(key) ?? null) : key,
            total: round2(bucket.total),
            count: bucket.count,
            average: bucket.count > 0 ? round2(bucket.total / bucket.count) : 0,
            recurring_total: round2(bucket.recurring_total),
        });

        let rows: Array<ReturnType<typeof toRow>>;
        if (split === 'month') {
            // Every month of the range, empty ones included (chart-ready).
            const first = parseDateOnly(rangeStart)!;
            const months: string[] = [];
            let cursor = { year: first.getUTCFullYear(), month: first.getUTCMonth() + 1 };
            while (`${cursor.year}-${String(cursor.month).padStart(2, '0')}` <= rangeEnd.slice(0, 7)) {
                months.push(`${cursor.year}-${String(cursor.month).padStart(2, '0')}`);
                cursor = shiftMonth(cursor.year, cursor.month, 1);
                if (months.length > 62) break; // the range is capped at 5 years anyway
            }
            rows = months.map((monthKey) =>
                toRow(monthKey, buckets.get(monthKey) ?? { total: 0, count: 0, recurring_total: 0 })
            );
        } else {
            rows = [...buckets.entries()]
                .sort((a, b) => b[1].total - a[1].total)
                .map(([key, bucket]) => toRow(key, bucket));
        }

        const summary = {
            total: round2(rows.reduce((sum, row) => sum + row.total, 0)),
            count: rows.reduce((sum, row) => sum + row.count, 0),
            average: 0,
            recurring_total: round2(rows.reduce((sum, row) => sum + row.recurring_total, 0)),
        };
        summary.average = summary.count > 0 ? round2(summary.total / summary.count) : 0;

        res.json({
            success: true,
            data: {
                range: { preset: preset ?? 'custom', start_date: rangeStart, end_date: rangeEnd },
                params: { type, split, include_recurring: includeRecurring, categories, members },
                summary,
                rows,
            },
        });
    } catch (error) {
        console.error('Get budget report error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

export default router;
