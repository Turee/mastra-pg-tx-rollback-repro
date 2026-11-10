// PoolAdapter.tx() in @mastra/pg returns a client with an open transaction to a caller-supplied pool.
// See README.md. DATABASE_URL defaults to the database in docker-compose.yml.
import pg from 'pg';
import { PostgresStore } from '@mastra/pg';

const connectionString = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:54329/postgres';

// The application's own pool, shared with the store. max: 1 only makes "the same connection" deterministic.
const pool = new pg.Pool({ connectionString, max: 1, query_timeout: 500 });
const store = new PostgresStore({ id: 'repro', pool });
await store.init();
const memory = await store.getStore('memory');

const now = new Date();
await memory.saveThread({
  thread: { id: 't1', resourceId: 'r1', title: 'repro', createdAt: now, updatedAt: now, metadata: {} },
});

// Another session holds a row lock on the thread, as any concurrent writer could.
const other = new pg.Client({ connectionString });
await other.connect();
await other.query('BEGIN');
await other.query('SELECT 1 FROM mastra_threads WHERE id = $1 FOR UPDATE', ['t1']);

// saveMessages runs in tx(). Its statement waits on the lock and hits query_timeout;
// the ROLLBACK that tx() then sends waits behind it and hits query_timeout too.
const message = {
  id: 'm1',
  threadId: 't1',
  resourceId: 'r1',
  role: 'user',
  type: 'v2',
  createdAt: new Date(),
  content: { format: 2, parts: [{ type: 'text', text: 'hello' }] },
};
await memory.saveMessages({ messages: [message] }).then(
  () => console.log('saveMessages: resolved'),
  (error) => console.log('saveMessages: rejected:', error.message),
);

// The lock holder finishes; the server now completes the store's statement inside the abandoned transaction.
await other.query('COMMIT');
await new Promise((resolve) => setTimeout(resolve, 500));

const count = async (q) => (await q.query('SELECT count(*)::int AS n FROM mastra_messages WHERE id = $1', ['m1'])).rows[0].n;
console.log('rows visible to another session:', await count(other));

// The application checks a client out of its own pool for its own transaction.
const client = await pool.connect();
client.on('notice', (notice) => console.log('notice on BEGIN:', notice.message));
console.log('rows visible on the checked-out client, before its BEGIN:', await count(client));
console.log('transaction status before BEGIN:', client.getTransactionStatus?.());
await client.query('BEGIN');
await client.query('SELECT 1'); // the application's own work
await client.query('COMMIT');
client.release();

const committed = await count(other);
console.log('rows visible to another session after the application COMMIT:', committed);
console.log(
  committed === 0
    ? 'OK: the rejected saveMessages was not committed'
    : 'BUG: the rejected saveMessages was committed by an unrelated transaction',
);
process.exitCode = committed === 0 ? 0 : 1;

await other.end();
await pool.end();
