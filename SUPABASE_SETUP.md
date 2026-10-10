# Supabase setup

1. Create a project at https://supabase.com (region: Singapore is closest to Malaysia).
2. **SQL Editor → New query**, paste the whole of `supabase/schema.sql`, click **Run**.
   - Schema v2. If an older BizPilot schema (v1) exists it is dropped first, together with its data.
   - Safe to re-run: everything is `create … if not exists`.
3. **Authentication → Providers → Email**: keep enabled. For quick local testing you can turn off "Confirm email".
4. **Project Settings → API**, copy:
   - Project URL → `VITE_SUPABASE_URL` in `.env` and `SUPABASE_URL` in `server/.env`
   - `anon` public key → `VITE_SUPABASE_ANON_KEY` in `.env`
   - `service_role` secret key → `SUPABASE_SERVICE_ROLE_KEY` in `server/.env` only. Never put it in the web app `.env` or share it.
5. Restart `npm run dev` and the server.

## How data is protected

- Each signed-in user owns one business (`businesses.owner_id`).
- Every business table has a Row Level Security policy that only allows rows whose `business_id` belongs to the signed-in owner.
- `integrations` (API keys, OAuth tokens) and `api_tokens` have RLS enabled with no policy, so only the server's service role can read them.
