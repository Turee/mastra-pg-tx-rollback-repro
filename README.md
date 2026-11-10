# @mastra/pg: `tx()` returns a client to the pool after a failed ROLLBACK

Minimal reproduction for a bug in `@mastra/pg` (`PoolAdapter.tx()` in
[`stores/pg/src/storage/client.ts`](https://github.com/mastra-ai/mastra/blob/3f1d3a38dfcc7c5f7abb44d7789242cdc16b61e8/stores/pg/src/storage/client.ts#L164-L191)).

## Expected and actual behaviour

**Expected:** when a store operation fails and its transaction cannot be rolled back, the
connection is destroyed (`client.release(err)`), so nothing else can reuse it.

**Actual:** `tx()` logs the failed `ROLLBACK` with `console.error` and calls `client.release()`
without an error. pg-pool keeps the connection, with the store's transaction still open, and
hands it to the next `pool.connect()`. With a caller-supplied pool
(`new PostgresStore({ pool })`), the next checkout is the application's own code: its `BEGIN`
only gets a warning, and its `COMMIT` also commits the writes of the store operation that
rejected.

## Steps to reproduce

Needs Node 22 or later and Docker.

```sh
npm install
npm run db:up     # PostgreSQL 18 on 127.0.0.1:54329
npm run repro     # triggers the bug; exits with 1 while the bug exists
npm run db:down
```

To use another database, set `DATABASE_URL` and skip `db:up` and `db:down`.

## What the script does

1. Creates a `pg.Pool` with `query_timeout: 500` and passes it to `PostgresStore`.
2. Saves a thread, then takes a row lock on it from a second session.
3. Calls `saveMessages`, which runs in `tx()`. Its statement waits on the lock and hits
   `query_timeout`. The `ROLLBACK` that `tx()` sends is queued behind that statement and hits
   `query_timeout` too; pg removes it from its queue, so it is never sent. `saveMessages`
   rejects, and `tx()` releases the client without an error.
4. Releases the lock. The server completes the store's statement inside the abandoned
   transaction.
5. Checks a client out of the pool, as application code would, and runs `BEGIN`, a query and
   `COMMIT`.

## Output

With `@mastra/pg` 1.35.0 (stack trace shortened):

```
Transaction rollback failed: Error: Query read timeout
    at async PoolAdapter.tx (.../node_modules/@mastra/pg/dist/index.js:2120:6)
    at async MemoryPG.saveMessages (.../node_modules/@mastra/pg/dist/index.js:12890:4)
saveMessages: rejected: Query read timeout
rows visible to another session: 0
rows visible on the checked-out client, before its BEGIN: 1
transaction status before BEGIN: T
notice on BEGIN: there is already a transaction in progress
rows visible to another session after the application COMMIT: 1
BUG: the rejected saveMessages was committed by an unrelated transaction
```

## Environment

- `@mastra/pg` 1.35.0, `@mastra/core` 1.81.0, `pg` 8.23.1 (`pg-pool` 3.14.0)
- Node 26.12.1, npm 12.2.1, macOS 27.2
- PostgreSQL 18.6
