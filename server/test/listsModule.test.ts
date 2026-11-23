import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app, query, registerWithPassword, resetState, startSuite, stopSuite } from './helpers';
import { coreMigrations } from '../src/migrations/registry';
import { annualMigrations } from '../src/migrations/annual';
import { validateRegistry } from '../src/migrations/runner';
import { LIST_ICONS, LIST_ITEM_TEXT_MAX, LIST_CATEGORY_MAX, LIST_NAME_MAX } from '@openfamily/shared';

// Module Listes (fonctionnalité 15 du fork) : migration annual/0009,
// API /api/lists + /api/items — permissions (listes/catégories = parents,
// items = tous), compteurs, check/uncheck (checked_by/checked_at),
// renommage/suppression de catégorie en masse, cascade, validations 400.

beforeAll(startSuite);
afterAll(stopSuite);

let parent: { token: string; user: { id: string } };
let child: { token: string; user: { id: string } };

beforeEach(async () => {
    await resetState();
    parent = await registerWithPassword('parent@example.org');
    const c = await registerWithPassword('child@example.org');
    await query(
        "UPDATE users SET family_owner_id = $1, role = 'enfant' WHERE id = $2",
        [parent.user.id, c.user.id]
    );
    const login = await request(app)
        .post('/api/auth/login')
        .send({ email: 'child@example.org', password: 'correct-horse-1' });
    expect(login.status).toBe(200);
    child = { token: login.body.data.token as string, user: c.user };
});

const as = (token: string) => ({ Authorization: `Bearer ${token}` });
const get = (path: string, token = parent.token) => request(app).get(path).set(as(token));
const post = (path: string, body: unknown, token = parent.token) =>
    request(app).post(path).set(as(token)).send(body as object);
const put = (path: string, body: unknown, token = parent.token) =>
    request(app).put(path).set(as(token)).send(body as object);
const del = (path: string, token = parent.token, body?: unknown) => {
    let r = request(app).delete(path).set(as(token));
    if (body !== undefined) r = r.send(body as object);
    return r;
};

const makeMember = async (linkedUserId: string | null = null, name = 'Kid'): Promise<string> => {
    const res = await query(
        'INSERT INTO family_members (user_id, name, color, linked_user_id) VALUES ($1, $2, $3, $4) RETURNING id',
        [parent.user.id, name, '#16A34A', linkedUserId]
    );
    return res.rows[0].id as string;
};

const createList = async (body: Record<string, unknown> = {}): Promise<any> => {
    const res = await post('/api/lists', { name: 'Courses', icon: '🛒', ...body });
    expect(res.status).toBe(200);
    return res.body.data;
};

const addItem = async (listId: string, body: Record<string, unknown>, token = parent.token): Promise<any> => {
    const res = await post(`/api/lists/${listId}/items`, { text: 'Lait', ...body }, token);
    expect(res.status).toBe(200);
    return res.body.data;
};

describe('migration annual/0009', () => {
    it('validates in the combined registry, is recorded, and created the tables + icon CHECK matching LIST_ICONS', async () => {
        expect(() => validateRegistry([...coreMigrations, ...annualMigrations])).not.toThrow();
        const ids = annualMigrations.map((m) => m.id);
        expect(ids).toContain('annual/0009-lists-module');
        expect(ids.indexOf('annual/0009-lists-module')).toBeGreaterThan(ids.indexOf('annual/0008-tasks-reminders'));
        const recorded = await query(
            "SELECT id FROM openfamily_schema_migrations WHERE id = 'annual/0009-lists-module'"
        );
        expect(recorded.rows.length).toBe(1);
        for (const table of ['lists', 'list_items']) {
            const t = await query('SELECT 1 FROM information_schema.tables WHERE table_name = $1', [table]);
            expect(t.rows.length).toBe(1);
        }
        // CHECK icon en base : un emoji hors du jeu fixe est rejeté.
        await expect(
            query("INSERT INTO lists (user_id, name, icon) VALUES ($1, 'x', '🦄')", [parent.user.id])
        ).rejects.toThrow();
        // et chaque icône du jeu partagé passe.
        for (const icon of LIST_ICONS) {
            await query('INSERT INTO lists (user_id, name, icon) VALUES ($1, $2, $3)', [parent.user.id, `l-${icon}`, icon]);
        }
        // Bornes en base : texte > 200 et catégorie > 60 rejetés.
        const list = await createList();
        await expect(
            query('INSERT INTO list_items (list_id, text, position) VALUES ($1, $2, 1)', [list.id, 'x'.repeat(LIST_ITEM_TEXT_MAX + 1)])
        ).rejects.toThrow();
        await expect(
            query('INSERT INTO list_items (list_id, text, category, position) VALUES ($1, $2, $3, 1)', [list.id, 'ok', 'c'.repeat(LIST_CATEGORY_MAX + 1)])
        ).rejects.toThrow();
        await expect(
            query("INSERT INTO lists (user_id, name) VALUES ($1, $2)", [parent.user.id, 'n'.repeat(LIST_NAME_MAX + 1)])
        ).rejects.toThrow();
    });
});

describe('permissions', () => {
    it('listes + catégories en masse : enfant = 403, parent = 200', async () => {
        const list = await createList();
        expect((await post('/api/lists', { name: 'X' }, child.token)).status).toBe(403);
        expect((await put(`/api/lists/${list.id}`, { name: 'Y' }, child.token)).status).toBe(403);
        expect((await del(`/api/lists/${list.id}`, child.token)).status).toBe(403);
        expect((await put(`/api/lists/${list.id}/category`, { from: 'a', to: 'b' }, child.token)).status).toBe(403);
        expect((await del(`/api/lists/${list.id}/category`, child.token, { name: 'a' })).status).toBe(403);
        // Items : tous les membres.
        const item = await addItem(list.id, { text: 'Pain' }, child.token);
        expect((await put(`/api/items/${item.id}`, { checked: true }, child.token)).status).toBe(200);
        expect((await put(`/api/items/${item.id}`, { text: 'Pain complet' }, child.token)).status).toBe(200);
        expect((await del(`/api/items/${item.id}`, child.token)).status).toBe(200);
    });

    it('lecture : enfant voit les listes et les items', async () => {
        const list = await createList();
        await addItem(list.id, { text: 'Lait', category: 'Frais' });
        const lists = await get('/api/lists', child.token);
        expect(lists.status).toBe(200);
        expect(lists.body.data.length).toBe(1);
        const items = await get(`/api/lists/${list.id}/items`, child.token);
        expect(items.status).toBe(200);
        expect(items.body.data.items.length).toBe(1);
    });

    it('aucun endpoint public : 401 sans token', async () => {
        expect((await request(app).get('/api/lists')).status).toBe(401);
        expect((await request(app).get('/api/lists/xyz/items')).status).toBe(401);
        expect((await request(app).put('/api/items/xyz').send({ checked: true })).status).toBe(401);
    });

    it('404 hors famille : une autre famille ne voit ni ne modifie rien', async () => {
        const list = await createList();
        const other = await registerWithPassword('other@example.org');
        expect((await get(`/api/lists/${list.id}/items`, other.token)).status).toBe(404);
        expect((await put(`/api/lists/${list.id}`, { name: 'Piraté' }, other.token)).status).toBe(404);
        expect((await del(`/api/lists/${list.id}`, other.token)).status).toBe(404);
        const item = await addItem(list.id, {});
        expect((await put(`/api/items/${item.id}`, { checked: true }, other.token)).status).toBe(404);
        expect((await del(`/api/items/${item.id}`, other.token)).status).toBe(404);
    });
});

describe('listes + compteurs', () => {
    it('GET /api/lists renvoie les compteurs {total, unchecked, done} exacts', async () => {
        const list = await createList({ name: 'A' });
        await createList({ name: 'B', icon: '🎒' });
        await addItem(list.id, { text: 'a' });
        await addItem(list.id, { text: 'b' });
        const c = await addItem(list.id, { text: 'c' });
        await put(`/api/items/${c.id}`, { checked: true });
        const res = await get('/api/lists');
        expect(res.status).toBe(200);
        const a = res.body.data.find((l: any) => l.name === 'A');
        const b = res.body.data.find((l: any) => l.name === 'B');
        expect(a.counts).toEqual({ total: 3, unchecked: 2, done: 1 });
        expect(b.counts).toEqual({ total: 0, unchecked: 0, done: 0 });
        expect(b.icon).toBe('🎒');
    });

    it('création : nom requis, icône du jeu fixe, défaut 📝, created_by = profil lié', async () => {
        const member = await makeMember(parent.user.id, 'Maman');
        const res = await post('/api/lists', { name: '  Ma liste  ' });
        expect(res.status).toBe(200);
        expect(res.body.data.name).toBe('Ma liste');
        expect(res.body.data.icon).toBe('📝');
        expect(res.body.data.created_by).toBe(member);
    });

    it('validations 400 : nom vide/trop long, icône hors jeu, texte vide/trop long, catégorie trop longue', async () => {
        expect((await post('/api/lists', { name: '  ' })).status).toBe(400);
        expect((await post('/api/lists', { name: 'x'.repeat(LIST_NAME_MAX + 1) })).status).toBe(400);
        expect((await post('/api/lists', { name: 'ok', icon: '🦄' })).status).toBe(400);
        expect((await post('/api/lists', { name: 'ok', icon: 42 })).status).toBe(400);
        const list = await createList();
        expect((await post(`/api/lists/${list.id}/items`, { text: '' })).status).toBe(400);
        expect((await post(`/api/lists/${list.id}/items`, {})).status).toBe(400);
        expect((await post(`/api/lists/${list.id}/items`, { text: 'x'.repeat(LIST_ITEM_TEXT_MAX + 1) })).status).toBe(400);
        expect((await post(`/api/lists/${list.id}/items`, { text: 'ok', category: 'c'.repeat(LIST_CATEGORY_MAX + 1) })).status).toBe(400);
        // catégorie vide → NULL, pas une erreur
        const item = await addItem(list.id, { text: 'ok', category: '   ' });
        expect(item.category).toBeNull();
        const item2 = await addItem(list.id, { text: 'ok2', category: '  Frais  ' });
        expect(item2.category).toBe('Frais');
    });

    it('suppression de liste cascade les items', async () => {
        const list = await createList();
        await addItem(list.id, { text: 'a' });
        await addItem(list.id, { text: 'b' });
        expect((await del(`/api/lists/${list.id}`)).status).toBe(200);
        const remaining = await query('SELECT COUNT(*)::int AS c FROM list_items WHERE list_id = $1', [list.id]);
        expect(remaining.rows[0].c).toBe(0);
        expect((await get('/api/lists')).body.data.length).toBe(0);
    });
});

describe('items', () => {
    it('positions croissantes (ordre de création), tri position dans GET items', async () => {
        const list = await createList();
        const a = await addItem(list.id, { text: 'premier' });
        const b = await addItem(list.id, { text: 'deuxième' });
        const c = await addItem(list.id, { text: 'troisième' });
        expect(a.position).toBe(1);
        expect(b.position).toBe(2);
        expect(c.position).toBe(3);
        const res = await get(`/api/lists/${list.id}/items`);
        expect(res.body.data.items.map((i: any) => i.text)).toEqual(['premier', 'deuxième', 'troisième']);
        // compteurs par catégorie, null-safe
        await put(`/api/items/${a.id}`, { category: 'Frais' });
        const res2 = await get(`/api/lists/${list.id}/items`);
        const cats = res2.body.data.categories;
        const frais = cats.find((x: any) => x.name === 'Frais');
        const none = cats.find((x: any) => x.name === null);
        expect(frais).toMatchObject({ total: 1, unchecked: 1 });
        expect(none).toMatchObject({ total: 2, unchecked: 2 });
    });

    it('check/décoche : checked_by/checked_at renseignés puis remis à NULL', async () => {
        const member = await makeMember(child.user.id, 'Léo');
        const list = await createList();
        const item = await addItem(list.id, { text: 'Devoirs' });
        const checked = await put(`/api/items/${item.id}`, { checked: true }, child.token);
        expect(checked.status).toBe(200);
        expect(checked.body.data.checked).toBe(true);
        expect(checked.body.data.checked_by).toBe(member);
        expect(checked.body.data.checked_at).toBeTruthy();
        const unchecked = await put(`/api/items/${item.id}`, { checked: false }, child.token);
        expect(unchecked.body.data.checked).toBe(false);
        expect(unchecked.body.data.checked_by).toBeNull();
        expect(unchecked.body.data.checked_at).toBeNull();
        // checked non booléen → 400
        expect((await put(`/api/items/${item.id}`, { checked: 'oui' })).status).toBe(400);
    });

    it('édition d\'item : texte + catégorie (vide → NULL)', async () => {
        const list = await createList();
        const item = await addItem(list.id, { text: 'Lait', category: 'Frais' });
        const res = await put(`/api/items/${item.id}`, { text: 'Lait demi-écrémé', category: '' });
        expect(res.status).toBe(200);
        expect(res.body.data.text).toBe('Lait demi-écrémé');
        expect(res.body.data.category).toBeNull();
        expect((await put(`/api/items/${item.id}`, { text: '' })).status).toBe(400);
    });
});

describe('catégories en masse (parents)', () => {
    it('PUT category : renomme from→to sur tous les items de la liste, sans toucher le reste', async () => {
        const list = await createList();
        const other = await createList({ name: 'Autre' });
        const a = await addItem(list.id, { text: 'a', category: 'Frais' });
        const b = await addItem(list.id, { text: 'b', category: 'Frais' });
        await addItem(list.id, { text: 'c', category: 'Sec' });
        await addItem(other.id, { text: 'x', category: 'Frais' });

        const res = await put(`/api/lists/${list.id}/category`, { from: 'Frais', to: 'Frais bio' });
        expect(res.status).toBe(200);
        expect(res.body.data.updated).toBe(2);

        const items = (await get(`/api/lists/${list.id}/items`)).body.data.items;
        expect(items.find((i: any) => i.id === a.id).category).toBe('Frais bio');
        expect(items.find((i: any) => i.id === b.id).category).toBe('Frais bio');
        expect(items.find((i: any) => i.text === 'c').category).toBe('Sec');
        // l'autre liste est intacte
        const otherItems = (await get(`/api/lists/${other.id}/items`)).body.data.items;
        expect(otherItems[0].category).toBe('Frais');
        // validations
        expect((await put(`/api/lists/${list.id}/category`, { from: '', to: 'x' })).status).toBe(400);
        expect((await put(`/api/lists/${list.id}/category`, { from: 'Sec', to: '' })).status).toBe(400);
        expect((await put(`/api/lists/${list.id}/category`, { from: 'Sec', to: 'c'.repeat(LIST_CATEGORY_MAX + 1) })).status).toBe(400);
    });

    it('DELETE category : met les items à NULL', async () => {
        const list = await createList();
        await addItem(list.id, { text: 'a', category: 'Frais' });
        await addItem(list.id, { text: 'b', category: 'Frais' });
        await addItem(list.id, { text: 'c', category: 'Sec' });
        const res = await del(`/api/lists/${list.id}/category`, parent.token, { name: 'Frais' });
        expect(res.status).toBe(200);
        expect(res.body.data.updated).toBe(2);
        const items = (await get(`/api/lists/${list.id}/items`)).body.data.items;
        expect(items.filter((i: any) => i.category === null).length).toBe(2);
        expect(items.find((i: any) => i.text === 'c').category).toBe('Sec');
        expect((await del(`/api/lists/${list.id}/category`, parent.token, { name: '' })).status).toBe(400);
    });
});
