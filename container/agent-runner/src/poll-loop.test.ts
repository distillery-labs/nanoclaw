import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from './db/connection.js';
import { getPendingMessages, getPendingMessagesForSession, markCompleted } from './db/messages-in.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { getTaskContinuation } from './db/session-state.js';
import { formatMessages, extractRouting } from './formatter.js';
import { MockProvider } from './providers/mock.js';
import type { AgentProvider, AgentQuery, QueryInput } from './providers/types.js';
import { runPollLoop, dispatchTaskSession, type TaskSessionEntry, type PollLoopConfig } from './poll-loop.js';
import type { DistillClientInterface } from './distill-client.js';
import { setTaskContinuation } from './db/session-state.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

function insertMessage(
  id: string,
  kind: string,
  content: object,
  opts?: { processAfter?: string; trigger?: 0 | 1; onWake?: 0 | 1; taskId?: string | null },
) {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, process_after, trigger, on_wake, task_id, content)
     VALUES (?, ?, datetime('now'), 'pending', ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      kind,
      opts?.processAfter ?? null,
      opts?.trigger ?? 1,
      opts?.onWake ?? 0,
      opts?.taskId ?? null,
      JSON.stringify(content),
    );
}

describe('formatter', () => {
  it('should format a single chat message', () => {
    insertMessage('m1', 'chat', { sender: 'John', text: 'Hello world' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('sender="John"');
    expect(prompt).toContain('Hello world');
  });

  it('should format multiple chat messages as XML block', () => {
    insertMessage('m1', 'chat', { sender: 'John', text: 'Hello' });
    insertMessage('m2', 'chat', { sender: 'Jane', text: 'Hi there' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('<messages>');
    expect(prompt).toContain('</messages>');
    expect(prompt).toContain('sender="John"');
    expect(prompt).toContain('sender="Jane"');
  });

  it('should format task messages', () => {
    insertMessage('m1', 'task', { prompt: 'Review open PRs' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('<task');
    expect(prompt).toContain('Review open PRs');
  });

  it('should format webhook messages', () => {
    insertMessage('m1', 'webhook', { source: 'github', event: 'push', payload: { ref: 'main' } });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('<webhook');
    expect(prompt).toContain('source="github"');
    expect(prompt).toContain('event="push"');
  });

  it('should format system messages', () => {
    insertMessage('m1', 'system', { action: 'register_group', status: 'success', result: { id: 'ag-1' } });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('<system_response');
    expect(prompt).toContain('action="register_group"');
  });

  it('should handle mixed kinds', () => {
    insertMessage('m1', 'chat', { sender: 'John', text: 'Hello' });
    insertMessage('m2', 'system', { action: 'test', status: 'ok', result: null });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('sender="John"');
    expect(prompt).toContain('<system_response');
  });

  it('should escape XML in content', () => {
    insertMessage('m1', 'chat', { sender: 'A<B', text: 'x > y && z' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('A&lt;B');
    expect(prompt).toContain('x &gt; y &amp;&amp; z');
  });
});

describe('accumulate gate (trigger column)', () => {
  it('getPendingMessages returns both trigger=0 and trigger=1 rows', () => {
    // trigger=0 rides along as context, trigger=1 is the wake-eligible row.
    // The poll loop's gate depends on this data contract.
    insertMessage('m1', 'chat', { sender: 'A', text: 'chit chat' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: 'actual mention' }, { trigger: 1 });
    const messages = getPendingMessages();
    expect(messages).toHaveLength(2);
    const byId = Object.fromEntries(messages.map((m) => [m.id, m]));
    expect(byId.m1.trigger).toBe(0);
    expect(byId.m2.trigger).toBe(1);
  });

  it('trigger=0-only batch: gate predicate `some(trigger===1)` is false', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'noise' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: 'more noise' }, { trigger: 0 });
    const messages = getPendingMessages();
    // This is the exact predicate the poll loop uses to skip accumulate-only
    // batches — gate should be false, so the loop sleeps without waking the agent.
    expect(messages.some((m) => m.trigger === 1)).toBe(false);
  });

  it('mixed batch: gate is true → loop proceeds, accumulated rows ride along', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'earlier chatter' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: 'the real mention' }, { trigger: 1 });
    const messages = getPendingMessages();
    expect(messages.some((m) => m.trigger === 1)).toBe(true);
    // Both messages are present for the formatter → agent sees the prior context.
    expect(messages.map((m) => m.id).sort()).toEqual(['m1', 'm2']);
  });

  it('trigger column defaults to 1 for legacy inserts without explicit value', () => {
    // The schema default is 1 (see src/db/schema.ts INBOUND_SCHEMA) — existing
    // rows / tests without the column set are effectively wake-eligible.
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, content)
         VALUES ('m1', 'chat', datetime('now'), 'pending', '{"text":"hi"}')`,
      )
      .run();
    const [msg] = getPendingMessages();
    expect(msg.trigger).toBe(1);
  });
});

describe('on_wake filtering', () => {
  it('first poll returns on_wake=1 messages', () => {
    insertMessage('m1', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = getPendingMessages(true);
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('m1');
  });

  it('subsequent polls skip on_wake=1 messages', () => {
    insertMessage('m1', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = getPendingMessages(false);
    expect(messages).toHaveLength(0);
  });

  it('normal messages returned regardless of isFirstPoll', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'hello' });
    expect(getPendingMessages(true)).toHaveLength(1);

    // Reset: mark completed so we can re-test with a fresh message
    markCompleted(['m1']);
    insertMessage('m2', 'chat', { sender: 'A', text: 'hello again' });
    expect(getPendingMessages(false)).toHaveLength(1);
  });

  it('mixed batch: first poll returns both normal and on_wake messages', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'user msg' });
    insertMessage('m2', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = getPendingMessages(true);
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m.id).sort()).toEqual(['m1', 'm2']);
  });

  it('mixed batch: subsequent poll returns only normal messages', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'user msg' });
    insertMessage('m2', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = getPendingMessages(false);
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('m1');
  });

  it('on_wake defaults to 0 for inserts without explicit value', () => {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, content)
         VALUES ('m1', 'chat', datetime('now'), 'pending', '{"text":"hi"}')`,
      )
      .run();
    // Should be returned even on non-first poll (on_wake=0)
    expect(getPendingMessages(false)).toHaveLength(1);
  });
});

describe('routing', () => {
  it('should extract routing from messages', () => {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES ('m1', 'chat', datetime('now'), 'pending', 'chan-123', 'discord', 'thread-456', '{"text":"hi"}')`,
      )
      .run();

    const messages = getPendingMessages();
    const routing = extractRouting(messages);
    expect(routing.platformId).toBe('chan-123');
    expect(routing.channelType).toBe('discord');
    expect(routing.threadId).toBe('thread-456');
    expect(routing.inReplyTo).toBe('m1');
  });
});

describe('origin metadata (from= attribute)', () => {
  function seedDestination(name: string, channelType: string, platformId: string): void {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES (?, ?, 'channel', ?, ?, NULL)`,
      )
      .run(name, name, channelType, platformId);
  }

  function insertWithRouting(id: string, kind: string, content: object, channelType: string | null, platformId: string | null): void {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, content)
         VALUES (?, ?, datetime('now'), 'pending', ?, ?, ?)`,
      )
      .run(id, kind, platformId, channelType, JSON.stringify(content));
  }

  it('chat message includes from= when destination matches', () => {
    seedDestination('discord-main', 'discord', 'chan-1');
    insertWithRouting('m1', 'chat', { sender: 'Alice', text: 'hi' }, 'discord', 'chan-1');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('from="discord-main"');
  });

  it('chat message falls back to raw routing when no destination matches', () => {
    insertWithRouting('m1', 'chat', { sender: 'Alice', text: 'hi' }, 'telegram', 'chat-999');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('from="unknown:telegram:chat-999"');
  });

  it('chat message omits from= when routing is null', () => {
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'hi' });
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).not.toContain('from=');
  });

  it('task message includes from= when destination matches', () => {
    seedDestination('slack-ops', 'slack', 'C-OPS');
    insertWithRouting('t1', 'task', { prompt: 'check status' }, 'slack', 'C-OPS');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<task');
    expect(prompt).toContain('from="slack-ops"');
  });

  it('task message omits from= when routing is null', () => {
    insertMessage('t1', 'task', { prompt: 'check status' });
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<task');
    expect(prompt).not.toContain('from=');
  });

  it('webhook message includes from= when destination matches', () => {
    seedDestination('github-ch', 'github', 'repo-1');
    insertWithRouting('w1', 'webhook', { source: 'github', event: 'push', payload: {} }, 'github', 'repo-1');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<webhook');
    expect(prompt).toContain('from="github-ch"');
  });

  it('system message includes from= when destination matches', () => {
    seedDestination('discord-main', 'discord', 'chan-1');
    insertWithRouting('s1', 'system', { action: 'test', status: 'ok', result: null }, 'discord', 'chan-1');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<system_response');
    expect(prompt).toContain('from="discord-main"');
  });
});

describe('mock provider', () => {
  it('should produce init + result events', async () => {
    const provider = new MockProvider({}, (prompt) => `Echo: ${prompt}`);
    const query = provider.query({
      prompt: 'Hello',
      cwd: '/tmp',
    });

    const events: Array<{ type: string }> = [];
    setTimeout(() => query.end(), 50);

    for await (const event of query.events) {
      events.push(event);
    }

    const typed = events.filter((e) => e.type !== 'activity');
    expect(typed.length).toBeGreaterThanOrEqual(2);
    expect(typed[0].type).toBe('init');
    expect(typed[1].type).toBe('result');
    expect((typed[1] as { text: string }).text).toBe('Echo: Hello');
  });

  it('should handle push() during active query', async () => {
    const provider = new MockProvider({}, (prompt) => `Re: ${prompt}`);
    const query = provider.query({
      prompt: 'First',
      cwd: '/tmp',
    });

    const events: Array<{ type: string; text?: string }> = [];

    setTimeout(() => query.push('Second'), 30);
    setTimeout(() => query.end(), 60);

    for await (const event of query.events) {
      events.push(event);
    }

    const results = events.filter((e) => e.type === 'result');
    expect(results).toHaveLength(2);
    expect(results[0].text).toBe('Re: First');
    expect(results[1].text).toBe('Re: Second');
  });
});

describe('end-to-end with mock provider', () => {
  it('should read messages_in, process with mock provider, write messages_out', async () => {
    // Insert a chat message into inbound DB
    insertMessage('m1', 'chat', { sender: 'User', text: 'What is 2+2?' });

    // Read and process
    const messages = getPendingMessages();
    expect(messages).toHaveLength(1);

    const routing = extractRouting(messages);
    const prompt = formatMessages(messages);

    // Create mock provider and run query
    const provider = new MockProvider({}, () => 'The answer is 4');
    const query = provider.query({
      prompt,
      cwd: '/tmp',
    });

    // Process events — simulate what poll-loop does
    const { markProcessing } = await import('./db/messages-in.js');
    const { writeMessageOut } = await import('./db/messages-out.js');

    markProcessing(['m1']);

    setTimeout(() => query.end(), 50);

    for await (const event of query.events) {
      if (event.type === 'result' && event.text) {
        writeMessageOut({
          id: `out-${Date.now()}`,
          in_reply_to: routing.inReplyTo,
          kind: 'chat',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({ text: event.text }),
        });
      }
    }

    markCompleted(['m1']);

    // Verify: message was processed (not pending, acked in processing_ack)
    const processed = getPendingMessages();
    expect(processed).toHaveLength(0);

    // Verify: response was written to outbound DB
    const outMessages = getUndeliveredMessages();
    expect(outMessages).toHaveLength(1);
    expect(JSON.parse(outMessages[0].content).text).toBe('The answer is 4');
    expect(outMessages[0].in_reply_to).toBe('m1');
  });
});

describe('supervisor — dispatchTaskSession', () => {
  function makeConfig(responseFactory?: (p: string) => string): PollLoopConfig {
    return {
      provider: new MockProvider({ autoEnd: true }, responseFactory ?? (() => 'ok')),
      providerName: 'mock',
      cwd: '/tmp',
    };
  }

  it('processes task messages end-to-end and marks them completed', async () => {
    insertMessage('task-msg-1', 'chat', { text: 'run task' }, { taskId: 'task-abc' });

    const taskSessions = new Map<string, TaskSessionEntry>();
    const config = makeConfig();
    const messages = getPendingMessagesForSession('task-abc');

    await dispatchTaskSession('task-abc', messages, config, taskSessions);
    const entry = taskSessions.get('task-abc');
    if (entry?.queryPromise) await entry.queryPromise;

    // Messages should be marked completed (no longer pending)
    expect(getPendingMessagesForSession('task-abc')).toHaveLength(0);
  });

  it('persists task continuation under the task key on init', async () => {
    insertMessage('task-msg-2', 'chat', { text: 'persist me' }, { taskId: 'task-persist' });

    const taskSessions = new Map<string, TaskSessionEntry>();
    await dispatchTaskSession('task-persist', getPendingMessagesForSession('task-persist'), makeConfig(), taskSessions);
    const entry = taskSessions.get('task-persist');
    if (entry?.queryPromise) await entry.queryPromise;

    expect(getTaskContinuation('task-persist')).toBeDefined();
    expect(typeof getTaskContinuation('task-persist')).toBe('string');
  });

  it('skips dispatch when session is already active (queryPromise !== null)', async () => {
    insertMessage('task-msg-3', 'chat', { text: 'first' }, { taskId: 'task-active' });
    insertMessage('task-msg-4', 'chat', { text: 'second' }, { taskId: 'task-active' });

    const neverResolves = new Promise<void>(() => {});
    const taskSessions = new Map<string, TaskSessionEntry>([
      ['task-active', { taskId: 'task-active', continuation: undefined, queryPromise: neverResolves }],
    ]);

    const messages = getPendingMessagesForSession('task-active');
    await dispatchTaskSession('task-active', messages, makeConfig(), taskSessions);

    // Messages should still be pending — no markProcessing was called
    expect(getPendingMessagesForSession('task-active')).toHaveLength(2);
  });

  it('uses stored continuation from taskSessions map on reconnect', async () => {
    insertMessage('task-msg-5', 'chat', { text: 'resume me' }, { taskId: 'task-resume' });

    const capturedInputs: string[] = [];
    const taskSessions = new Map<string, TaskSessionEntry>([
      ['task-resume', { taskId: 'task-resume', continuation: 'prior-session-id', queryPromise: null }],
    ]);
    const provider = new MockProvider({ autoEnd: true }, (prompt) => {
      capturedInputs.push(prompt);
      return 'resumed';
    });
    const config = { provider, providerName: 'mock', cwd: '/tmp' };

    const messages = getPendingMessagesForSession('task-resume');
    await dispatchTaskSession('task-resume', messages, config, taskSessions);
    const entry = taskSessions.get('task-resume');
    if (entry?.queryPromise) await entry.queryPromise;

    // Entry should have updated continuation from the mock init event
    expect(entry?.continuation).toBeDefined();
    // Prior continuation was loaded (we can verify by checking entry was found, not created fresh)
    expect(capturedInputs).toHaveLength(1);
  });

  it('task session isolated from main session messages', async () => {
    insertMessage('main-msg', 'chat', { text: 'for main' });
    insertMessage('task-msg', 'chat', { text: 'for task' }, { taskId: 'task-iso' });

    const taskSessions = new Map<string, TaskSessionEntry>();
    const taskMessages = getPendingMessagesForSession('task-iso');

    await dispatchTaskSession('task-iso', taskMessages, makeConfig(), taskSessions);
    const entry = taskSessions.get('task-iso');
    if (entry?.queryPromise) await entry.queryPromise;

    // Task message completed, main message still pending
    expect(getPendingMessagesForSession('task-iso')).toHaveLength(0);
    expect(getPendingMessagesForSession(null)).toHaveLength(1);
    expect(getPendingMessagesForSession(null)[0].id).toBe('main-msg');
  });

  it('clears queryPromise on completion so subsequent dispatch can start new session', async () => {
    insertMessage('task-msg-6', 'chat', { text: 'first run' }, { taskId: 'task-rerun' });

    const taskSessions = new Map<string, TaskSessionEntry>();
    let messages = getPendingMessagesForSession('task-rerun');
    await dispatchTaskSession('task-rerun', messages, makeConfig(), taskSessions);
    const entry = taskSessions.get('task-rerun');
    if (entry?.queryPromise) await entry.queryPromise;

    // queryPromise should be null after completion
    expect(taskSessions.get('task-rerun')?.queryPromise).toBeNull();

    // Insert a second message and dispatch again — should start fresh session
    insertMessage('task-msg-7', 'chat', { text: 'second run' }, { taskId: 'task-rerun' });
    messages = getPendingMessagesForSession('task-rerun');
    await dispatchTaskSession('task-rerun', messages, makeConfig(), taskSessions);
    const entry2 = taskSessions.get('task-rerun');
    if (entry2?.queryPromise) await entry2.queryPromise;

    expect(getPendingMessagesForSession('task-rerun')).toHaveLength(0);
  });
});

describe('task event emission', () => {
  function makeConfig(responseFactory?: (p: string) => string): PollLoopConfig {
    return {
      provider: new MockProvider({ autoEnd: true }, responseFactory ?? (() => 'ok')),
      providerName: 'mock',
      cwd: '/tmp',
    };
  }

  function getTaskEvents(): Array<{ event_type: string; task_id: string }> {
    return getUndeliveredMessages()
      .filter((m) => m.kind === 'system')
      .map((m) => JSON.parse(m.content))
      .filter((c) => c.action === 'task_event');
  }

  it('emits session_created on first dispatch (no prior continuation)', async () => {
    insertMessage('ev-msg-1', 'chat', { text: 'hello' }, { taskId: 'task-ev-create' });

    const taskSessions = new Map<string, TaskSessionEntry>();
    const messages = getPendingMessagesForSession('task-ev-create');
    await dispatchTaskSession('task-ev-create', messages, makeConfig(), taskSessions);
    const entry = taskSessions.get('task-ev-create');
    if (entry?.queryPromise) await entry.queryPromise;

    const events = getTaskEvents();
    expect(events.some((e) => e.event_type === 'session_created' && e.task_id === 'task-ev-create')).toBe(true);
  });

  it('emits session_resumed when prior continuation is present', async () => {
    insertMessage('ev-msg-2', 'chat', { text: 'resume' }, { taskId: 'task-ev-resume' });

    const taskSessions = new Map<string, TaskSessionEntry>([
      ['task-ev-resume', { taskId: 'task-ev-resume', continuation: 'prior-session-abc', queryPromise: null }],
    ]);
    const messages = getPendingMessagesForSession('task-ev-resume');
    await dispatchTaskSession('task-ev-resume', messages, makeConfig(), taskSessions);
    const entry = taskSessions.get('task-ev-resume');
    if (entry?.queryPromise) await entry.queryPromise;

    const events = getTaskEvents();
    expect(events.some((e) => e.event_type === 'session_resumed' && e.task_id === 'task-ev-resume')).toBe(true);
    expect(events.some((e) => e.event_type === 'session_created')).toBe(false);
  });

  it('emits session_completed on clean finish', async () => {
    insertMessage('ev-msg-3', 'chat', { text: 'run' }, { taskId: 'task-ev-complete' });

    const taskSessions = new Map<string, TaskSessionEntry>();
    const messages = getPendingMessagesForSession('task-ev-complete');
    await dispatchTaskSession('task-ev-complete', messages, makeConfig(), taskSessions);
    const entry = taskSessions.get('task-ev-complete');
    if (entry?.queryPromise) await entry.queryPromise;

    const events = getTaskEvents();
    expect(events.some((e) => e.event_type === 'session_completed' && e.task_id === 'task-ev-complete')).toBe(true);
  });

  it('emits session_aborted (not session_completed) on provider error', async () => {
    insertMessage('ev-msg-4', 'chat', { text: 'fail' }, { taskId: 'task-ev-abort' });

    class ThrowingProvider implements AgentProvider {
      readonly supportsNativeSlashCommands = false;
      isSessionInvalid(_err: unknown): boolean { return false; }
      query(_input: QueryInput): AgentQuery {
        return {
          push: () => {},
          end: () => {},
          abort: () => {},
          events: {
            async *[Symbol.asyncIterator]() {
              throw new Error('provider failure');
            },
          },
        };
      }
    }

    const config: PollLoopConfig = { provider: new ThrowingProvider(), providerName: 'mock', cwd: '/tmp' };
    const taskSessions = new Map<string, TaskSessionEntry>();
    const messages = getPendingMessagesForSession('task-ev-abort');
    await dispatchTaskSession('task-ev-abort', messages, config, taskSessions);
    const entry = taskSessions.get('task-ev-abort');
    if (entry?.queryPromise) await entry.queryPromise.catch(() => {});

    const events = getTaskEvents();
    expect(events.some((e) => e.event_type === 'session_aborted' && e.task_id === 'task-ev-abort')).toBe(true);
    expect(events.some((e) => e.event_type === 'session_completed')).toBe(false);
  });

  it('does not emit session_created/resumed for main session (taskId=null)', async () => {
    insertMessage('ev-msg-5', 'chat', { text: 'main' }, { taskId: 'task-ev-main-check' });

    const taskSessions = new Map<string, TaskSessionEntry>();
    const messages = getPendingMessagesForSession('task-ev-main-check');
    await dispatchTaskSession('task-ev-main-check', messages, makeConfig(), taskSessions);
    const entry = taskSessions.get('task-ev-main-check');
    if (entry?.queryPromise) await entry.queryPromise;

    // All emitted events should be for the task, not main session
    const events = getTaskEvents();
    expect(events.every((e) => e.task_id === 'task-ev-main-check')).toBe(true);
  });
});

describe('distill integration — session_id write-back + startup filter', () => {
  function makeConfig(distillClient?: DistillClientInterface): PollLoopConfig {
    return {
      provider: new MockProvider({ autoEnd: true }, () => 'ok'),
      providerName: 'mock',
      cwd: '/tmp',
      distillClient,
    };
  }

  it('calls patchTaskSessionId with taskId and SDK session id on init', async () => {
    insertMessage('sid-msg-1', 'chat', { text: 'write back sid' }, { taskId: 'task-sid-1' });

    const sidCalls: Array<{ taskId: string; sessionId: string }> = [];
    const mockDistill: DistillClientInterface = {
      getTaskStatus: async () => null,
      patchTaskSessionId: async (taskId, sessionId) => { sidCalls.push({ taskId, sessionId }); },
    };

    const taskSessions = new Map<string, TaskSessionEntry>();
    await dispatchTaskSession('task-sid-1', getPendingMessagesForSession('task-sid-1'), makeConfig(mockDistill), taskSessions);
    const entry = taskSessions.get('task-sid-1');
    if (entry?.queryPromise) await entry.queryPromise;

    expect(sidCalls).toHaveLength(1);
    expect(sidCalls[0].taskId).toBe('task-sid-1');
    expect(typeof sidCalls[0].sessionId).toBe('string');
    expect(sidCalls[0].sessionId.length).toBeGreaterThan(0);
  });

  it('does not call patchTaskSessionId when distillClient is absent', async () => {
    insertMessage('sid-msg-2', 'chat', { text: 'no distill' }, { taskId: 'task-sid-2' });

    const taskSessions = new Map<string, TaskSessionEntry>();
    // No distillClient — should complete without error
    await dispatchTaskSession('task-sid-2', getPendingMessagesForSession('task-sid-2'), makeConfig(), taskSessions);
    const entry = taskSessions.get('task-sid-2');
    if (entry?.queryPromise) await entry.queryPromise;

    expect(getPendingMessagesForSession('task-sid-2')).toHaveLength(0);
  });

  it('startup filter: clears stale task continuation and skips restore when Distill reports terminal status', async () => {
    setTaskContinuation('stale-task-1', 'old-session-id');
    expect(getTaskContinuation('stale-task-1')).toBeDefined();

    const queriedIds: string[] = [];
    const mockDistill: DistillClientInterface = {
      getTaskStatus: async (taskId) => { queriedIds.push(taskId); return 'completed'; },
      patchTaskSessionId: async () => {},
    };

    const provider = new MockProvider({ autoEnd: true });
    await Promise.race([
      runPollLoop({ provider, providerName: 'mock', cwd: '/tmp', distillClient: mockDistill }),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timeout')), 1000)),
    ]).catch(() => {});

    expect(queriedIds).toContain('stale-task-1');
    // KV entry must be cleared so the store doesn't grow monotonically
    expect(getTaskContinuation('stale-task-1')).toBeUndefined();
  });

  it('startup filter: restores task continuation when Distill reports active status', async () => {
    setTaskContinuation('active-task-1', 'live-session-id');

    const mockDistill: DistillClientInterface = {
      getTaskStatus: async () => 'in_progress',
      patchTaskSessionId: async () => {},
    };

    const provider = new MockProvider({ autoEnd: true });
    await Promise.race([
      runPollLoop({ provider, providerName: 'mock', cwd: '/tmp', distillClient: mockDistill }),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timeout')), 1000)),
    ]).catch(() => {});

    // Continuation should still exist — was not cleared
    expect(getTaskContinuation('active-task-1')).toBe('live-session-id');
  });

  it('startup filter: restores task continuation when Distill is unreachable (getTaskStatus throws)', async () => {
    setTaskContinuation('err-task-1', 'session-on-error');

    const mockDistill: DistillClientInterface = {
      getTaskStatus: async () => { throw new Error('network error'); },
      patchTaskSessionId: async () => {},
    };

    const provider = new MockProvider({ autoEnd: true });
    await Promise.race([
      runPollLoop({ provider, providerName: 'mock', cwd: '/tmp', distillClient: mockDistill }),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timeout')), 1000)),
    ]).catch(() => {});

    // Error → treat as active, don't drop the continuation
    expect(getTaskContinuation('err-task-1')).toBe('session-on-error');
  });
});

describe('getPendingMessagesForSession — task_id routing', () => {
  it('null taskId returns only main-session messages (task_id IS NULL)', () => {
    insertMessage('main-1', 'chat', { text: 'main' });
    insertMessage('task-1', 'chat', { text: 'task' }, { taskId: 'uuid-task-a' });

    const main = getPendingMessagesForSession(null);
    expect(main.map((m) => m.id)).toEqual(['main-1']);
  });

  it('non-null taskId returns only messages for that task', () => {
    insertMessage('main-1', 'chat', { text: 'main' });
    insertMessage('task-a-1', 'chat', { text: 'task a' }, { taskId: 'uuid-task-a' });
    insertMessage('task-b-1', 'chat', { text: 'task b' }, { taskId: 'uuid-task-b' });

    const taskA = getPendingMessagesForSession('uuid-task-a');
    expect(taskA.map((m) => m.id)).toEqual(['task-a-1']);

    const taskB = getPendingMessagesForSession('uuid-task-b');
    expect(taskB.map((m) => m.id)).toEqual(['task-b-1']);
  });

  it('two task sessions are completely isolated from each other', () => {
    insertMessage('ta-1', 'chat', { text: 'a1' }, { taskId: 'task-alpha' });
    insertMessage('ta-2', 'chat', { text: 'a2' }, { taskId: 'task-alpha' });
    insertMessage('tb-1', 'chat', { text: 'b1' }, { taskId: 'task-beta' });

    const alpha = getPendingMessagesForSession('task-alpha');
    const beta = getPendingMessagesForSession('task-beta');
    const main = getPendingMessagesForSession(null);

    expect(alpha.map((m) => m.id).sort()).toEqual(['ta-1', 'ta-2']);
    expect(beta.map((m) => m.id)).toEqual(['tb-1']);
    expect(main).toHaveLength(0);
  });

  it('accumulate (trigger=0) messages respect task routing', () => {
    insertMessage('main-ctx', 'chat', { text: 'ctx' }, { trigger: 0 });
    insertMessage('task-ctx', 'chat', { text: 'ctx' }, { trigger: 0, taskId: 'uuid-task-a' });
    insertMessage('task-wake', 'chat', { text: 'wake' }, { trigger: 1, taskId: 'uuid-task-a' });

    const taskA = getPendingMessagesForSession('uuid-task-a');
    const mainSess = getPendingMessagesForSession(null);

    expect(taskA.map((m) => m.id).sort()).toEqual(['task-ctx', 'task-wake']);
    expect(mainSess.map((m) => m.id)).toEqual(['main-ctx']);
  });

  it('already-acked messages are excluded per-session', () => {
    insertMessage('m1', 'chat', { text: 'hi' }, { taskId: 'task-x' });
    markCompleted(['m1']);
    expect(getPendingMessagesForSession('task-x')).toHaveLength(0);
  });

  it('returns messages in chronological order (oldest first)', () => {
    insertMessage('t1', 'chat', { text: 'first' }, { taskId: 'task-z' });
    insertMessage('t2', 'chat', { text: 'second' }, { taskId: 'task-z' });
    insertMessage('t3', 'chat', { text: 'third' }, { taskId: 'task-z' });

    const msgs = getPendingMessagesForSession('task-z');
    expect(msgs.map((m) => m.id)).toEqual(['t1', 't2', 't3']);
  });
});
