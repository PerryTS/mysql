// Regression test for PerryTS/mysql#2 (bug 1): the driver must detect a
// Perry-compiled binary so it enables the deferred-write path. Perry pins
// `process.versions.node = "22.0.0"`, so detection must NOT key off
// `process.versions.node`. The Perry runtime injects its own version under
// `process.versions.perry`, which is what `isPerry()` keys off.

import { afterEach, test, expect } from 'bun:test';
import { isPerry, isNodeLike } from '../../src/transport/net-socket';

const versions = process.versions as unknown as { perry?: string };
const hadPerry = Object.prototype.hasOwnProperty.call(versions, 'perry');
const originalPerry = versions.perry;

afterEach(() => {
    if (hadPerry) {
        versions.perry = originalPerry;
    } else {
        delete versions.perry;
    }
});

test('isPerry is false under a normal Node/Bun runtime (no process.versions.perry)', () => {
    delete versions.perry;
    expect(isPerry()).toBe(false);
    expect(isNodeLike()).toBe(true);
});

test('a faked process.versions.node="22.0.0" alone does NOT look like Perry', () => {
    // This is exactly the value a Perry binary reports; on its own it must
    // not flip detection, otherwise a real Node 22.0.0 would be mistaken
    // for Perry. Only process.versions.perry decides.
    delete versions.perry;
    expect(typeof process.versions.node).toBe('string');
    expect(isPerry()).toBe(false);
});

test('isPerry is true when process.versions.perry is present', () => {
    versions.perry = '0.5.1182';
    expect(isPerry()).toBe(true);
    expect(isNodeLike()).toBe(false);
});
