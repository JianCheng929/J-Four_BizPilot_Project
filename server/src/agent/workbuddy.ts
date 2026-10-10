import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query } from '@tencent-ai/agent-sdk';
import type { AuthEnvironment } from '@tencent-ai/agent-sdk';

/**
 * BizPilot's built-in WorkBuddy account.
 *
 * The whole app runs on ONE WorkBuddy account that the BizPilot operator signs
 * in once on the server (`npm run workbuddy:login`), or provides as
 * CODEBUDDY_API_KEY / CODEBUDDY_AUTH_TOKEN in server/.env. End users never see a
 * WorkBuddy login: they just use BizPilot.
 */

const ACCOUNT_FILE = join(process.cwd(), '.workbuddy-account.json');

export const environment = (process.env.WORKBUDDY_ENV || 'external') as AuthEnvironment;
export const cliPath = () => process.env.CODEBUDDY_CODE_PATH || undefined;

/** Only pass what the agent runtime needs: never database or integration secrets. */
export function runtimeEnv(): Record<string, string> {
  const keep = /^(PATH|Path|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|SystemRoot|SYSTEMROOT|ComSpec|TEMP|TMP|TMPDIR|LANG|LC_ALL|HOMEDRIVE|HOMEPATH|PROGRAMFILES|ProgramFiles|NODE_EXTRA_CA_CERTS|HTTPS?_PROXY|https?_proxy|NO_PROXY|no_proxy|CODEBUDDY_.*)$/;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && keep.test(k)) env[k] = v;
  return env;
}

/** An empty working directory: the agent gets no file system access to the server. */
export function sandboxDir() {
  const dir = join(tmpdir(), 'bizpilot-agent');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export interface WorkBuddyAccount { name: string; signedInAt: string }

export function readAccount(): WorkBuddyAccount | null {
  try {
    return existsSync(ACCOUNT_FILE) ? (JSON.parse(readFileSync(ACCOUNT_FILE, 'utf8')) as WorkBuddyAccount) : null;
  } catch {
    return null;
  }
}

export function rememberAccount(name: string) {
  writeFileSync(ACCOUNT_FILE, JSON.stringify({ name, signedInAt: new Date().toISOString() }, null, 2));
}

// ---------------------------------------------------------------- health

type Health = { online: boolean; checkedAt: number; error: string | null };
let health: Health | null = null;
let checking: Promise<Health> | null = null;

const AUTH_ERR = /auth|login|log in|token|401|403|unauthori|credential|not signed/i;

/** Record the outcome of a real agent run so status stays accurate without extra checks. */
export function reportRun(ok: boolean, error?: string) {
  if (ok) health = { online: true, checkedAt: Date.now(), error: null };
  else if (error && AUTH_ERR.test(error)) health = { online: false, checkedAt: Date.now(), error };
}

/**
 * Start the WorkBuddy runtime and read the signed-in account, without sending
 * a prompt to the model. Cached for 10 minutes.
 */
export async function checkEngine(force = false): Promise<Health> {
  if (!force && health && Date.now() - health.checkedAt < 10 * 60_000) return health;
  if (checking) return checking;
  checking = (async () => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 45_000);
    try {
      const q = query({
        prompt: 'ping',
        options: { environment, pathToCodebuddyCode: cliPath(), env: runtimeEnv(), cwd: sandboxDir(), tools: [], maxTurns: 1, abortController: abort, settingSources: [], persistSession: false } as any,
      });
      let info: any = null;
      for await (const msg of q as AsyncIterable<any>) {
        if (msg.type === 'system' && msg.subtype === 'init') {
          info = await (q as any).accountInfo?.().catch(() => null);
          abort.abort();
          break;
        }
        if (msg.type === 'error' || (msg.type === 'result' && msg.is_error)) throw new Error(String(msg.error ?? msg.errors?.join('; ') ?? 'WorkBuddy error'));
        if (msg.type === 'result') break;
      }
      if (info?.email || info?.organization) rememberAccount(info.email || info.organization);
      health = { online: true, checkedAt: Date.now(), error: null };
    } catch (e) {
      const msg = (e as Error).message || String(e);
      health = /abort/i.test(msg) && health?.online
        ? health
        : { online: false, checkedAt: Date.now(), error: AUTH_ERR.test(msg) ? 'The BizPilot WorkBuddy account is not signed in on the server.' : msg };
    } finally {
      clearTimeout(timer);
      checking = null;
    }
    return health!;
  })();
  return checking;
}

export async function status() {
  const h = await checkEngine();
  const account = readAccount();
  return {
    engine: 'WorkBuddy',
    connected: h.online,
    account: account?.name ?? null,
    error: h.online ? null : h.error,
  };
}
