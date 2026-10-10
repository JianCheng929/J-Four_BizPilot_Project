# Put BizPilot online (no localhost)

BizPilot has two parts:

| Part | Where | Cost |
|---|---|---|
| Web app (what users open) | **Vercel** | free |
| BizPilot server + WorkBuddy engine | **Render** (Docker) | free tier sleeps when idle; Starter plan stays on |

Users only ever open the Vercel link. WorkBuddy runs inside the server on BizPilot's own
WorkBuddy account, so users never sign in to WorkBuddy.

## 1. Push the code to GitHub
Create a private repo and push `C:\BizPilot` (the `.gitignore` already keeps `.env` files out).

## 2. Get BizPilot's WorkBuddy token (once, on your PC)
```
cd server
npm install
npm run workbuddy:token
```
A browser opens; sign in with the WorkBuddy account BizPilot should use. The terminal then
prints a token. Keep it secret; you paste it into Render in step 3.
If the token ever expires, BizPilot shows "AI engine offline": run this again and update it on Render.

## 3. Deploy the server on Render
1. https://render.com → **New → Blueprint** → choose your repo (it reads `render.yaml`).
2. Fill in:
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (Supabase → Project Settings → API)
   - `CODEBUDDY_AUTH_TOKEN` (from step 2)
   - `APP_URL` = your Vercel URL from step 4 (you can come back and set it)
   - `PUBLIC_SERVER_URL` = this service's URL, e.g. `https://bizpilot-server.onrender.com`
3. Deploy. Open `https://<your-service>.onrender.com/health`; it should show `{"ok":true,"supabase":true}`.
   The log shows `WorkBuddy engine: online` when the token works.

## 4. Deploy the web app on Vercel
1. https://vercel.com → **Add New → Project** → import the same repo. Framework: Vite (auto-detected).
2. Environment variables:
   - `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`
   - `VITE_API_URL` = your Render URL, e.g. `https://bizpilot-server.onrender.com`
3. Deploy. Put the Vercel URL into Render's `APP_URL` and redeploy the server.

## 5. Supabase
Authentication → URL Configuration → **Site URL** = your Vercel URL, so sign-up emails link to the live app.

## 6. Marketplaces
Use `https://<your-render-url>/api/integrations/<shopee|lazada|tiktok_shop>/callback` as the
redirect URL in each platform's developer console (Settings → Integrations shows the exact URL).
