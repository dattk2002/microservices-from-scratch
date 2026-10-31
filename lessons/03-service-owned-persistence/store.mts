import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseProduct, snapshot } from './domain.mts';
import type { Order, Product } from './domain.mts';

const catalogSchema = `
  CREATE TABLE products (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100),
    priceCents INTEGER NOT NULL CHECK(priceCents BETWEEN 0 AND 100000000)
  ) STRICT;
  INSERT INTO products VALUES ('pencil', 'Pencil', 125), ('notebook', 'Notebook', 450);
`;
const ordersSchema = `
  CREATE TABLE orders (
    id TEXT PRIMARY KEY,
    productId TEXT NOT NULL,
    productName TEXT NOT NULL CHECK(length(trim(productName)) BETWEEN 1 AND 100),
    priceCents INTEGER NOT NULL CHECK(priceCents BETWEEN 0 AND 100000000),
    quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 100),
    totalCents INTEGER NOT NULL CHECK(totalCents = priceCents * quantity)
  ) STRICT;
`;

function openOwnedDatabase(path: string, owner: 'catalog' | 'orders'): DatabaseSync {
  if (!path.trim() || path === ':memory:') throw new Error('Use a durable database file path');
  const filename = resolve(path);
  mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename, { timeout: 1000 });
  // Distinct SQLite application_id values are a guard against opening the other service's file.
  const expectedId = owner === 'catalog' ? 0x43415433 : 0x4f524433;
  try {
    db.exec('BEGIN IMMEDIATE');
    const applicationId = db.prepare('PRAGMA application_id').get()?.application_id;
    const version = db.prepare('PRAGMA user_version').get()?.user_version;
    if (applicationId === 0 && version === 0) {
      const tables = db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").get()?.n;
      if (tables !== 0) throw new Error('Refusing to adopt an existing unowned database');
      db.exec(owner === 'catalog' ? catalogSchema : ordersSchema);
      db.exec(`PRAGMA application_id = ${expectedId}; PRAGMA user_version = 1;`);
    } else {
      if (applicationId !== expectedId) throw new Error('Database belongs to another service');
      if (version !== 1) throw new Error('Unsupported schema version; migrate explicitly');
    }
    db.exec('COMMIT');
    return db;
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    db.close();
    throw error;
  }
}

export class CatalogStore {
  readonly #db: DatabaseSync;
  constructor(path: string) { this.#db = openOwnedDatabase(path, 'catalog'); }
  get(id: string): Product | undefined {
    const row = this.#db.prepare('SELECT id, name, priceCents FROM products WHERE id = ?').get(id);
    if (!row) return undefined;
    try { return parseProduct(row, id); }
    catch (cause) { throw new Error('Corrupt persisted product', { cause }); }
  }
  close() { this.#db.close(); }
}

export class OrdersStore {
  readonly #db: DatabaseSync;
  constructor(path: string) { this.#db = openOwnedDatabase(path, 'orders'); }
  create(order: Order): void {
    const validated = snapshot(order.id, { productId: order.product.id, quantity: order.quantity }, order.product);
    if (validated.totalCents !== order.totalCents) throw new Error('Invalid snapshot total');
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#db.prepare(`INSERT INTO orders (id, productId, productName, priceCents, quantity, totalCents)
        VALUES (?, ?, ?, ?, ?, ?)`).run(validated.id, validated.product.id, validated.product.name,
        validated.product.priceCents, validated.quantity, validated.totalCents);
      this.#db.exec('COMMIT');
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
      throw error;
    }
  }
  get(id: string): Order | undefined {
    const row = this.#db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    if (!row) return undefined;
    try {
      if (typeof row.id !== 'string' || typeof row.productId !== 'string' || typeof row.quantity !== 'number') {
        throw new Error('Invalid persisted fields');
      }
      const product = parseProduct({ id: row.productId, name: row.productName, priceCents: row.priceCents }, row.productId);
      const order = snapshot(row.id, { productId: product.id, quantity: row.quantity }, product);
      if (row.totalCents !== order.totalCents) throw new Error('Invalid persisted total');
      return order;
    } catch (cause) { throw new Error('Corrupt persisted order', { cause }); }
  }
  close() { this.#db.close(); }
}
