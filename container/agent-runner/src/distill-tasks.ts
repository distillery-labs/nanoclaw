/**
 * Distill tasks v1.5 — agent-tool hook capture.
 *
 * Writes a `tasks` row (kind='subagent') when an agent spawns a sub-agent via
 * the Task tool, create_agent, or schedule_task. Reads PostgREST creds from
 * env vars forwarded by container-runner at spawn time.
 *
 * All operations are best-effort: any failure is logged and swallowed so the
 * hook never blocks tool execution.
 *
 * Not captured: send_message, send_file, send_card, add_reaction (communication
 * primitives, not work). Bash/Read/Grep/Edit/etc. (raw tool calls, would flood
 * the table). Add them here only if a future use case warrants.
 */

import { getConfig } from './config.js';

interface DistillEnv {
  supabaseUrl: string;
  serviceKey: string;
  projectId: string;
}

// undefined = not yet resolved; null = unavailable (env vars missing)
let _env: DistillEnv | null | undefined;

function getEnv(): DistillEnv | null {
  if (_env !== undefined) return _env;
  const supabaseUrl = process.env.DISTILL_SUPABASE_URL;
  const serviceKey = process.env.DISTILL_SUPABASE_SERVICE_KEY;
  const projectId = process.env.DISTILL_PROJECT_ID;
  if (!supabaseUrl || !serviceKey || !projectId) {
    _env = null;
    return null;
  }
  _env = { supabaseUrl, serviceKey, projectId };
  return _env;
}

// tool_use_id → distill task UUID
const correlationMap = new Map<string, string>();

function pgHeaders(env: DistillEnv, returnRepresentation = false): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    apikey: env.serviceKey,
    Authorization: `Bearer ${env.serviceKey}`,
    Prefer: returnRepresentation ? 'return=representation' : 'return=minimal',
  };
}

async function lookupParentTaskId(): Promise<string | null> {
  const env = getEnv();
  if (!env) return null;
  const agentGroupId = getConfig().agentGroupId;
  if (!agentGroupId) return null;
  try {
    const res = await fetch(
      `${env.supabaseUrl}/rest/v1/agent_sessions?agent_id=eq.${encodeURIComponent(agentGroupId)}&select=current_task_stack`,
      { headers: pgHeaders(env) },
    );
    if (!res.ok) return null;
    // TODO: when stack migration is confirmed on all envs, current_task_stack
    // is the canonical field. Fall back to current_task_id for older schemas.
    const rows = (await res.json()) as Array<{ current_task_stack?: unknown[] }>;
    if (!rows.length) return null;
    const stack = rows[0].current_task_stack;
    if (!Array.isArray(stack) || stack.length === 0) return null;
    return String(stack[stack.length - 1]);
  } catch {
    return null;
  }
}

function deriveTitle(toolName: string, toolInput: unknown): string {
  const inp = toolInput as Record<string, unknown> | null | undefined;
  let text = '';
  if (toolName === 'Task') {
    text = String(inp?.prompt ?? inp?.description ?? '');
  } else if (toolName === 'mcp__nanoclaw__create_agent') {
    text = `create_agent: ${String(inp?.name ?? '')}`;
  } else if (toolName === 'mcp__nanoclaw__schedule_task') {
    text = `schedule: ${String(inp?.prompt ?? '')}`;
  }
  if (!text) text = toolName;
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

function derivePayload(toolName: string, toolInput: unknown): Record<string, unknown> {
  const inp = toolInput as Record<string, unknown> | null | undefined;
  if (toolName === 'Task') {
    return {
      prompt: String(inp?.prompt ?? ''),
      agent_type: String(inp?.subagent_type ?? 'general-purpose'),
      isolation: String(inp?.isolation ?? ''),
    };
  }
  return { tool_input: inp ?? {} };
}

export async function recordToolStart(
  toolUseId: string,
  toolName: string,
  toolInput: unknown,
): Promise<void> {
  const env = getEnv();
  if (!env) return;

  const agentGroupId = getConfig().agentGroupId;
  const parentTask = await lookupParentTaskId();

  // parent_task is required by the kind/parent invariant CHECK on `tasks`.
  // If we have no parent context (agent not in a tracked task), skip the
  // insert — recording an orphan subagent row would violate the constraint.
  if (!parentTask) return;

  const body: Record<string, unknown> = {
    project_id: env.projectId,
    title: deriveTitle(toolName, toolInput),
    kind: 'subagent',
    status: 'in_progress',
    parent_task: parentTask,
    payload: derivePayload(toolName, toolInput),
    source: agentGroupId,
    agent_lead: agentGroupId,
    // human_responsible omitted — DB default ('jesolsen') fires automatically
  };

  const res = await fetch(`${env.supabaseUrl}/rest/v1/tasks`, {
    method: 'POST',
    headers: pgHeaders(env, true),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`distill INSERT failed ${res.status}: ${text.slice(0, 200)}`);
  }

  const rows = (await res.json()) as Array<{ id?: string }>;
  const taskId = rows[0]?.id;
  if (taskId) {
    correlationMap.set(toolUseId, taskId);
  }
}

export async function recordToolEnd(
  toolUseId: string,
  toolResponse: unknown,
  status: 'completed' | 'failed' = 'completed',
): Promise<void> {
  const env = getEnv();
  if (!env) return;

  const taskId = correlationMap.get(toolUseId);
  if (!taskId) return;
  correlationMap.delete(toolUseId);

  const MAX_RESULT_BYTES = 32768;
  const serialized = JSON.stringify(toolResponse);
  const result: unknown =
    serialized.length <= MAX_RESULT_BYTES
      ? toolResponse
      : { _truncated: true, _preview: serialized.slice(0, MAX_RESULT_BYTES) };

  const res = await fetch(`${env.supabaseUrl}/rest/v1/tasks?id=eq.${encodeURIComponent(taskId)}`, {
    method: 'PATCH',
    headers: pgHeaders(env),
    body: JSON.stringify({ status, result }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`distill PATCH failed ${res.status}: ${text.slice(0, 200)}`);
  }
}
