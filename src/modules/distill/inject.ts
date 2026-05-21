/**
 * Distill a2a inject endpoint — POST /v1/a2a/inject.
 *
 * Lets the co-located Distill daemon push a structured event into any
 * NanoClaw agent group's session and wake the container, without going
 * through the channel routing stack. Used for Phase 2 owner-wake-on-accept
 * (P1) and Skippy-wake-on-detect (P4/P5).
 *
 * Auth: `Authorization: Bearer <NANOCLAW_INJECT_SECRET>` (shared secret
 * in .env). Set at startup; a missing secret causes all requests to 401
 * with a descriptive body rather than silently succeed.
 *
 * Body: `{ agentGroupId: string, content: unknown, taskId?: string | null }`
 *   - agentGroupId: target agent group to wake
 *   - content: arbitrary JSON payload; the agent sees it as a chat message
 *   - taskId: if set, routes to that task session instead of the main session
 */
import crypto from 'crypto';

import { wakeContainer } from '../../container-runner.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { insertMessage } from '../../db/session-db.js';
import { findSessionByAgentGroup } from '../../db/sessions.js';
import { log } from '../../log.js';
import { openInboundDb } from '../../session-manager.js';
import { registerA2aInjectRoute } from '../../webhook-server.js';

export function setupInjectEndpoint(): void {
  const secret = process.env.NANOCLAW_INJECT_SECRET;
  if (secret) {
    log.info('Distill a2a inject endpoint active', { path: '/v1/a2a/inject' });
  } else {
    log.warn('NANOCLAW_INJECT_SECRET not set — /v1/a2a/inject will reject all requests with 401');
  }

  registerA2aInjectRoute(async (rawBody, headers) => {
    const auth = headers['authorization'] ?? '';
    if (!secret || auth !== `Bearer ${secret}`) {
      log.warn('Distill a2a inject: unauthorized request');
      return { status: 401, body: 'Unauthorized — set NANOCLAW_INJECT_SECRET in .env' };
    }

    let body: { agentGroupId?: unknown; content?: unknown; taskId?: unknown };
    try {
      body = JSON.parse(rawBody.toString()) as typeof body;
    } catch {
      return { status: 400, body: 'Invalid JSON' };
    }

    const { agentGroupId, content, taskId } = body;
    if (typeof agentGroupId !== 'string' || !agentGroupId || content === undefined) {
      return { status: 400, body: 'Missing required fields: agentGroupId, content' };
    }

    const agentGroup = getAgentGroup(agentGroupId);
    if (!agentGroup) {
      return { status: 404, body: `Agent group not found: ${agentGroupId}` };
    }

    const session = findSessionByAgentGroup(agentGroupId);
    if (!session) {
      return { status: 404, body: `No active session for agent group: ${agentGroupId}` };
    }

    const resolvedTaskId = typeof taskId === 'string' ? taskId : null;
    const db = openInboundDb(agentGroup.id, session.id);
    try {
      insertMessage(db, {
        id: `distill-inject-${crypto.randomUUID()}`,
        kind: 'chat',
        timestamp: new Date().toISOString(),
        channelType: 'agent',
        platformId: 'distill',
        threadId: null,
        content: JSON.stringify(content),
        processAfter: null,
        recurrence: null,
        trigger: 1,
        taskId: resolvedTaskId,
      });
    } finally {
      db.close();
    }

    wakeContainer(session).catch((err) => {
      log.warn('Distill a2a inject: wakeContainer failed', { sessionId: session.id, err });
    });

    log.info('Distill a2a inject: message queued', {
      agentGroupId,
      sessionId: session.id,
      taskId: resolvedTaskId,
    });
    return { status: 200, body: 'OK' };
  });
}
