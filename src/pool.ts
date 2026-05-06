// Simple connection pool. Mirrors `@perryts/postgres`'s pg.Pool.
//
// Up to `max` connections are kept open. Connections idle longer than
// `idleTimeoutMs` are closed. `.acquire()` waits up to `acquireTimeoutMs`
// when the pool is full.

import { Connection, connect, type ConnectOptions, type QueryResult } from './connection';
import { resolveConnectOptions, type ResolveOptionsInput } from './env';
import { isSqlQuery, type SqlQuery } from './sql';

export interface PoolOptions extends ResolveOptionsInput {
    /** Max open connections. Default 10. */
    max?: number;
    /** Milliseconds a connection may sit idle before the pool closes it. Default 30000. */
    idleTimeoutMs?: number;
    /** Milliseconds an `.acquire()` will wait when the pool is full. Default 30000. */
    acquireTimeoutMs?: number;
}

interface IdleEntry {
    conn: Connection;
    idleSince: number;
    idleTimer: ReturnType<typeof setTimeout> | null;
}

interface Waiter {
    resolve: (conn: Connection) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

export class Pool {
    private readonly opts: ConnectOptions;
    private readonly max: number;
    private readonly idleTimeoutMs: number;
    private readonly acquireTimeoutMs: number;

    private open = 0;
    private idle: IdleEntry[] = [];
    private waiting: Waiter[] = [];
    private closed = false;

    constructor(options: PoolOptions) {
        this.opts = resolveConnectOptions(options);
        this.max = options.max !== undefined ? options.max : 10;
        this.idleTimeoutMs = options.idleTimeoutMs !== undefined ? options.idleTimeoutMs : 30_000;
        this.acquireTimeoutMs = options.acquireTimeoutMs !== undefined ? options.acquireTimeoutMs : 30_000;
    }

    /** Acquire, run a query, release. The common case. */
    async query<T = Record<string, unknown>>(
        sql: string | SqlQuery,
        params?: unknown[],
    ): Promise<QueryResult<T>> {
        const conn = await this.acquire();
        try {
            const text = typeof sql === 'string' ? sql : sql.text;
            const effectiveParams = params !== undefined ? params : (isSqlQuery(sql) ? sql.params : undefined);
            return await conn.query<T>(text, effectiveParams);
        } finally {
            this.release(conn);
        }
    }

    /** Run `cb` with a pooled connection that will be released afterwards. */
    async withConnection<T>(cb: (conn: Connection) => Promise<T>): Promise<T> {
        const conn = await this.acquire();
        try {
            return await cb(conn);
        } finally {
            this.release(conn);
        }
    }

    /** Acquire, run `cb` inside a transaction, release. */
    async transaction<T>(cb: (conn: Connection) => Promise<T>): Promise<T> {
        const conn = await this.acquire();
        try {
            return await conn.transaction(cb);
        } finally {
            this.release(conn);
        }
    }

    async acquire(): Promise<Connection> {
        if (this.closed) {
            throw new Error('Pool: closed');
        }
        const entry = this.idle.shift();
        if (entry !== undefined) {
            if (entry.idleTimer !== null) {
                clearTimeout(entry.idleTimer);
            }
            return entry.conn;
        }
        if (this.open < this.max) {
            this.open += 1;
            try {
                return await connect(this.opts);
            } catch (e) {
                this.open -= 1;
                throw e;
            }
        }
        return new Promise<Connection>((resolve, reject) => {
            const timer = setTimeout(() => {
                for (let i = 0; i < this.waiting.length; i++) {
                    if (this.waiting[i].timer === timer) {
                        this.waiting.splice(i, 1);
                        break;
                    }
                }
                reject(new Error('Pool.acquire timed out after ' + this.acquireTimeoutMs + 'ms'));
            }, this.acquireTimeoutMs);
            this.waiting.push({ resolve: resolve, reject: reject, timer: timer });
        });
    }

    release(conn: Connection): void {
        if (this.closed) {
            conn.close().catch(() => {});
            this.open -= 1;
            return;
        }
        const waiter = this.waiting.shift();
        if (waiter !== undefined) {
            clearTimeout(waiter.timer);
            waiter.resolve(conn);
            return;
        }
        const entry: IdleEntry = {
            conn: conn,
            idleSince: Date.now(),
            idleTimer: null,
        };
        if (this.idleTimeoutMs > 0) {
            entry.idleTimer = setTimeout(() => this.reapIdle(entry), this.idleTimeoutMs);
        }
        this.idle.push(entry);
    }

    private reapIdle(entry: IdleEntry): void {
        const idx = this.idle.indexOf(entry);
        if (idx < 0) {
            return;
        }
        this.idle.splice(idx, 1);
        entry.conn.close().catch(() => {});
        this.open -= 1;
    }

    async end(): Promise<void> {
        this.closed = true;
        for (let i = 0; i < this.waiting.length; i++) {
            const w = this.waiting[i];
            clearTimeout(w.timer);
            w.reject(new Error('Pool: ended'));
        }
        this.waiting = [];
        const toClose = this.idle.slice();
        this.idle = [];
        const promises: Promise<void>[] = [];
        for (let i = 0; i < toClose.length; i++) {
            const entry = toClose[i];
            if (entry.idleTimer !== null) {
                clearTimeout(entry.idleTimer);
            }
            this.open -= 1;
            promises.push(entry.conn.close().catch(() => {}));
        }
        await Promise.all(promises);
    }

    /** Pool stats. Useful for metrics / health checks. */
    size(): { total: number; idle: number; waiting: number } {
        return { total: this.open, idle: this.idle.length, waiting: this.waiting.length };
    }
}

export function createPool(options: PoolOptions): Pool {
    return new Pool(options);
}
