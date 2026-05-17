import type { Migration } from './types.js';

export const migration018: Migration = {
  version: 18,
  name: 'runner-backed-agents',
  up(db) {
    db.exec(`
      ALTER TABLE agent_groups ADD COLUMN runner_cwd TEXT;
      ALTER TABLE agent_groups ADD COLUMN remote_session_id TEXT;
    `);
  },
};
