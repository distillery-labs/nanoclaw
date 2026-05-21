import { beforeEach, describe, expect, test } from 'bun:test';

import { getOutboundDb, initTestSessionDb } from './connection.js';
import {
  clearContinuation,
  getContinuation,
  migrateLegacyContinuation,
  setContinuation,
  clearTaskContinuation,
  getAllTaskContinuations,
  getTaskContinuation,
  setTaskContinuation,
} from './session-state.js';

beforeEach(() => {
  initTestSessionDb();
});

function seedLegacy(value: string): void {
  getOutboundDb()
    .prepare('INSERT INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
    .run('sdk_session_id', value, new Date().toISOString());
}

describe('session-state — per-provider continuations', () => {
  test('set/get round-trip, case-insensitive provider key', () => {
    setContinuation('claude', 'claude-conv-1');
    expect(getContinuation('claude')).toBe('claude-conv-1');
    expect(getContinuation('Claude')).toBe('claude-conv-1');
    expect(getContinuation('CLAUDE')).toBe('claude-conv-1');
  });

  test('providers are isolated — switching reads the right slot', () => {
    setContinuation('claude', 'claude-conv-1');
    setContinuation('codex', 'codex-thread-xyz');

    expect(getContinuation('claude')).toBe('claude-conv-1');
    expect(getContinuation('codex')).toBe('codex-thread-xyz');
  });

  test('clearContinuation only affects the specified provider', () => {
    setContinuation('claude', 'keep-me');
    setContinuation('codex', 'drop-me');

    clearContinuation('codex');

    expect(getContinuation('claude')).toBe('keep-me');
    expect(getContinuation('codex')).toBeUndefined();
  });

  test('unknown provider returns undefined', () => {
    expect(getContinuation('never-used')).toBeUndefined();
  });
});

describe('session-state — legacy migration', () => {
  test('adopts legacy value into current provider when current is empty', () => {
    seedLegacy('old-session-id');

    const adopted = migrateLegacyContinuation('claude');

    expect(adopted).toBe('old-session-id');
    expect(getContinuation('claude')).toBe('old-session-id');
  });

  test('always deletes legacy row regardless of migration outcome', () => {
    seedLegacy('old-session-id');
    setContinuation('claude', 'existing');

    migrateLegacyContinuation('claude');

    // After migration the legacy key must be gone, whether or not it was adopted.
    // A subsequent migration for a different provider must not see it.
    const resultAfterSecondCall = migrateLegacyContinuation('codex');
    expect(resultAfterSecondCall).toBeUndefined();
  });

  test('prefers existing current-provider slot over legacy', () => {
    seedLegacy('legacy-value');
    setContinuation('claude', 'claude-value');

    const result = migrateLegacyContinuation('claude');

    expect(result).toBe('claude-value');
    expect(getContinuation('claude')).toBe('claude-value');
  });

  test('no legacy row — returns current provider value (possibly undefined)', () => {
    expect(migrateLegacyContinuation('claude')).toBeUndefined();

    setContinuation('codex', 'codex-value');
    expect(migrateLegacyContinuation('codex')).toBe('codex-value');
  });

  test('migration is idempotent on a second call (legacy already gone)', () => {
    seedLegacy('once');

    const first = migrateLegacyContinuation('claude');
    expect(first).toBe('once');

    const second = migrateLegacyContinuation('claude');
    expect(second).toBe('once');
  });
});

describe('session-state — task session continuations', () => {
  test('set/get round-trip', () => {
    setTaskContinuation('task-uuid-1', 'sdk-session-abc');
    expect(getTaskContinuation('task-uuid-1')).toBe('sdk-session-abc');
  });

  test('unknown task_id returns undefined', () => {
    expect(getTaskContinuation('never-seen')).toBeUndefined();
  });

  test('clearTaskContinuation removes only the target entry', () => {
    setTaskContinuation('task-a', 'session-a');
    setTaskContinuation('task-b', 'session-b');

    clearTaskContinuation('task-a');

    expect(getTaskContinuation('task-a')).toBeUndefined();
    expect(getTaskContinuation('task-b')).toBe('session-b');
  });

  test('getAllTaskContinuations returns empty Map on fresh DB', () => {
    expect(getAllTaskContinuations().size).toBe(0);
  });

  test('getAllTaskContinuations returns all task entries', () => {
    setTaskContinuation('task-1', 'sdk-1');
    setTaskContinuation('task-2', 'sdk-2');
    setTaskContinuation('task-3', 'sdk-3');

    const map = getAllTaskContinuations();
    expect(map.size).toBe(3);
    expect(map.get('task-1')).toBe('sdk-1');
    expect(map.get('task-2')).toBe('sdk-2');
    expect(map.get('task-3')).toBe('sdk-3');
  });

  test('getAllTaskContinuations excludes provider continuation keys', () => {
    setContinuation('claude', 'claude-session-xyz');
    setTaskContinuation('task-1', 'sdk-1');

    const map = getAllTaskContinuations();
    expect(map.size).toBe(1);
    expect(map.has('task-1')).toBe(true);
    // Provider key must not bleed into the task map
    expect([...map.keys()].some((k) => k.includes('claude'))).toBe(false);
  });

  test('task_continuation key does not collide with continuation key format', () => {
    // Verify the two namespaces never produce the same key for the same identifier
    setContinuation('task-uuid-1', 'provider-session');
    setTaskContinuation('task-uuid-1', 'task-session');

    // They're distinct keys — each returns its own value
    expect(getContinuation('task-uuid-1')).toBe('provider-session');
    expect(getTaskContinuation('task-uuid-1')).toBe('task-session');

    // getAllTaskContinuations must not include the provider slot
    const map = getAllTaskContinuations();
    expect(map.size).toBe(1);
    expect(map.get('task-uuid-1')).toBe('task-session');
  });

  test('overwrite updates the stored value', () => {
    setTaskContinuation('task-x', 'old-session');
    setTaskContinuation('task-x', 'new-session');
    expect(getTaskContinuation('task-x')).toBe('new-session');
  });
});
