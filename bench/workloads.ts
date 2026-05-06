// Shared benchmark workloads — identical set for every driver under
// comparison. Mirrors the shape of `@perryts/postgres/bench/workloads.ts`.

export interface Workload {
    name: string;
    description: string;
    sql: string;
    params: unknown[];
    expectedRows: number;
}

export const WORKLOADS: Workload[] = [
    {
        name: 'tiny',
        description: 'SELECT 1 — smallest possible resultset, text protocol',
        sql: 'SELECT 1',
        params: [],
        expectedRows: 1,
    },
    {
        name: 'param-1row',
        description: 'Parameterised SELECT ?, 1 row — prepared protocol',
        sql: 'SELECT ? AS v',
        params: [42],
        expectedRows: 1,
    },
    {
        name: 'medium-1k-x-20',
        description: '1000 rows × 20 columns projection',
        sql: 'SELECT * FROM bench_1k LIMIT 1000',
        params: [],
        expectedRows: 1000,
    },
    {
        name: 'large-10k-x-20',
        description: '10 000 rows × 20 columns projection',
        sql: 'SELECT * FROM bench_10k LIMIT 10000',
        params: [],
        expectedRows: 10000,
    },
];
