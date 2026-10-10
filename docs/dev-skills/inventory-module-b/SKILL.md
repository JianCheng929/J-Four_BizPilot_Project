---
name: bizpilot-inventory-skill
description: BizPilot Module B inventory development, Supabase connection, multi-module integration, and verification guidance. Use when inspecting, connecting, testing, or troubleshooting Module B without changing files unless the user explicitly approves a fix.
---

# BizPilot Module B Skill

## Project location

The Module B source is located at:

```text
bizpilot/module-b/
```

Important areas:

- `sql/001_schema.sql` through `sql/004_currency_defaults.sql`: core PostgreSQL schema, seed data, Phase 2 tables, and currency defaults.
- `sql/005_supabase_rls.sql`: optional Supabase Row Level Security layer.
- `src/domain/`: deterministic inventory rules with no database or model dependency.
- `src/db/`: PostgreSQL queries, transactions, locks, idempotency, and tenant filters.
- `src/tools/register.ts`: MCP tool surface; `businessId` must never be exposed as a tool argument.
- `src/server.ts`: stateless Streamable HTTP MCP server and health endpoint.
- `src/http/`: inventory dashboard and offline snapshot.
- `test/e2e.mjs` and `test/p2.mjs`: end-to-end verification against real PostgreSQL and MCP.

## Default operating mode

When the user asks to inspect, check, connect, or test Module B:

1. Start with read-only inspection.
2. Do not modify source, SQL, configuration, database contents, or generated files unless the user explicitly authorizes a fix.
3. Separate findings into:
   - actual Module B code or schema problems;
   - expected errors caused by missing environment variables or an unconnected module;
   - integration issues that can only be confirmed after all modules are connected.
4. Report file paths, relevant symbols, severity, and a practical reproduction or verification step.
5. Do not call a risk a confirmed bug until a reproducible test or code path supports it.

## Database and Supabase rules

- PostgreSQL is the authoritative inventory store. Do not calculate authoritative stock in the AI layer.
- Every application query and mutation must remain scoped by `business_id`.
- `businessId` is server-bound and must not be accepted as an MCP tool parameter.
- Stock mutations must use a transaction and lock the relevant `stock_balance` row with `FOR UPDATE`.
- Reusable mutation requests require idempotency keys.
- `available_to_sell` is database-generated; application code must not write it directly.
- Supabase uses the same PostgreSQL SQL. Run migrations using a direct or session connection, not the transaction pooler port `6543`.
- `sql/005_supabase_rls.sql` is optional. If it is applied, runtime configuration must set `BIZPILOT_RLS=true` so each transaction declares `app.business_id`.
- Keep `DB_ROW_SECURITY_BYPASS=false` for the running server. Use a bypass only for an intentional migration or seed process.
- Never expose database passwords, Supabase keys, service-role keys, or connection strings in source, logs, commits, or chat.

## Connection checklist

Before multi-module integration, verify:

```bash
pnpm install
pnpm build
pnpm typecheck
```

For local PostgreSQL, verify `DATABASE_URL` and `BIZPILOT_BUSINESS_ID`.

For Supabase, verify:

- `DATABASE_URL` points to the project PostgreSQL connection;
- the migration uses port `5432` direct/session access;
- TLS is enabled for the Supabase host;
- `sql/001_schema.sql` through `sql/004_currency_defaults.sql` have been applied in order;
- `sql/005_supabase_rls.sql` is applied only if RLS is intended;
- `BIZPILOT_RLS` matches whether RLS is installed;
- the configured business UUID exists.

## Integration order

Use this order when connecting all modules:

1. Database connectivity and schema migration.
2. Business and location identity shared by all modules.
3. Product and variant identity shared by catalogue, sales, purchasing, and inventory.
4. Supplier and purchasing data.
5. Sales/order events into inventory reservation and sale posting.
6. Approval flow and audit trail.
7. Dashboard and reporting reads.
8. Real end-to-end tests with duplicate requests, concurrent stock changes, rejection paths, and tenant isolation.

Do not invent real supplier data, product data, platform credentials, user identities, or approval identities. Mark those as user-supplied integration inputs.

## Verification commands

Use the project's existing commands after the database is configured:

```bash
pnpm typecheck
pnpm build
pnpm test
pnpm screen
```

The expected baseline is 123 passing assertions: 41 in `test/e2e.mjs` and 82 in `test/p2.mjs`. If another module changes shared tables or event behavior, rerun both suites and identify whether a failure is a regression, a fixture mismatch, or an intentional contract change.

## Findings format

For checks and integration reports, use:

| Severity | Meaning |
|---|---|
| Blocker | Prevents startup, migration, or safe stock mutation |
| High | Can corrupt stock, approval, tenant isolation, or financial reporting |
| Medium | Breaks a supported workflow or produces misleading output |
| Low | Documentation, observability, or non-blocking usability issue |
| Pending integration | Cannot be confirmed until another module, credential, or deployment is connected |

For each finding include:

- file and symbol;
- observed behavior;
- whether it is confirmed or pending integration;
- safe reproduction or verification step;
- proposed next decision, without applying the fix automatically.

## Scope boundary

This skill covers Module B inventory behavior and its interfaces with other modules. It does not create real platform integrations, authenticate users, approve consequential actions on a user's behalf, or silently alter production data.
