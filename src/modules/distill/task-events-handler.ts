/**
 * Delivery action handler for Distill task session lifecycle events.
 *
 * The container emits `kind='system', action='task_event'` messages at four
 * points in a task session's lifecycle: session_created, session_resumed,
 * session_completed, and session_aborted. The host delivery path routes them
 * here via the delivery-action registry.
 *
 * Primary write: POST to `task_events` table (all event types).
 * Secondary write: PATCH `tasks.status` for terminal events (completed/aborted).
 *
 * session_id write-back is handled container-side (distill-client.ts patchTaskSessionId),
 * not here — the container writes it immediately on the `init` event.
 */
import type Database from 'better-sqlite3';

import { log } from '../../log.js';
import type { Session } from '../../types.js';

interface DistillEnv {
  supabaseUrl: string;
  serviceKey: string;
}

// undefined = not yet resolved; null = env vars missing
let _env: DistillEnv | null | undefined;

function getDistillEnv(): DistillEnv | null {
  if (_env !== undefined) return _env;
  const supabaseUrl = process.env.DISTILL_SUPABASE_URL;
  const serviceKey = process.env.DISTILL_SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !serviceKey) {
    _env = null;
    return null;
  }
  _env = { supabaseUrl, serviceKey };
  return _env;
}

function pgHeaders(env: DistillEnv, returnRepresentation = false): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    apikey: env.serviceKey,
    Authorization: `Bearer ${env.serviceKey}`,
    Prefer: returnRepresentation ? 'return=representation' : 'return=minimal',
  };
}

async function insertTaskEvent(env: DistillEnv, taskId: string, eventType: string, sessionId: string): Promise<void> {
  const res = await fetch(`${env.supabaseUrl}/rest/v1/task_events`, {
    method: 'POST',
    headers: pgHeaders(env),
    body: JSON.stringify({ task_id: taskId, event_type: eventType, agent_session_id: sessionId }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Distill task_events INSERT failed ${res.status}: ${text.slice(0, 200)}`);
  }
}

async function patchTaskStatus(env: DistillEnv, taskId: string, status: string): Promise<void> {
  const res = await fetch(`${env.supabaseUrl}/rest/v1/tasks?id=eq.${encodeURIComponent(taskId)}`, {
    method: 'PATCH',
    headers: pgHeaders(env),
    body: JSON.stringify({ status }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Distill tasks PATCH status failed ${res.status}: ${text.slice(0, 200)}`);
  }
}

export async function handleTaskEvent(
  content: Record<string, unknown>,
  session: Session,
  _inDb: Database.Database,
): Promise<void> {
  const taskId = content.task_id as string;
  const eventType = content.event_type as string;

  log.info('Distill task event received', { sessionId: session.id, taskId, eventType });

  const env = getDistillEnv();
  if (!env) return;

  // Primary write: record in task_events for all event types.
  await insertTaskEvent(env, taskId, eventType, session.id).catch((err) => {
    log.warn('Failed to insert task_event', { taskId, eventType, err });
  });

  // Secondary write: update tasks.status for terminal events.
  if (eventType === 'session_completed') {
    await patchTaskStatus(env, taskId, 'completed').catch((err) => {
      log.warn('Failed to patch task status to completed', { taskId, err });
    });
  } else if (eventType === 'session_aborted') {
    await patchTaskStatus(env, taskId, 'failed').catch((err) => {
      log.warn('Failed to patch task status to failed', { taskId, err });
    });
  }
}
