/**
 * Persistent key/value state for the container. Lives in outbound.db
 * (container-owned, already scoped per channel/thread).
 *
 * Primary use: remember each provider's opaque continuation id so the
 * agent's conversation resumes across container restarts. Keyed per
 * provider because continuations are provider-private — a Claude
 * conversation id means nothing to Codex and vice versa. Switching
 * providers is therefore lossless: each provider's last thread stays
 * on file and resumes cleanly if the user flips back.
 */
import { getOutboundDb } from './connection.js';

const LEGACY_KEY = 'sdk_session_id';

function continuationKey(providerName: string): string {
  return `continuation:${providerName.toLowerCase()}`;
}

function getValue(key: string): string | undefined {
  const row = getOutboundDb()
    .prepare('SELECT value FROM session_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

function setValue(key: string, value: string): void {
  getOutboundDb()
    .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
    .run(key, value, new Date().toISOString());
}

function deleteValue(key: string): void {
  getOutboundDb().prepare('DELETE FROM session_state WHERE key = ?').run(key);
}

/**
 * One-time migration of the pre-per-provider continuation row.
 *
 * Before this was keyed per provider, continuations lived under the
 * single key `sdk_session_id`. On container start, if that legacy row
 * exists and the current provider has no continuation of its own, adopt
 * the legacy value into the current provider's slot (best-guess — the
 * legacy row was written by whatever provider ran last). The legacy row
 * is always deleted so future provider flips never re-read a stale id
 * through the wrong lens.
 *
 * Returns the continuation the caller should use at startup (either the
 * current provider's existing value, the adopted legacy value, or
 * undefined).
 */
export function migrateLegacyContinuation(providerName: string): string | undefined {
  const legacy = getValue(LEGACY_KEY);
  const currentKey = continuationKey(providerName);
  const current = getValue(currentKey);

  if (legacy === undefined) return current;

  // Always drop the legacy row so no future provider reads it.
  deleteValue(LEGACY_KEY);

  // Prefer the current provider's own slot if one already exists.
  if (current !== undefined) return current;

  setValue(currentKey, legacy);
  return legacy;
}

export function getContinuation(providerName: string): string | undefined {
  return getValue(continuationKey(providerName));
}

export function setContinuation(providerName: string, id: string): void {
  setValue(continuationKey(providerName), id);
}

export function clearContinuation(providerName: string): void {
  deleteValue(continuationKey(providerName));
}

// ── Task session continuations ──
// Maps a Distill task_id to its SDK session_id so task sessions survive
// container restarts. Keyed separately from provider continuations so the two
// namespaces never collide and getAllTaskContinuations() can bulk-load on startup.

const TASK_CONTINUATION_PREFIX = 'task_continuation:';

function taskContinuationKey(taskId: string): string {
  return `${TASK_CONTINUATION_PREFIX}${taskId}`;
}

export function getTaskContinuation(taskId: string): string | undefined {
  return getValue(taskContinuationKey(taskId));
}

export function setTaskContinuation(taskId: string, sessionId: string): void {
  setValue(taskContinuationKey(taskId), sessionId);
}

export function clearTaskContinuation(taskId: string): void {
  deleteValue(taskContinuationKey(taskId));
}

/**
 * Load all persisted task_id → session_id entries at container startup.
 * Used by the supervisor to resume any task sessions that were active when
 * the container last exited.
 */
export function getAllTaskContinuations(): Map<string, string> {
  const rows = getOutboundDb()
    .prepare('SELECT key, value FROM session_state WHERE key LIKE ?')
    .all(`${TASK_CONTINUATION_PREFIX}%`) as Array<{ key: string; value: string }>;
  const result = new Map<string, string>();
  for (const row of rows) {
    result.set(row.key.slice(TASK_CONTINUATION_PREFIX.length), row.value);
  }
  return result;
}
