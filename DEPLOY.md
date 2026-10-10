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

## 2. Add the login table in Supabase (once)
Supabase → SQL Editor → run:
```sql
create table if not exists server_secrets (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
alter table server_secrets enable row level security;
```
(It is also in `supabase/schema.sql`.) No policies means only the server can read it.

## 3. Deploy the server on Render
1. https://render.com → **New → Blueprint** → choose your repo (it reads `render.yaml`).
2. Fill in:
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (Supabase → Project Settings → API)
   - `WORKBUDDY_ADMIN_KEY` = a long random password you choose (protects the sign-in page)
   - `APP_URL` = your Vercel URL from step 4 (you can come back and set it)
   - `PUBLIC_SERVER_URL` = this service's URL, e.g. `https://bizpilot-server.onrender.com`
3. Deploy. Open `https://<your-service>.onrender.com/health`; it should show `{"ok":true,"supabase":true}`.
4. Sign the server in to BizPilot's WorkBuddy account: open
   `https://<your-service>.onrender.com/admin/workbuddy`, enter the admin key, click
   **Sign in to WorkBuddy**, open the link and sign in. The page shows **Engine: ONLINE** when done.
   The login is saved in Supabase (`server_secrets`), so restarts and sleeps keep it, and
   refreshed tokens are saved automatically. If BizPilot ever says "AI engine offline", sign in on that page again.

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

## 7. Media storage, returns and stock fields (once)
In Supabase → SQL Editor, run these two files (both are safe to re-run):
- `supabase/marketing-media.sql`: storage for uploaded and AI-generated images and videos.
- `supabase/team-features.sql`: held stock, expiry date, safety/max stock, pack size, and returns.

## 8. AI images and videos
- Images work with no setup (free generator). Optional: `POLLINATIONS_TOKEN` on Render for higher limits.
- Real motion video uses Kling AI: in Render → Environment add `KLING_ACCESS_KEY` and
  `KLING_SECRET_KEY` from the Kling developer console (paid API credits). Without them,
  videos are made as animated slideshows from AI images in the browser.

## Troubleshooting: Vercel says "Deployment Blocked"
Vercel's free (Hobby) plan only deploys commits whose git author is the account owner.
Set your own name and GitHub email once (`git config --global user.name "..."` and
`git config --global user.email "..."`), then make a new commit and push.
