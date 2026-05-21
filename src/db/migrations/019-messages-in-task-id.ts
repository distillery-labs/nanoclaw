import type { Migration } from './index.js';

export const migration019: Migration = {
  version: 19,
  name: 'messages-in-task-id',
  // No-op: messages_in lives in per-session inbound.db, not in central v2.db.
  // task_id is added to existing sessions by migrateMessagesInTable() in session-db.ts,
  // and is present in INBOUND_SCHEMA for new sessions.
  up() {},
};
