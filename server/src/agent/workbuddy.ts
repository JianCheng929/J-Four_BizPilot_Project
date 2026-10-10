import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { unstable_v2_authenticate } from '@tencent-ai/agent-sdk';
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
const LOGIN_FILE = /^[\w-][\w.-]*$/; // a plain file name, no paths
let lastSaved = '';
let lastSaveNote = 'Not attempted yet.';

/** For the admin page: what the runtime has on disk (names and sizes only) and the last save result. */
export function loginDiagnostics() {
  const base = join(authDir(), '..', '..', '..');
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 5 || found.length > 60 || !existsSync(dir)) return;
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      const st = statSync(p);
      if (st.isDirectory()) walk(p, depth + 1);
      else found.push(`${p.slice(base.length + 1)} (${st.size} B)`);
    }
  };
  try { walk(base, 0); } catch (e) { found.push(`error: ${(e as Error).message}`); }
  const cb = join(homedir(), '.codebuddy');
  const before = found.length;
  try { walk(cb, 3); } catch { /* optional */ }
  for (let i = before; i < found.length; i++) found[i] = `~/.codebuddy: ${found[i]}`;
  return { dataDir: base, files: found, lastSave: lastSaveNote };
}

/**
 * Folders where the runtime keeps its login state. The npm CLI keeps some of it
 * in ~/.codebuddy/local_storage rather than the desktop app's auth folder, so
 * both are copied. Keys look like "auth/<file>" and "local/<file>".
 */
function loginRoots(): Record<string, string> {
  return { auth: authDir(), local: join(homedir(), '.codebuddy', 'local_storage') };
}

function readLoginFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const [root, dir] of Object.entries(loginRoots())) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (LOGIN_FILE.test(f) && statSync(p).isFile()) files[`${root}/${f}`] = readFileSync(p).toString('base64');
    }
  }
  return files;
}

let restoring: Promise<boolean> | null = null;

/** Put the saved login back on disk. Call before the runtime is first used. */
export function restoreLogin() {
  restoring ??= restoreLoginNow().catch((e) => { restoring = null; throw e; });
  return restoring;
}

async function restoreLoginNow() {
  if (!isSupabaseConfigured()) return false;
  const { data, error } = await supabaseAdmin().from('server_secrets').select('value').eq('key', LOGIN_KEY).maybeSingle();
  if (error) {
    console.error(`Could not load the saved WorkBuddy login: ${error.message} (run the server_secrets SQL in DEPLOY.md)`);
    return false;
  }
  if (!data?.value) {
    console.log('No saved WorkBuddy login in Supabase yet: sign in at /admin/workbuddy.');
    return false;
  }
  const files = JSON.parse(String(data.value)) as Record<string, string>;
  const roots = loginRoots();
  for (const [key, body] of Object.entries(files)) {
    const [root, f] = key.split('/');
    const dir = roots[root];
    if (!dir || !f || !LOGIN_FILE.test(f)) continue;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, f), Buffer.from(body, 'base64'), { mode: 0o600 });
  }
  lastSaved = JSON.stringify(files);
  console.log(`WorkBuddy login restored from Supabase (${Object.keys(files).length} file(s)).`);
  return true;
}

/** Copy the login files to Supabase when they change (a new sign-in or a refreshed token). */
export async function saveLogin(report = false) {
  if (!isSupabaseConfigured()) {
    lastSaveNote = 'Supabase is not configured on the server.';
    return;
  }
  const files = readLoginFiles();
  if (!Object.keys(files).length) {
    lastSaveNote = `No login files in ${Object.values(loginRoots()).join(' or ')}`;
    if (report) console.error(`WorkBuddy login not saved: ${lastSaveNote}`);
    return;
  }
  const value = JSON.stringify(files);
  if (value === lastSaved) return;
  const { error } = await supabaseAdmin().from('server_secrets').upsert({ key: LOGIN_KEY, value, updated_at: new Date().toISOString() });
  if (error) {
    lastSaveNote = `Supabase error: ${error.message}`;
    console.error(`Could not save the WorkBuddy login: ${error.message}`);
  } else {
    lastSaved = value;
    lastSaveNote = `Saved ${Object.keys(files).length} file(s) at ${new Date().toISOString()}`;
    console.log(`WorkBuddy login saved to Supabase (${Object.keys(files).join(', ')}).`);
  }
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
  // The SDK merges process.env into the child's environment, so anything not
  // kept is blanked explicitly: database and integration secrets never reach it.
  for (const [k, v] of Object.entries(process.env)) env[k] = v !== undefined && keep.test(k) ? v : '';
  // A bare access token has no user id or refresh token (it gave 401) and would override the real login.
  env.CODEBUDDY_AUTH_TOKEN = '';
  // Each runtime is a large Node process: keep it small enough to fit next to the server on a
  // 512 MB machine. Only flags Node accepts in NODE_OPTIONS work here (not --optimize-for-size).
  env.NODE_OPTIONS = process.env.WORKBUDDY_NODE_OPTIONS || '--max-semi-space-size=2 --max-old-space-size=320';
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

/**
 * How many WorkBuddy runtimes are running (agent runs, sign-ins). Each one
 * needs a few hundred MB, so health checks never start a second one alongside.
 */
let busy = 0;
export async function withRuntime<T>(fn: () => Promise<T>): Promise<T> {
  busy++;
  try {
    return await fn();
  } finally {
    busy--;
  }
}

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
 * (query().accountInfo() is not used: it re-initialises without the
 * environment and returns no account even when signed in.)
 */
export async function checkEngine(force = false): Promise<Health> {
  // Real runs keep `health` current (reportRun), so a check is rarely needed. Each check
  // starts a whole runtime, which would slow down a goal sent at the same moment.
  // A failed check is retried after a minute, so a passing glitch never sticks.
  if (!force && health && Date.now() - health.checkedAt < (health.online ? 6 * 60 * 60_000 : 60_000)) return health;
  // Never check before the saved login is back on disk (just after a restart).
  await restoreLogin().catch(() => false);
  if (checking) return checking;
  // Something is already using the runtime: don't start another just to check.
  if (busy > 0) return health ?? { online: true, checkedAt: Date.now(), error: null };
  checking = (async () => {
    try {
      // Ask the runtime who is signed in, the same way WorkBuddy's own sign-in does.
      // If it offers a login link instead, nobody is signed in.
      const signedIn = await new Promise<string>((resolve, reject) => {
        unstable_v2_authenticate({
          environment,
          timeout: 20_000,
          pathToCodebuddyCode: cliPath(),
          env: runtimeEnv(),
          onAuthUrl: () => reject(new Error('not signed in')),
        }).then((r) => resolve(r.userinfo.userNickname || r.userinfo.userName || r.userinfo.userId), (e: Error) => reject(e));
      });
      if (signedIn) rememberAccount(signedIn);
      health = { online: true, checkedAt: Date.now(), error: null };
      void saveLogin();
    } catch (e) {
      const msg = (e as Error).message || String(e);
      health = /abort/i.test(msg) && health?.online
        ? health
        : { online: false, checkedAt: Date.now(), error: AUTH_ERR.test(msg) ? 'The BizPilot WorkBuddy account is not signed in on the server.' : msg };
    } finally {
      checking = null;
    }
    return health!;
  })();
  return checking;
}

export async function status() {
  // Before the first check, answer from the saved login instead of starting a runtime:
  // opening a page must never compete with the owner's first goal for CPU.
  await restoreLogin().catch(() => false);
  const h = health ?? (Object.keys(readLoginFiles()).length
    ? { online: true, checkedAt: 0, error: null }
    : await checkEngine());
  const account = readAccount();
  return {
    engine: 'WorkBuddy',
    connected: h.online,
    account: account?.name ?? null,
    error: h.online ? null : h.error,
  };
}
