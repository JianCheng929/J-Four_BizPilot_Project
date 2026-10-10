import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { query } from '@tencent-ai/agent-sdk';
import type { AuthEnvironment } from '@tencent-ai/agent-sdk';
import { isSupabaseConfigured, supabaseAdmin } from '../lib/supabase.ts';

/**
 * BizPilot's built-in WorkBuddy account.
 *
 * The whole app runs on ONE WorkBuddy account that the BizPilot operator signs
 * in once: on a cloud server from /admin/workbuddy, locally with
 * `npm run workbuddy:login`, or with CODEBUDDY_API_KEY in server/.env. End users never see a
 * WorkBuddy login: they just use BizPilot.
 */

const ACCOUNT_FILE = join(process.cwd(), '.workbuddy-account.json');

/** Where the WorkBuddy runtime keeps its saved login on this OS. */
export function authDir() {
  const home = homedir();
  const base =
    process.platform === 'win32' ? join(home, 'AppData', 'Local', 'CodeBuddyExtension')
    : process.platform === 'darwin' ? join(home, 'Library', 'Application Support', 'CodeBuddyExtension')
    : join(home, '.local', 'share', 'CodeBuddyExtension');
  return join(base, 'Data', 'Public', 'auth');
}

// ---------------------------------------------------------------- saved login

/**
 * The WorkBuddy runtime keeps its login (with the refresh token) as files in
 * authDir(). Render's free disk is wiped whenever the server sleeps or restarts,
 * so BizPilot copies those files into Supabase (table server_secrets: RLS on, no
 * policies, so only this server can read it) and puts them back at startup.
 * The login is created on this server itself (routes/admin.ts), so the files
 * are always in the format this machine's runtime can read.
 */
const LOGIN_KEY = 'workbuddy_login';
const LOGIN_FILE = /^[\w-]+\.info$/;
let lastSaved = '';

function readLoginFiles(): Record<string, string> {
  const dir = authDir();
  if (!existsSync(dir)) return {};
  const files: Record<string, string> = {};
  for (const f of readdirSync(dir)) if (LOGIN_FILE.test(f)) files[f] = readFileSync(join(dir, f), 'utf8');
  return files;
}

/** Put the saved login back on disk. Call before the runtime is first used. */
export async function restoreLogin() {
  if (!isSupabaseConfigured()) return false;
  const { data, error } = await supabaseAdmin().from('server_secrets').select('value').eq('key', LOGIN_KEY).maybeSingle();
  if (error) {
    console.error(`Could not load the saved WorkBuddy login: ${error.message} (run the server_secrets SQL in DEPLOY.md)`);
    return false;
  }
  if (!data?.value) return false;
  const files = JSON.parse(String(data.value)) as Record<string, string>;
  const dir = authDir();
  mkdirSync(dir, { recursive: true });
  for (const [f, body] of Object.entries(files)) if (LOGIN_FILE.test(f)) writeFileSync(join(dir, f), body, { mode: 0o600 });
  lastSaved = JSON.stringify(files);
  return true;
}

/** Copy the login files to Supabase when they change (a new sign-in or a refreshed token). */
export async function saveLogin() {
  if (!isSupabaseConfigured()) return;
  const files = readLoginFiles();
  if (!Object.keys(files).length) return;
  const value = JSON.stringify(files);
  if (value === lastSaved) return;
  const { error } = await supabaseAdmin().from('server_secrets').upsert({ key: LOGIN_KEY, value, updated_at: new Date().toISOString() });
  if (error) console.error(`Could not save the WorkBuddy login: ${error.message}`);
  else lastSaved = value;
}

export async function forgetLogin() {
  lastSaved = '';
  if (isSupabaseConfigured()) await supabaseAdmin().from('server_secrets').delete().eq('key', LOGIN_KEY);
}

export const environment = (process.env.WORKBUDDY_ENV || 'external') as AuthEnvironment;
export const cliPath = () => process.env.CODEBUDDY_CODE_PATH || undefined;

/** Only pass what the agent runtime needs: never database or integration secrets. */
export function runtimeEnv(): Record<string, string> {
  const keep = /^(PATH|Path|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|SystemRoot|SYSTEMROOT|ComSpec|TEMP|TMP|TMPDIR|LANG|LC_ALL|HOMEDRIVE|HOMEPATH|PROGRAMFILES|ProgramFiles|NODE_EXTRA_CA_CERTS|HTTPS?_PROXY|https?_proxy|NO_PROXY|no_proxy|CODEBUDDY_.*)$/;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && keep.test(k)) env[k] = v;
  // A bare access token has no user id or refresh token (it gave 401) and would override the real login.
  delete env.CODEBUDDY_AUTH_TOKEN;
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
  if (ok) {
    health = { online: true, checkedAt: Date.now(), error: null };
    void saveLogin(); // the run may have refreshed the token
  }
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
      // The runtime starts even when signed out, so only a real account counts as online.
      const name = info?.userNickname || info?.userName || info?.email || info?.organization || info?.userId;
      if (!name && !info?.token && !info?.apiKeySource) throw new Error('not signed in');
      if (name) rememberAccount(String(name));
      health = { online: true, checkedAt: Date.now(), error: null };
      void saveLogin();
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
