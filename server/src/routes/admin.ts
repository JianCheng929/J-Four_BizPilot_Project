import { Router, type Request } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { unstable_v2_authenticate, unstable_v2_logout } from '@tencent-ai/agent-sdk';
import { handle, HttpError } from '../lib/http.ts';
import { checkEngine, cliPath, environment, forgetLogin, loginDiagnostics, withRuntime, readAccount, rememberAccount, reportRun, runtimeEnv, saveLogin, status } from '../agent/workbuddy.ts';

/**
 * Operator-only page for signing the server in to BizPilot's WorkBuddy account.
 * It runs the sign-in on this server, so the saved login is in the format this
 * machine's runtime can read. Protected by WORKBUDDY_ADMIN_KEY; BizPilot users
 * never see it.
 */
export const admin = Router();

type Login = { state: 'waiting' | 'done' | 'failed'; url: string | null; error: string | null; startedAt: number };
let login: Login | null = null;

function checkKey(req: Request) {
  const expected = process.env.WORKBUDDY_ADMIN_KEY;
  if (!expected || expected.length < 12) throw new HttpError(503, 'Set WORKBUDDY_ADMIN_KEY (at least 12 characters) on the server first.');
  const given = String(req.header('x-admin-key') ?? '');
  const h = (s: string) => createHash('sha256').update(s).digest();
  if (!timingSafeEqual(h(given), h(expected))) throw new HttpError(401, 'Wrong admin key.');
}

admin.get('/workbuddy', (_req, res) => {
  res.type('html').send(PAGE);
});

admin.get('/workbuddy/status', handle(async (req) => {
  checkKey(req);
  if (req.query.refresh) await checkEngine(true);
  await saveLogin(true).catch(() => undefined);
  return { login, engine: await status(), storage: loginDiagnostics() };
}));

admin.post('/workbuddy/login', handle(async (req) => {
  checkKey(req);
  if (login?.state === 'waiting' && login.url && Date.now() - login.startedAt < 9 * 60_000) return { login };
  const current: Login = { state: 'waiting', url: null, error: null, startedAt: Date.now() };
  login = current;
  const gotUrl = new Promise<void>((resolve) => {
    void withRuntime(() =>
      unstable_v2_authenticate({
        environment,
        timeout: 10 * 60_000,
        pathToCodebuddyCode: cliPath(),
        env: runtimeEnv(),
        onAuthUrl: ({ authUrl }) => {
          current.url = authUrl;
          resolve();
        },
      }),
    )
      .then(async (r) => {
        rememberAccount(r.userinfo.userNickname || r.userinfo.userName || r.userinfo.userId);
        current.state = 'done';
        reportRun(true); // marks the engine online and saves the login
        await saveLogin(true);
      })
      .catch((e: Error) => {
        current.state = 'failed';
        current.error = e.message;
      })
      .finally(resolve);
  });
  await Promise.race([gotUrl, new Promise((r) => setTimeout(r, 45_000))]);
  return { login: current, account: readAccount()?.name ?? null };
}));

admin.post('/workbuddy/logout', handle(async (req) => {
  checkKey(req);
  await withRuntime(() => unstable_v2_logout({ environment, pathToCodebuddyCode: cliPath(), env: runtimeEnv() }));
  login = null;
  await forgetLogin();
  await checkEngine(true);
  return { ok: true };
}));

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>BizPilot · WorkBuddy engine</title>
<style>
body{font-family:system-ui,sans-serif;background:#f6f7f8;color:#111;margin:0;padding:32px 16px}
main{max-width:520px;margin:auto;background:#fff;border:1px solid #e3e5e8;border-radius:12px;padding:24px}
h1{font-size:20px;margin:0 0 4px}p{color:#555;line-height:1.5}
input{width:100%;box-sizing:border-box;padding:10px;border:1px solid #ccd;border-radius:8px;font-size:15px}
button{margin-top:12px;padding:10px 16px;border:0;border-radius:8px;background:#0f766e;color:#fff;font-size:15px;cursor:pointer}
button.secondary{background:#e5e7eb;color:#111}
#out{margin-top:16px;padding:12px;border-radius:8px;background:#f1f5f9;white-space:pre-wrap}
a{color:#0f766e;font-weight:600;word-break:break-all}
</style></head><body><main>
<h1>WorkBuddy engine</h1>
<p>Sign this BizPilot server in to the WorkBuddy account that powers the app. Only the BizPilot operator needs this page.</p>
<input id="key" type="password" placeholder="Admin key (WORKBUDDY_ADMIN_KEY)" autocomplete="current-password">
<button id="check">Check status</button>
<button id="login">Sign in to WorkBuddy</button>
<button id="logout" class="secondary">Sign out</button>
<div id="out">Enter the admin key, then check the status.</div>
</main><script>
const $=id=>document.getElementById(id);const out=$('out');let timer;
const call=async(path,method='GET')=>{const r=await fetch('/admin/workbuddy'+path,{method,headers:{'x-admin-key':$('key').value}});let j;try{j=await r.json()}catch{throw new Error('The server is restarting or busy (HTTP '+r.status+'). Wait until Render shows Live, then try again.')}if(!r.ok)throw new Error(j.error||r.statusText);return j};
const show=j=>{const e=j.engine;const l=j.login;let t=e?(e.connected?'Engine: ONLINE'+(e.account?' as '+e.account:''):'Engine: offline'+(e.error?' ('+e.error+')':'')):'';
 if(l&&l.state==='waiting'&&l.url){out.innerHTML='';const a=document.createElement('a');a.href=l.url;a.target='_blank';a.rel='noopener';a.textContent='Open this link and sign in to WorkBuddy';out.append(a,document.createTextNode('\\n\\nThis page updates by itself when you finish.\\n'+t));return}
 if(l&&l.state==='failed')t='Sign-in failed: '+l.error+'\\n'+t;if(l&&l.state==='done')t='Signed in.\\n'+t;if(j.storage)t+='\\n\\nSaved login: '+j.storage.lastSave+'\\nFiles in '+j.storage.dataDir+':\\n'+(j.storage.files.join('\\n')||'(none)');out.textContent=t};
const poll=()=>{clearInterval(timer);timer=setInterval(async()=>{try{const j=await call('/status');show(j);if(!j.login||j.login.state!=='waiting')clearInterval(timer)}catch(e){out.textContent=e.message;clearInterval(timer)}},3000)};
$('check').onclick=async()=>{out.textContent='Checking…';try{show(await call('/status?refresh=1'))}catch(e){out.textContent=e.message}};
$('login').onclick=async()=>{out.textContent='Starting sign-in…';try{const j=await call('/login','POST');show({login:j.login});poll()}catch(e){out.textContent=e.message}};
$('logout').onclick=async()=>{try{await call('/logout','POST');out.textContent='Signed out.'}catch(e){out.textContent=e.message}};
</script></body></html>`;
