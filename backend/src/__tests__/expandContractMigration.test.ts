import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { runner as migrate } from 'node-pg-migrate';
import pg from 'pg';

const url = process.env.DATABASE_URL;
const describeIf = url ? describe : describe.skip;
const SCHEMA_PREV = 'ec_prev';
const SCHEMA_FRESH = 'ec_fresh';

const run = (schema: string, opts: { dir: string; table: string; direction?: 'up' | 'down'; count?: number; file?: string }) =>
  migrate({
    databaseUrl: url!,
    dir: opts.dir,
    migrationsTable: opts.table,
    schema,
    direction: opts.direction ?? 'up',
    count: opts.count ?? Infinity,
    ...(opts.file ? { file: opts.file } : {}),
    log: () => undefined,
    singleTransaction: true,
  } as never);

const EXPAND = '1806000000000_notifications-read-at-expand';

describeIf('expand-contract: notifications.read -> read_at', () => {
  const pool = new pg.Pool({ connectionString: url });
  const q = (schema: string, sql: string, params: unknown[] = []) =>
    pool.connect().then(async (c) => {
      try {
        await c.query(`SET search_path TO ${schema}`);
        return await c.query(sql, params);
      } finally {
        c.release();
      }
    });

  beforeAll(async () => {
    for (const s of [SCHEMA_PREV, SCHEMA_FRESH]) {
      await pool.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
      await pool.query(`CREATE SCHEMA ${s}`);
    }
    // Prior schema: everything up to (not including) the expand migration, with data.
    const all = (await import('node:fs')).readdirSync('migrations').filter((f) => f.endsWith('.js')).sort();
    const idx = all.findIndex((f) => f.startsWith(EXPAND));
    await run(SCHEMA_PREV, { dir: 'migrations', table: 'pgmigrations', count: idx });
    await q(
      SCHEMA_PREV,
      `INSERT INTO notifications (user_id, type, title, message, read) VALUES
       ('u1','score_changed','a','a',true), ('u1','score_changed','b','b',false)`,
    );
    await run(SCHEMA_PREV, { dir: 'migrations', table: 'pgmigrations' });
    await run(SCHEMA_FRESH, { dir: 'migrations', table: 'pgmigrations' });
  }, 120_000);

  afterAll(async () => {
    for (const s of [SCHEMA_PREV, SCHEMA_FRESH]) await pool.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
    await pool.end();
  });

  it('backfills populated prior schema and works on fresh install', async () => {
    const prev = await q(SCHEMA_PREV, 'SELECT read, read_at FROM notifications ORDER BY id');
    expect(prev.rows[0].read_at).not.toBeNull();
    expect(prev.rows[1].read_at).toBeNull();
    const cols = await q(SCHEMA_FRESH, `SELECT 1 FROM information_schema.columns WHERE table_schema='${SCHEMA_FRESH}' AND table_name='notifications' AND column_name='read_at'`);
    expect(cols.rowCount).toBe(1);
  });

  it('keeps old (read) and new (read_at) writers in sync', async () => {
    await q(SCHEMA_FRESH, `INSERT INTO notifications (user_id,type,title,message,read) VALUES ('o','score_changed','t','m',true)`);
    await q(SCHEMA_FRESH, `INSERT INTO notifications (user_id,type,title,message,read_at) VALUES ('n','score_changed','t','m',now())`);
    const r = await q(SCHEMA_FRESH, `SELECT user_id, read, read_at FROM notifications WHERE user_id IN ('o','n')`);
    for (const row of r.rows) {
      expect(row.read).toBe(true);
      expect(row.read_at).not.toBeNull();
    }
    await q(SCHEMA_FRESH, `UPDATE notifications SET read_at = NULL WHERE user_id='n'`);
    const u = await q(SCHEMA_FRESH, `SELECT read FROM notifications WHERE user_id='n'`);
    expect(u.rows[0].read).toBe(false);
  });

  it('loses/duplicates no writes under concurrent old+new writers', async () => {
    const N = 50;
    const writes: Promise<unknown>[] = [];
    for (let i = 0; i < N; i++) {
      writes.push(q(SCHEMA_FRESH, `INSERT INTO notifications (user_id,type,title,message,read) VALUES ('conc','score_changed',$1,'m',true)`, [`old-${i}`]));
      writes.push(q(SCHEMA_FRESH, `INSERT INTO notifications (user_id,type,title,message,read_at) VALUES ('conc','score_changed',$1,'m',now())`, [`new-${i}`]));
    }
    await Promise.all(writes);
    const r = await q(SCHEMA_FRESH, `SELECT count(*)::int AS c, count(DISTINCT title)::int AS d, count(*) FILTER (WHERE read AND read_at IS NOT NULL)::int AS consistent FROM notifications WHERE user_id='conc'`);
    expect(r.rows[0]).toEqual({ c: 2 * N, d: 2 * N, consistent: 2 * N });
  });

  it('contract migration is gated and drops the old column independently', async () => {
    await run(SCHEMA_PREV, { dir: 'migrations-contract', table: 'pgmigrations_contract' });
    const cols = await q(SCHEMA_PREV, `SELECT 1 FROM information_schema.columns WHERE table_schema='${SCHEMA_PREV}' AND table_name='notifications' AND column_name='read'`);
    expect(cols.rowCount).toBe(0);
  }, 60_000);
});
