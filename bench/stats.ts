// Shared stats / formatting helpers.

export interface Stats {
    n: number;
    minMs: number;
    medianMs: number;
    meanMs: number;
    p95Ms: number;
    maxMs: number;
}

export function computeStats(samplesMs: number[]): Stats {
    const sorted = samplesMs.slice().sort((a, b) => a - b);
    const n = sorted.length;
    let sum = 0;
    for (let i = 0; i < n; i++) { sum += sorted[i]; }
    const median = n % 2 === 0 ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2 : sorted[(n - 1) / 2];
    const p95 = sorted[Math.min(n - 1, Math.floor(n * 0.95))];
    return {
        n: n,
        minMs: sorted[0],
        medianMs: median,
        meanMs: sum / n,
        p95Ms: p95,
        maxMs: sorted[n - 1],
    };
}

export function printRow(label: string, stats: Stats): void {
    // eslint-disable-next-line no-console
    console.log(
        label.padEnd(40) +
        ' min=' + stats.minMs.toFixed(2).padStart(7) +
        ' median=' + stats.medianMs.toFixed(2).padStart(7) +
        ' mean=' + stats.meanMs.toFixed(2).padStart(7) +
        ' p95=' + stats.p95Ms.toFixed(2).padStart(7) +
        ' max=' + stats.maxMs.toFixed(2).padStart(7)
    );
}
