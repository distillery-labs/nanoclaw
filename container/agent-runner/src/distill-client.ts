/**
 * Thin Distill API client for container-side calls.
 *
 * Uses raw fetch + PostgREST, matching the pattern in distill-tasks.ts.
 * Reads credentials from env vars forwarded by container-runner at spawn time.
 * All calls throw on failure; callers should catch and log.
 */

export interface DistillClientInterface {
  /** Returns the task's current status string, or null if not found / env unavailable. */
  getTaskStatus(taskId: string): Promise<string | null>;
  /** PATCH tasks.session_id — best-effort, call-and-forget from callers. */
  patchTaskSessionId(taskId: string, sessionId: string): Promise<void>;
}

interface DistillEnv {
  supabaseUrl: string;
  serviceKey: string;
}

// undefined = not yet resolved; null = env vars missing
let _env: DistillEnv | null | undefined;

function getEnv(): DistillEnv | null {
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

function pgHeaders(env: DistillEnv): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    apikey: env.serviceKey,
    Authorization: `Bearer ${env.serviceKey}`,
  };
}

class DistillClient implements DistillClientInterface {
  constructor(private readonly env: DistillEnv) {}

  async getTaskStatus(taskId: string): Promise<string | null> {
    const res = await fetch(
      `${this.env.supabaseUrl}/rest/v1/tasks?id=eq.${encodeURIComponent(taskId)}&select=status`,
      { headers: pgHeaders(this.env) },
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as Array<{ status?: string }>;
    return rows[0]?.status ?? null;
  }

  async patchTaskSessionId(taskId: string, sessionId: string): Promise<void> {
    const res = await fetch(
      `${this.env.supabaseUrl}/rest/v1/tasks?id=eq.${encodeURIComponent(taskId)}`,
      {
        method: 'PATCH',
        headers: pgHeaders(this.env),
        body: JSON.stringify({ session_id: sessionId }),
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Distill PATCH session_id failed ${res.status}: ${text.slice(0, 200)}`);
    }
  }
}

/**
 * Returns a DistillClient if all required env vars are present, null otherwise.
 * Null signals "Distill integration not configured" — callers should silently skip.
 */
export function createDistillClient(): DistillClientInterface | null {
  const env = getEnv();
  if (!env) return null;
  return new DistillClient(env);
}
