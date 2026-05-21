/**
 * Delivery action handler for Distill task session lifecycle events.
 *
 * The container emits `kind='system', action='task_event'` messages at four
 * points in a task session's lifecycle: session_created, session_resumed,
 * session_completed, and session_aborted. The host delivery path routes them
 * here via the delivery-action registry.
 *
 * This is a stub — actual Distill API calls (updating tasks.session_id,
 * tasks.status, etc.) are wired in PR C.5 when the Supabase client is added
 * to the delivery layer.
 */
import type Database from 'better-sqlite3';

import { log } from '../../log.js';
import type { Session } from '../../types.js';

export async function handleTaskEvent(
  content: Record<string, unknown>,
  session: Session,
  _inDb: Database.Database,
): Promise<void> {
  const taskId = content.task_id as string;
  const eventType = content.event_type as string;
  log.info('Distill task event received', { sessionId: session.id, taskId, eventType });
  // TODO (PR C.5): forward to Distill API — update tasks.status and tasks.session_id
}
