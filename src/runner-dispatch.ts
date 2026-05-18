import crypto from 'crypto';

import { updateRunnerRemoteSessionId } from './db/agent-groups.js';
import { getDb } from './db/connection.js';
import { log } from './log.js';
import { sendClaudeInvoke } from './runner-registry.js';
import { writeOutboundDirect } from './session-manager.js';
import type { AgentGroup, Session } from './types.js';

export interface RunnerDeliveryAddr {
  channelType: string;
  platformId: string;
  threadId: string | null;
}

/**
 * In-flight guard: prevents the 60-second sweep from re-dispatching a
 * CLAUDE_INVOKE for a session that already has one outstanding. Cleared when
 * the invoke settles (success, timeout, or runner error).
 */
const inFlightSessions = new Set<string>();

/**
 * Shared dispatch helper used by both the immediate router path and the
 * host-sweep retry path. Sends a CLAUDE_INVOKE to the runner, waits up to
 * 30 minutes, then writes the reply (or timeout error) to outbound.
 *
 * Fire-and-forget from the caller's perspective — wrap in void + catch.
 */
export async function dispatchRunnerBackedInvoke(
  agentGroup: AgentGroup,
  session: Session,
  prompt: string,
  deliveryAddr: RunnerDeliveryAddr,
): Promise<void> {
  if (inFlightSessions.has(session.id)) {
    log.debug('Runner-backed invoke already in flight, skipping', {
      sessionId: session.id,
      agentGroupId: agentGroup.id,
    });
    return;
  }
  inFlightSessions.add(session.id);
  const correlationId = crypto.randomUUID();
  try {
    const result = await sendClaudeInvoke(agentGroup.runner_id!, {
      correlation_id: correlationId,
      cwd: agentGroup.runner_cwd!,
      prompt,
      resume_session_id: agentGroup.remote_session_id ?? undefined,
    });
    if (result.session_id) {
      updateRunnerRemoteSessionId(getDb(), agentGroup.id, result.session_id);
    }
    writeOutboundDirect(agentGroup.id, session.id, {
      id: `runner-reply-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat',
      platformId: deliveryAddr.platformId,
      channelType: deliveryAddr.channelType,
      threadId: deliveryAddr.threadId,
      content: JSON.stringify({ text: result.stdout || result.error || '' }),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const isTimeout = msg.includes('timeout after 30 minutes');
    const errorText = isTimeout
      ? '[claude turn exceeded 30-minute cap; check claude --print progress on the runner host directly]'
      : `[runner invoke failed: ${msg}]`;
    // On timeout: do NOT clear remote_session_id — runner may still complete, enabling resume.
    writeOutboundDirect(agentGroup.id, session.id, {
      id: `runner-reply-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat',
      platformId: deliveryAddr.platformId,
      channelType: deliveryAddr.channelType,
      threadId: deliveryAddr.threadId,
      content: JSON.stringify({ text: errorText }),
    });
  } finally {
    inFlightSessions.delete(session.id);
  }
}
