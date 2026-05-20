import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration019: Migration = {
  version: 19,
  name: 'messages-in-task-id',
  up(db: Database.Database) {
    // Sub-Skippy multiplex: task sessions share a group's messages_in.
    // task_id IS NULL = main session; task_id = UUID = named Distill task session.
    db.prepare('ALTER TABLE messages_in ADD COLUMN task_id TEXT').run();
  },
};
