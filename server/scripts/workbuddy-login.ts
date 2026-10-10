/**
 * One-time setup for the BizPilot operator: sign the server in to the
 * WorkBuddy account that powers BizPilot. BizPilot users never see this.
 * On a cloud server, use the /admin/workbuddy page instead.
 *
 *   npm run workbuddy:login     sign in on this machine (local server)
 *   npm run workbuddy:logout    sign out on this machine
 */
import 'dotenv/config';
import { unstable_v2_authenticate, unstable_v2_logout } from '@tencent-ai/agent-sdk';
import { cliPath, environment, rememberAccount, runtimeEnv } from '../src/agent/workbuddy.ts';

if (process.argv.includes('--logout')) {
  await unstable_v2_logout({ environment, pathToCodebuddyCode: cliPath(), env: runtimeEnv() });
  console.log('Signed out of WorkBuddy.');
  process.exit(0);
}

console.log('Starting WorkBuddy sign-in…');
try {
  const env = runtimeEnv();
  const r = await unstable_v2_authenticate({
    environment,
    timeout: 10 * 60_000,
    pathToCodebuddyCode: cliPath(),
    env,
    onAuthUrl: async ({ authUrl }) => {
      console.log('\nOpen this link and sign in with the WorkBuddy account BizPilot should use:\n');
      console.log(`  ${authUrl}\n`);
      const { exec } = await import('node:child_process');
      const cmd = process.platform === 'win32' ? `start "" "${authUrl}"` : process.platform === 'darwin' ? `open "${authUrl}"` : `xdg-open "${authUrl}"`;
      exec(cmd, () => undefined);
    },
  });
  const name = r.userinfo.userNickname || r.userinfo.userName || r.userinfo.userId;
  rememberAccount(name);
  console.log(`\nDone. BizPilot now runs on WorkBuddy account: ${name}`);

  process.exit(0);
} catch (e) {
  console.error(`\nSign-in failed: ${(e as Error).message}`);
  process.exit(1);
}
