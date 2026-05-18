import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration018: Migration = {
  version: 18,
  name: 'runner-backed-agents',
  up(db: Database.Database) {
    db.exec(`
      ALTER TABLE agent_groups ADD COLUMN runner_cwd TEXT;
      ALTER TABLE agent_groups ADD COLUMN remote_session_id TEXT;
    `);
  },
};
