import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app, query, registerWithPassword, resetState, startSuite, stopSuite } from './helpers';
import { coreMigrations } from '../src/migrations/registry';
import { annualMigrations } from '../src/migrations/annual';
import { validateRegistry } from '../src/migrations/runner';
import { LIST_ICONS, SHOPPING_STORE_NAME_MAX } from '@openfamily/shared';

// Shopping stores (fonctionnalité 16 du fork) : migration annual/0010,
// API /api/shopping/stores + store_id sur POST/PUT /api/shopping —
// gestion des magasins = parents seuls (requireParent), items = tous,
// suppression d'un magasin → articles rapatriés en NULL (Général) via la FK,
// contrat GET /api/shopping inchangé (store_id additif).

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
const del = (path: string, token = parent.token) => request(app).delete(path).set(as(token));

const createStore = async (body: Record<string, unknown> = {}): Promise<any> => {
    const res = await post('/api/shopping/stores', { name: 'Leclerc', icon: '🛒', ...body });
    expect(res.status).toBe(200);
    return res.body.data;
};

const addShoppingItem = async (body: Record<string, unknown> = {}, token = parent.token): Promise<any> => {
    const res = await post('/api/shopping', { name: 'Lait', category: 'Alimentation', ...body }, token);
    expect(res.status).toBe(200);
    return res.body.data;
};

describe('migration annual/0010', () => {
    it('validates in the combined registry, is recorded, and created the table + column', async () => {
        expect(() => validateRegistry([...coreMigrations, ...annualMigrations])).not.toThrow();
        const ids = annualMigrations.map((m) => m.id);
        expect(ids).toContain('annual/0010-shopping-stores');
        expect(ids.indexOf('annual/0010-shopping-stores')).toBeGreaterThan(ids.indexOf('annual/0009-lists-module'));
        const recorded = await query(
            "SELECT id FROM openfamily_schema_migrations WHERE id = 'annual/0010-shopping-stores'"
        );
        expect(recorded.rows.length).toBe(1);
        const table = await query('SELECT 1 FROM information_schema.tables WHERE table_name = $1', ['shopping_stores']);
        expect(table.rows.length).toBe(1);
        const col = await query(
            "SELECT 1 FROM information_schema.columns WHERE table_name = 'shopping_items' AND column_name = 'store_id'"
        );
        expect(col.rows.length).toBe(1);
        // FK ON DELETE SET NULL : la suppression d'un magasin rapatrie les articles
        const fk = await query(
            `SELECT confdeltype FROM pg_constraint WHERE conrelid = 'shopping_items'::regclass AND confrelid = 'shopping_stores'::regclass`
        );
        expect(fk.rows.length).toBe(1);
        expect(fk.rows[0].confdeltype).toBe('n'); // SET NULL
    });
});

describe('stores CRUD + permissions', () => {
    it('GET /stores : 401 sans token, lecture ouverte à tous les membres, ordonné par position', async () => {
        expect((await request(app).get('/api/shopping/stores')).status).toBe(401);
        const s1 = await createStore({ name: 'Leclerc', icon: '🛒' });
        expect((await post('/api/shopping/stores', { name: 'Picard', icon: '🧊' })).status).toBe(400); // hors jeu
        const s3 = await createStore({ name: 'Castorama', icon: '🔧' });
        expect(s1.position).toBe(1);
        expect(s3.position).toBe(2);
        const res = await get('/api/shopping/stores', child.token);
        expect(res.status).toBe(200);
        expect(res.body.data.map((s: any) => s.name)).toEqual(['Leclerc', 'Castorama']);
        expect(res.body.data[0]).toMatchObject({ icon: '🛒' });
        expect(res.body.data[0].user_id).toBeUndefined(); // pas de divulgation interne
    });

    it('POST /stores : parent seul (403 enfant, 401 sans token), validations 400 (nom vide/trop long, icône hors jeu)', async () => {
        expect((await post('/api/shopping/stores', { name: 'X' }, child.token)).status).toBe(403);
        expect((await request(app).post('/api/shopping/stores').send({ name: 'X' })).status).toBe(401);
        expect((await post('/api/shopping/stores', { name: '   ' })).status).toBe(400);
        expect((await post('/api/shopping/stores', { name: 'a'.repeat(SHOPPING_STORE_NAME_MAX + 1) })).status).toBe(400);
        expect((await post('/api/shopping/stores', { name: 'Ok', icon: '🍕' })).status).toBe(400);
        const ok = await post('/api/shopping/stores', { name: 'Ok' }); // icône par défaut 🛒
        expect(ok.status).toBe(200);
        expect(ok.body.data.icon).toBe('🛒');
        for (const icon of LIST_ICONS) {
            expect((await post('/api/shopping/stores', { name: `S ${icon}`, icon })).status).toBe(200);
        }
    });

    it('PUT /stores/:id : renommage + icône + réordonnancement (move-with-shift), 403 enfant, 404 hors famille', async () => {
        const a = await createStore({ name: 'A' });
        const b = await createStore({ name: 'B' });
        const c = await createStore({ name: 'C' });
        // B en position 1 : A et C décalés
        const moved = await put(`/api/shopping/stores/${b.id}`, { position: 1 });
        expect(moved.status).toBe(200);
        expect(moved.body.data.position).toBe(1);
        const list = (await get('/api/shopping/stores')).body.data;
        expect(list.map((s: any) => s.name)).toEqual(['B', 'A', 'C']);
        expect(list.map((s: any) => s.position)).toEqual([1, 2, 3]);
        // renommage + icône
        const renamed = await put(`/api/shopping/stores/${c.id}`, { name: 'C2', icon: '🌳' });
        expect(renamed.status).toBe(200);
        expect(renamed.body.data).toMatchObject({ name: 'C2', icon: '🌳' });
        // bornes
        expect((await put(`/api/shopping/stores/${c.id}`, { name: '' })).status).toBe(400);
        expect((await put(`/api/shopping/stores/${c.id}`, { icon: '🍕' })).status).toBe(400);
        expect((await put(`/api/shopping/stores/${c.id}`, { position: 0 })).status).toBe(400);
        expect((await put(`/api/shopping/stores/${c.id}`, { position: 99 })).status).toBe(200); // clampé
        // permissions
        expect((await put(`/api/shopping/stores/${a.id}`, { name: 'X' }, child.token)).status).toBe(403);
        const other = await registerWithPassword('other@example.org');
        expect((await put(`/api/shopping/stores/${a.id}`, { name: 'X' }, other.token)).status).toBe(404);
    });

    it('DELETE /stores/:id : 403 enfant, 404 hors famille, et les articles retombent en Général (store_id NULL)', async () => {
        const store = await createStore({ name: 'Picard' });
        const i1 = await addShoppingItem({ name: 'Petits pois', store_id: store.id });
        const i2 = await addShoppingItem({ name: 'Glace', store_id: store.id });
        expect(i1.store_id).toBe(store.id);
        expect((await del(`/api/shopping/stores/${store.id}`, child.token)).status).toBe(403);
        const other = await registerWithPassword('other@example.org');
        expect((await del(`/api/shopping/stores/${store.id}`, other.token)).status).toBe(404);
        expect((await del(`/api/shopping/stores/${store.id}`)).status).toBe(200);
        const items = (await get('/api/shopping')).body.data;
        expect(items.find((i: any) => i.id === i1.id).store_id).toBeNull();
        expect(items.find((i: any) => i.id === i2.id).store_id).toBeNull();
        expect((await get('/api/shopping/stores')).body.data).toEqual([]);
    });
});

describe('items store_id + contrat GET inchangé', () => {
    it('POST /api/shopping : store_id valide / null / absent, 404 autre famille, 400 garbage', async () => {
        const store = await createStore();
        const inStore = await addShoppingItem({ store_id: store.id });
        expect(inStore.store_id).toBe(store.id);
        const general = await addShoppingItem({ store_id: null });
        expect(general.store_id).toBeNull();
        const absent = await addShoppingItem({});
        expect(absent.store_id).toBeNull();
        const other = await registerWithPassword('other@example.org');
        const foreignStore = (await post('/api/shopping/stores', { name: 'Foreign' }, other.token)).body.data;
        expect((await post('/api/shopping', { name: 'X', category: 'Autre', store_id: foreignStore.id })).status).toBe(404);
        expect((await post('/api/shopping', { name: 'X', category: 'Autre', store_id: 'garbage' })).status).toBe(400);
    });

    it('PUT /api/shopping/:id : déplacer vers un magasin, revenir à Général (null), 404 magasin étranger', async () => {
        const store = await createStore();
        const item = await addShoppingItem({});
        const moved = await put(`/api/shopping/${item.id}`, { store_id: store.id });
        expect(moved.status).toBe(200);
        expect(moved.body.data.store_id).toBe(store.id);
        const back = await put(`/api/shopping/${item.id}`, { store_id: null });
        expect(back.body.data.store_id).toBeNull();
        const other = await registerWithPassword('other@example.org');
        const foreignStore = (await post('/api/shopping/stores', { name: 'Foreign' }, other.token)).body.data;
        expect((await put(`/api/shopping/${item.id}`, { store_id: foreignStore.id })).status).toBe(404);
        // la coche et le reste du contrat continuent de marcher
        const checked = await put(`/api/shopping/${item.id}`, { is_checked: true });
        expect(checked.body.data.is_checked).toBe(true);
    });

    it('GET /api/shopping : shape inchangée (champs d\'origine) + store_id additif présent', async () => {
        const store = await createStore();
        await addShoppingItem({ name: 'Pain', quantity: 2, unit: 'baguette', price: 1.2, notes: 'bien cuit', store_id: store.id });
        const res = await get('/api/shopping');
        expect(res.status).toBe(200);
        const row = res.body.data[0];
        for (const key of ['id', 'user_id', 'name', 'category', 'quantity', 'unit', 'price', 'is_checked', 'notes', 'created_at', 'updated_at']) {
            expect(row).toHaveProperty(key);
        }
        expect(row).toHaveProperty('store_id');
        expect(row.store_id).toBe(store.id);
        expect(row.name).toBe('Pain');
    });

    it('les items restent accessibles à tous les membres (enfant peut ajouter/cocher dans un magasin)', async () => {
        const store = await createStore();
        const item = await addShoppingItem({ store_id: store.id }, child.token);
        expect(item.store_id).toBe(store.id);
        const toggled = await put(`/api/shopping/${item.id}`, { is_checked: true }, child.token);
        expect(toggled.status).toBe(200);
        expect(toggled.body.data.is_checked).toBe(true);
    });
});
