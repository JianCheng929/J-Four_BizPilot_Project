---
name: bizpilot-marketing
description: "BizPilot Module C — Automated Marketing and Business Growth. This skill should be used when the user says 'run this week's marketing', 'generate weekly content', 'create marketing posts', or asks BizPilot to produce the weekly marketing cycle. It executes an 11-step workflow: read brand files, check stock levels and review sentiment, decide product push/avoid, draft 5 bilingual posts + 1 video script, generate brand-compliant visuals, update content calendar and campaign tracker, write analytics summary (with sourced/flagged industry claims), run compliance checks, produce an approvals list, share data with other modules (including simulated previous-week results when no real data exists), and update the Marketing Studio dashboard. Never publishes or spends money without explicit human approval."
---

# BizPilot Marketing — Weekly Marketing Cycle

## Overview

This skill automates the weekly marketing cycle for a BizPilot SME business. It reads brand configuration files, checks cross-module data (inventory and customer sentiment), produces bilingual EN/Malay social media content, generates brand-compliant visuals, updates tracking documents, runs compliance verification, and outputs an approvals list.

**Trigger phrase:** "Run this week's marketing" or equivalent.

**Hard constraint:** Never publish, launch ads, or spend money. All outputs are DRAFT status. Every run ends with an "Approvals needed" list.

## Workflow

Execute all 10 steps in order. Do not ask the user for input mid-way — make reasonable assumptions, note them, and continue.

### Step 1 — Read Brand Files

Resolve the BizPilot project folder as the parent directory containing `bizpilot/`. Read brand files from the **project first**, falling back to this skill's bundled copy only if the project files are missing.

**Primary path:** `bizpilot/module-c/brand/`
**Fallback path:** this skill's `assets/brand/` directory

Read these files (try project path first, then skill fallback for each file individually):

| File | Purpose |
|------|---------|
| `brand_profile.json` | Products, prices, personas, brand colours, social platforms, brand voice |
| `compliance_rules.json` | Prohibited claims, platform rules, budget guardrails |
| `competitor_list.json` | Competitor positioning and pricing reference |
| `brand_voice_guide.md` | Tone pillars, language mix by platform, content pillars, approval workflow |
| `design_philosophy.md` | "Soft Science" visual style: colours, forms, hierarchy, craftsmanship |
| `data_contract.json` | Cross-module data formats (what to read from Module B/D/E) |

Extract: product list with SKUs and prices, brand colours, target personas, content pillars, and all compliance rules. Note in the run output which copy (project vs skill fallback) was used for each file.

**Business profile — single source of truth:** `bizpilot/shared/business_profile.json` is the cross-module source of truth for business details, products, prices, bundles, and campaign IDs. Read it alongside `brand_profile.json` and treat its values as authoritative:
- Use `business_profile.json → products[].sku`, `products[].name`, and `products[].price` for all product references and pricing (do not hand-key prices).
- Use `business_profile.json → campaigns[]` for campaign IDs, names, daily caps, and total caps. Campaign IDs are **unique across weeks** — continue the `camp-XXX` sequence from the existing entries; never reuse an ID from a prior week.
- Keep `brand_profile.json` prices and SKUs consistent with `business_profile.json`. If they disagree, business_profile.json wins and the discrepancy must be flagged in the run output.

### Step 2 — Read Cross-Module Data

Check for shared data files in the project workspace:

1. **Module B (Inventory):** `bizpilot/shared/module_b_stock_levels.json`
   - Look for each product SKU's `status` field
   - If file does not exist, write `"missing"` and proceed

2. **Module E (Customer Experience):** `bizpilot/shared/module_e_review_sentiment.json`
   - Look for recent sentiment entries per product SKU
   - If file does not exist, write `"missing"` and proceed

3. **Module D (Finance):** `bizpilot/shared/module_d_sales_by_product.csv`
   - Used for analytics attribution (Step 7)
   - If file does not exist, write `"missing"` and proceed

If any file is missing, continue the workflow. Note the missing data in the analytics summary and the approvals list.

### Step 3 — Decide Product Push/Avoid

Apply these rules to decide which products to promote this week:

- **Exclude** any product with `status: "out_of_stock"` from Module B data
- **Exclude** any product with 3+ consecutive negative sentiment entries containing serious complaints (irritation, allergic reaction, product defect) from Module E data
- **Prioritise** products that are in stock with positive sentiment
- **Rotate** products so this week's selection differs from last week's (read the most recent `outputs/<date>/` folder to see what was promoted before)
- **Balance** across content pillars (Education, Product Showcase, Customer Stories, Lifestyle, Promotions) — these are the 5 pillars defined in `brand_voice_guide.md`

If all products are out of stock or excluded, produce a report saying so and do not generate promotional content. Still produce the analytics summary and approvals list.

### Step 4 — Draft 5 Posts + 1 Video Script

Create content for the next week (Monday through Friday). For each post:

1. **Select platform** (rotate: Instagram, TikTok, Facebook, Instagram Reels, FB+IG cross-post)
2. **Select content pillar** (balance across the 5 pillars from `brand_voice_guide.md`: Education, Product Showcase, Customer Stories, Lifestyle, Promotions)
3. **Select product** (from the Step 3 push list)
4. **Select target persona** (from brand_profile.json)

For each post, produce:
- **English caption** — apply the `humanizer` skill to make it sound natural
- **Malay caption** — apply the `marketing-content-localization` skill for accurate Malay
- **Hashtags** — 8-10 relevant tags, bilingual
- **CTA** — platform-appropriate, with correct price from brand_profile.json

For the video script (one of the 5 posts), produce:
- Scene-by-scene breakdown with timing
- Bilingual VO text
- Shot list table (scene, duration, shot type, action, text overlay)
- Video specs (aspect ratio, duration, music, subtitles)
- Thumbnail concept

**Anti-repetition rule:** Read the most recent `outputs/` folder. Do not repeat the previous week's topics, hooks, or product-feature combinations. If last week was "harsh vs gentle cleanser," this week should be about ingredients, routines, or self-care.

Save all content as:
- `outputs/<YYYY-MM-DD>/weekly_content_plan.md`

### Step 5 — Create Visuals

**Never edit or run `scripts/generate_visuals.py` directly.** It is a protected template. Instead, follow this copy-and-adapt workflow. All paths below are from the workspace root (the folder containing `bizpilot/`).

1. **Copy** the script to the run's output folder:
   ```
   bizpilot/module-c/scripts/generate_visuals.py → bizpilot/module-c/outputs/<YYYY-MM-DD>/visuals/make_visuals_<YYYY-MM-DD>.py
   ```

2. **Adapt the copy** — change BOTH the function calls AND the hard-coded content inside functions to fit this week's products and topics:
   - **Function calls** (in the `__main__` block at the bottom): change product names, prices, hook text, ingredient badges, step descriptions, thumbnail lines to match this week's content plan
   - **Hard-coded content inside functions** — these are baked into the template and must be updated each week:
     - `make_product_shot()`: the title text `"The right cleanser\nfor YOUR skin"` → change to this week's hook/title
     - `make_cta()`: the tagline `"Ready to switch?"` → change to this week's CTA hook
     - `make_ph_scale()`: if used this week, change the title `"pH Scale"`, subtitle `"Your skin's natural pH is 5.5"`, and marker labels to match this week's educational topic
     - `make_comparison()`: if used this week, change the title `"The difference"`, column headers `"HARSH"`/`"GENTLE"`, and the item lists to match this week's comparison topic
   - **Keep brand colours** (loaded from `brand_profile.json` at runtime)
   - **Keep the "Soft Science" design philosophy** from `design_philosophy.md`
   - **Use simple illustrations**, never realistic photos of skin or people

3. **Resolve fonts and brand profile** — the copied script is now in `outputs/<YYYY-MM-DD>/visuals/`, so its default relative font path (`../assets/fonts/`) would point to the wrong directory. Pass `--fonts` and `--brand` explicitly:
   - **Font directory:** use `bizpilot/module-c/brand/fonts/` (project copy). If that directory is missing, fall back to this skill's `assets/fonts/` directory.
   - **Brand profile:** use `bizpilot/module-c/brand/brand_profile.json`.

4. **Run the copy:**
   ```bash
   python bizpilot/module-c/outputs/<YYYY-MM-DD>/visuals/make_visuals_<YYYY-MM-DD>.py \
     bizpilot/module-c/outputs/<YYYY-MM-DD>/visuals/ \
     --fonts bizpilot/module-c/brand/fonts/ \
     --brand bizpilot/module-c/brand/brand_profile.json
   ```
   If the project font directory does not exist, use the skill's bundled fonts instead:
   ```bash
   --fonts <skill-path>/assets/fonts/
   ```

The script produces:
- 5 carousel slides (1080x1080)
- 1-2 single-image posts (1080x1080)
- 2 Reels/TikTok thumbnails (1080x1920)

Install Pillow if needed: `pip install Pillow`

### Step 6 — Update Calendar and Campaign Tracker

**Content calendar:** Create `outputs/<YYYY-MM-DD>/content_calendar.md` with a table:
- Date, Platform, Campaign, Content Title, Status (all DRAFT), Caption EN, Caption Malay, Visual Asset, Hashtags, CTA, Approver, Scheduled, Published, Performance

**Campaign tracker:** Create `outputs/<YYYY-MM-DD>/campaign_tracker.md`:
- 2-3 campaigns with DRAFT status (not ACTIVE)
- Each campaign has: name, objective, platform, audience, daily budget cap, total budget cap, ad copy variants, creative link
- Budget caps must respect compliance_rules.json guardrails
- Include a budget summary table with totals
- All status values: DRAFT

### Step 7 — Write Analytics Summary

Create `outputs/<YYYY-MM-DD>/weekly_summary.md`.

For each metric, label its data source:
- **"actual"** — from Module D sales/ad spend data (if available)
- **"estimated"** — calculated from partial data
- **"forecast"** — projected based on trends
- **"DEMO DATA"** — placeholder numbers for demo/competition purposes

Include:
- Spend vs budget summary
- ROAS by campaign (if ad spend data available)
- Content performance ranking (if engagement data available)
- AI analysis and recommendations
- Missing data section (list any Module B/D/E data that was unavailable)

If no real data exists, label everything as DEMO DATA and note that real metrics will populate once campaigns go live.

**Industry-claim sourcing (forecasts & recommendations):** Any general industry, benchmark, or "rule of thumb" claim in the analytics summary, recommendations, or AI analysis — e.g. *"TikTok videos outperform static posts by 2-3x"*, *"average CPC is RM0.40-0.50"*, *"carousels get 1.5x more saves"* — MUST be either:
- backed by a **source link** (cite the URL inline next to the claim), OR
- explicitly labelled **`AI estimate, not sourced`**.

Do not present unsourced benchmark numbers as established facts. If a source cannot be cited, append **`AI estimate, not sourced`** to the claim so every quantitative forecast stays honest and auditable.

### Step 8 — Compliance Check

Run every caption, ad copy, and image text against the compliance checklist in `references/compliance_checklist.md`.

Check for:
- Prohibited claims (whitening, medical, guaranteed results, "chemical-free")
- Unverified claims (halal, dermatologist-tested, quantitative without source)
- Pressure tactics ("limited stock", "buy now", flash sale urgency)
- First-person testimonials (use how-to demonstrations instead)
- Price accuracy (must match brand_profile.json)
- Platform-specific rules (partnership disclosure, community guidelines)

Create `outputs/<YYYY-MM-DD>/compliance_report.md`:
- List each checked item
- Flag any violations with the specific text and the rule it violates
- If violations found, fix them in the content before finalising

### Step 9 — Approvals List

Create `outputs/<YYYY-MM-DD>/approvals_needed.md` with:

1. **Content approvals** — list each post that needs review before scheduling
2. **Campaign approvals** — list each campaign that needs approval before launch
3. **Budget approvals** — list total proposed daily and weekly ad spend
4. **Compliance flags** — any items that need human judgment (e.g., borderline claims)
5. **Missing data** — list any cross-module data that was unavailable

End with the statement: "No content was published. No ads were launched. No money was spent. All items above require human approval before action."

### Step 10 — Share Data with Other Modules

Produce three data files for cross-module consumption, following `references/data_contract.md`. Save each file into `outputs/<YYYY-MM-DD>/` AND copy all three into `bizpilot/shared/` so Modules D, E, and F always read the latest version from one fixed place.

**1. `marketing_metrics.json`** — for Module F (Business Intelligence Dashboard):
```json
{
  "run_date": "<YYYY-MM-DD>",
  "ad_spend": {
    "total": { "value": 460.00, "label": "DEMO DATA" },
    "by_campaign": []
  },
  "campaign_results": [],
  "content_performance": [],
  "reach": { "value": 0, "label": "DEMO DATA" },
  "engagement": { "value": 0, "label": "DEMO DATA" }
}
```
Every numeric value must carry a `"label"` field set to one of: `"actual"`, `"estimated"`, `"forecast"`, `"DEMO DATA"`.

**2. `campaign_costs.csv`** — owned by Module C, read by Module D (Finance) and Module F. This is the **ONLY** source of ad spend; Module D must NOT create its own ad-spend file (no `module_d_ad_spend.csv`):
```csv
date,campaign_id,platform,spend_amount
2026-10-19,camp-001,instagram,12.00
```
campaign_costs.csv holds real or simulated spend for campaigns that already ran. Write the previous-week simulated spend per campaign, per platform, per day, so that totals match previous_week.campaign_results spend in marketing_metrics.json, and each day <= daily_cap. Current-week DRAFT campaigns get NO rows (nothing spent yet). Never write 0.00 placeholder rows. Keep rows from earlier weeks (append, never delete).

**3. `marketing_topics.json`** — for Module E (Customer Experience):
```json
{
  "run_date": "<YYYY-MM-DD>",
  "campaigns": [
    {
      "campaign_id": "camp-001",
      "topics": ["ingredient education", "gentle cleansing"],
      "customer_feedback_summary": "No live feedback yet — campaigns are DRAFT"
    }
  ]
}
```

**File locations:**
- `outputs/<YYYY-MM-DD>/marketing_metrics.json` → also copy to `bizpilot/shared/marketing_metrics.json`
- `outputs/<YYYY-MM-DD>/campaign_costs.csv` → also copy to `bizpilot/shared/campaign_costs.csv`
- `outputs/<YYYY-MM-DD>/marketing_topics.json` → also copy to `bizpilot/shared/marketing_topics.json`

The copies in `bizpilot/shared/` are always the latest run's data (overwritten each run). The copies in `outputs/<date>/` preserve history.

#### Simulated previous-week results (DEMO DATA - simulated)

The `marketing_metrics.json` above drives Module F's dashboard and the Marketing Studio charts. It needs **real-looking results** to draw charts. Decide how to populate `campaign_results` and `content_performance` based on whether real Module D data exists (from Step 2):

- **If real Module D sales/ad-spend data IS available:** populate those arrays with **`"actual"`** label values from Module D. Do **not** simulate. The dashboard then shows real performance.
- **If no real Module D data exists (the normal demo / competition case):** generate a **SIMULATED results set for the PREVIOUS week's** run and write it into `marketing_metrics.json` so the dashboard shows real-looking charts.

  Procedure when simulating:
  1. Find the most recent prior `outputs/<date>/` folder (the run before the current one). Read its `campaign_tracker.md` (campaign names, daily caps, total caps) and `weekly_content_plan.md` (the 5 posts: platform, title, pillar, product).
  2. For each previous-week campaign, generate simulated metrics **strictly within its budget caps**: `spend` ≤ total cap, plus `impressions`, `clicks`, `conversions`, `revenue`, `reach`, `engagement`.
  3. For each previous-week post, generate simulated `reach`, `impressions`, `clicks`, `engagement` (and `conversions`/`revenue` if it maps to a campaign).
  4. Compute **ROAS = revenue ÷ spend** for each campaign (and per post where applicable).
  5. **Label EVERY simulated number** with `"label": "DEMO DATA - simulated"`. Keep a separate `"run_date"` for the simulation (the previous week) distinct from the current run's `run_date`.
  6. Store under `"campaign_results"` and `"content_performance"` arrays, plus aggregate `"reach"` and `"engagement"` totals — all labelled `"DEMO DATA - simulated"`.
  7. Add a top-level `"simulated": true` flag and a `"simulation_note"`: *"DEMO DATA - simulated. No real ad spend or performance occurred. Figures are generated for demonstration only."*

- **Never mix simulated with actual data.** If even one campaign or post has real Module D data, mark it `"actual"` and leave it untouched by the simulation. The `"label"` field is the single source of truth for what is real vs simulated, and the dashboard MUST surface that label on every metric.

#### Simulation realism & separation rules (apply to every simulated set)

These rules keep the demo honest and make the dashboard internally consistent. They are enforced by `scripts/generate_studio.py → compute_and_validate()` for the Marketing Studio data, and must be followed manually when writing `marketing_metrics.json` for Module F.

1. **Separation (dashboard only):** Simulated PREVIOUS-week results are NEVER attached to the current week's campaign cards. The current week's `campaigns` array is **caps-only** — `daily_cap`, `total_cap`, `status: "DRAFT"`, and `spend: 0`. No `roas`, `reach`, `conversions`, or `data_label` on current-week campaigns. The simulated results live only in the dashboard's `previous_week.campaign_results` block, rendered in the **Analytics** tab **under the previous week's campaign names** (e.g. "Toner Ingredient Education", "Moisturizer SPF Awareness", "Clay Mask Lifestyle", "Starter Bundle Launch"), never under this week's draft names.
2. **KPI totals = sum of rows:** Every analytics total (spend, reach, clicks, conversions, revenue) MUST equal the sum of the individual campaign rows. **ROAS = total revenue ÷ total spend** (rounded to 2 dp). Do not hand-key totals that disagree with the row sums.
3. **Revenue = conversions × unit price:** Each campaign row must carry a `"unit_price"` (the product price, or the **bundle price for bundles**) and its `"revenue"` MUST equal `conversions × unit_price`. Example: Moisturizer SPF 3 × RM45 = RM135 (ROAS 1.35x); Starter Bundle 4 × RM120 = RM480 (ROAS 3.0x). After setting revenue, derive ROAS = revenue ÷ spend. `compute_and_validate()` corrects any row where revenue ≠ conversions × unit_price.
4. **Realistic ROAS:** Every campaign's ROAS must fall within **0.8x–4.0x**. Exactly **one** campaign must come in **below the 2.0x target** (flagged `"performance": "below target"`). All others are `"above target"`. Keep the blended (total) ROAS near or above 2.0x so the week reads as healthy overall.
5. **Actionable recommendation:** The analytics recommendations MUST include one that names the below-target campaign and proposes a concrete fix — **lower its daily budget** (e.g. RM25 → ~RM15) **or refresh its creative** (new hook, **how-to demo**, problem-solution angle) before scaling. Never recommend before/after result claims — these are not allowed by the compliance rules.

Example of the simulated shape written into `marketing_metrics.json` (note: this block describes PREVIOUS-week results, while the file's top `run_date` is the current run; for the Marketing Studio dashboard the same numbers go under `previous_week.campaign_results` and the current week's `campaigns` stay caps-only):

```json
{
  "run_date": "<current-run-date>",
  "simulated": true,
  "simulation_note": "DEMO DATA - simulated. No real ad spend or performance occurred.",
  "ad_spend": {
    "total": { "value": 460.00, "label": "DEMO DATA - simulated" },
    "by_campaign": []
  },
  "campaign_results": [
    {
      "campaign_id": "camp-001",
      "name": "<prev-week campaign name>",
      "spend":        { "value": 120.00, "label": "DEMO DATA - simulated" },
      "impressions":  { "value": 9800,   "label": "DEMO DATA - simulated" },
      "clicks":       { "value": 210,    "label": "DEMO DATA - simulated" },
      "conversions":  { "value": 18,     "label": "DEMO DATA - simulated" },
      "revenue":      { "value": 336.00, "label": "DEMO DATA - simulated" },
      "reach":        { "value": 7200,   "label": "DEMO DATA - simulated" },
      "engagement":   { "value": 540,    "label": "DEMO DATA - simulated" },
      "roas":         { "value": 2.8,    "label": "DEMO DATA - simulated" }
    }
  ],
  "content_performance": [
    {
      "post_id": "post-1",
      "title": "<prev-week post title>",
      "platform": "Instagram",
      "reach":       { "value": 3100, "label": "DEMO DATA - simulated" },
      "impressions": { "value": 4200, "label": "DEMO DATA - simulated" },
      "clicks":      { "value": 89,   "label": "DEMO DATA - simulated" },
      "engagement":  { "value": 180,  "label": "DEMO DATA - simulated" },
      "roas":        { "value": 0,    "label": "DEMO DATA - simulated" }
    }
  ],
  "reach":      { "value": 12450, "label": "DEMO DATA - simulated" },
  "engagement": { "value": 2180,  "label": "DEMO DATA - simulated" }
}
```

### Step 11 — Update Marketing Studio Dashboard

After sharing data, refresh the live dashboard so it always reflects the latest run.

**Target page:** `bizpilot/module-c/ui/marketing_studio.html`

The dashboard must show the **latest week's**:
- **Posts** (from `content_calendar.md` / `weekly_content_plan.md`)
- **Visuals** (from `outputs/<date>/visuals/*.png`)
- **Campaigns** (from `campaign_tracker.md`)
- **Compliance result** (from `compliance_report.md`)
- **Approvals list** (from `approvals_needed.md`)
- **Analytics** (from `marketing_metrics.json`, including the previous-week simulated results for the charts)

**Procedure:**
1. Compose a single structured data file `bizpilot/module-c/ui/marketing_studio_data.json` from the current run's outputs (posts, campaigns, compliance result, approvals, analytics). Every numeric value that comes from simulation must carry `"DEMO DATA - simulated"`; real values carry `"actual"`. **Separation rule:** the current week's `campaigns` are caps-only (`spend: 0`, `status: "DRAFT"`, no simulated metrics); simulated previous-week results go under `previous_week.campaign_results` and surface only in the Analytics tab under the previous week's campaign names. See the schema expectations below.
2. Regenerate the dashboard HTML from the skill's bundled, data-driven template using the helper:
   ```bash
   python bizpilot/module-c/scripts/generate_studio.py \
     bizpilot/module-c/ui/marketing_studio_data.json \
     bizpilot/module-c/ui/marketing_studio.html
   ```
   The script injects the data as an inline `STUDIO_DATA` object and renders posts, campaigns, charts, compliance, and approvals dynamically. Because the data is embedded inline, the page works from `file://` with no server.
   - If the script is not yet in the project, copy it from the skill first:
     `scripts/generate_studio.py` (skill) → `bizpilot/module-c/scripts/generate_studio.py`.
3. If the helper is unavailable, hand-edit the dashboard's hardcoded sections (KPI cards, calendar cards, drafts, campaigns, analytics, charts) to match the latest run, preserving the DEMO DATA / label badges and the never-publish disclaimer.

`marketing_studio_data.json` — minimum fields the template consumes:

> **Separation note:** the current week's `campaigns` are **caps-only** (`spend: 0`, `status: "DRAFT"`). Simulated performance is NEVER stored on them — it lives only in `previous_week.campaign_results` and is shown in the Analytics tab under the previous week's names. `analytics.kpi` and the top-level `kpi` totals are recomputed from those rows by `compute_and_validate()`.
```json
{
  "run_date": "<YYYY-MM-DD>",
  "week_label": "Week of <Mon>-<Fri>, <YYYY>",
  "kpi": {
    "ad_spend":  { "value": 460.0, "label": "DEMO DATA - simulated", "budget": 575.0 },
    "reach":     { "value": 13400, "label": "DEMO DATA - simulated" },
    "roas":      { "value": 2.69,  "label": "DEMO DATA - simulated", "target": 2.0 },
    "pending_approvals": { "content": 5, "campaigns": 4 }
  },
  "briefing": "AI daily briefing paragraph (state that this week is DRAFT / RM0 spent, and that simulated results are for the previous week only).",
  "campaigns": [
    {
      "id": "camp-001", "name": "... (this week's DRAFT name)", "platform": "...",
      "objective": "...", "audience": "...", "daily_cap": 30, "total_cap": 300,
      "status": "DRAFT", "spend": 0
    }
  ],
  "previous_week": {
    "run_date": "2026-10-19",
    "campaign_results": [
      {
        "campaign_id": "camp-001",
        "name": "... (PREVIOUS week's name, e.g. Toner Ingredient Education)",
        "unit_price": 42,
        "spend":        { "value": 120.00, "label": "DEMO DATA - simulated" },
        "impressions":  { "value": 9800,   "label": "DEMO DATA - simulated" },
        "clicks":       { "value": 210,    "label": "DEMO DATA - simulated" },
        "conversions":  { "value": 8,      "label": "DEMO DATA - simulated" },
        "revenue":      { "value": 336.00, "label": "DEMO DATA - simulated" },
        "reach":        { "value": 3100,   "label": "DEMO DATA - simulated" },
        "engagement":   { "value": 410,    "label": "DEMO DATA - simulated" },
        "roas":         { "value": 2.8,    "label": "DEMO DATA - simulated" },
        "performance": "above target"
      }
    ],
    "content_performance": [ { "rank": 1, "title": "...", "platform": "Instagram", "engagement": 4.4, "clicks": 210, "label": "DEMO DATA - simulated", "top": true } ],
    "kpi": { "spend": 460, "reach": 13400, "clicks": 735, "conversions": 21, "revenue": 1239, "roas": 2.69, "label": "DEMO DATA - simulated" }
  },
  "posts": [
    {
      "day": "MONDAY", "date": "Oct 26", "title": "...", "platform": "Instagram",
      "pillar": "Education", "product": "GS-CLE-001", "price": "RM35", "status": "DRAFT",
      "visual": "../outputs/2026-10-26/visuals/slide1_cover.png",
      "caption_en": "...", "caption_my": "...", "hashtags": ["#GlowSara", "#SkincareMalaysia"]
    }
  ],
  "compliance": { "result": "PASS", "summary": "No violations found.", "violations": [] },
  "approvals": {
    "content": ["..."], "campaigns": ["..."], "budget": "...",
    "flags": ["..."], "missing_data": ["..."]
  },
  "analytics": {
    "period": "Previous week (Oct 19-23, 2026) — simulated results only",
    "kpi": { "spend": 460, "reach": 13400, "clicks": 735, "conversions": 21, "revenue": 1239, "roas": 2.69, "label": "DEMO DATA - simulated" },
    "content_performance": [
      { "rank": 1, "title": "...", "platform": "Instagram", "engagement": 4.4, "clicks": 210, "label": "DEMO DATA - simulated", "top": true }
    ],
    "recommendations": [
      "Moisturizer SPF Awareness (camp-002) came in below the 2.0x ROAS target at 1.35x. Recommend lowering its daily budget (RM25 -> ~RM15) or refreshing the creative with a how-to demo before scaling.",
      "..."
    ],
    "missing_data": "..."
  }
}
```

The dashboard is for human review only. It never launches campaigns or spends money.

## Output Structure

Each run creates a new dated folder to preserve history:

```
bizpilot/module-c/outputs/
├── 2026-10-13/
│   ├── weekly_content_plan.md
│   ├── content_calendar.md
│   ├── campaign_tracker.md
│   ├── weekly_summary.md
│   ├── compliance_report.md
│   ├── approvals_needed.md
│   ├── marketing_metrics.json
│   ├── campaign_costs.csv
│   ├── marketing_topics.json
│   └── visuals/
│       ├── make_visuals_2026-10-13.py
│       ├── slide1_cover.png
│       ├── slide2_product.png
│       └── ...
├── 2026-10-20/
│   └── ...

bizpilot/shared/
├── marketing_metrics.json      ← latest run copy
├── campaign_costs.csv          ← latest run copy
├── marketing_topics.json       ← latest run copy
├── module_b_stock_levels.json  ← written by Module B
├── module_e_review_sentiment.json ← written by Module E
└── module_d_sales_by_product.csv ← written by Module D
```

Nothing from earlier weeks is overwritten.

## Bundled Resources

### assets/brand/
Brand configuration files copied from the BizPilot project. These define the business, products, compliance rules, and design style.

### assets/fonts/
Three font files (Outfit-Bold.ttf, InstrumentSans-Regular.ttf, InstrumentSans-Bold.ttf) used by the visual generator. Bundled so the skill works on any teammate's laptop without external font dependencies.

### scripts/generate_visuals.py
Portable Python script that generates marketing PNGs. Takes an output directory as its first argument and optionally a `--brand` path. All font paths resolve relative to the script location.

### scripts/generate_studio.py
Helper that regenerates `bizpilot/module-c/ui/marketing_studio.html` from a `marketing_studio_data.json` file. Reads the JSON, embeds it inline as `STUDIO_DATA`, and writes a fully data-driven dashboard (posts, campaigns, charts, compliance, approvals) that works from `file://` with no server. Used in Step 11.

It also runs `compute_and_validate(data)` before rendering, which **enforces the simulation rules**: it recomputes `analytics.kpi` and the top-level `kpi` totals by summing `previous_week.campaign_results` rows (so totals always equal the row sums, and ROAS = revenue ÷ spend), then prints warnings if any campaign ROAS falls outside 0.8x–4.0x, if the number of below-target campaigns is not exactly one, if any current-week campaign has non-zero spend, or if no recommendation references the below-target campaign.

### references/data_contract.md
Documents the file formats for cross-module data (Module B stock levels, Module D sales, Module E sentiment). Read this when interpreting shared data files.

### references/compliance_checklist.md
Step-by-step compliance checklist to run against all generated content. Read this during Step 8.

## Skills to Invoke During the Workflow

| Step | Skill | Purpose |
|------|-------|---------|
| 4 | `humanizer` | Make English captions sound natural, not AI-generated |
| 4 | `marketing-content-localization` | Produce accurate Malay translations |
| 5 | `canvas-design` (optional) | If generating more advanced visuals beyond the script template |

## Key Rules

1. **Never publish, launch ads, or spend money** — all outputs are DRAFT
2. **Never promote out-of-stock products**
3. **Never repeat last week's topics** — rotate content pillars and product focus
4. **All content must be bilingual** EN + Malay
5. **All prices must match** brand_profile.json
6. **Every number must be labelled** actual / estimated / forecast / DEMO DATA. Simulated previous-week results use the stricter label **"DEMO DATA - simulated"** and must never be mixed with actual Module D data.
7. **Each run goes in a new dated folder** — never overwrite previous weeks
8. **Do not ask mid-way** — make assumptions, note them, continue
9. **Industry/benchmark claims in forecasts must be sourced or flagged** — cite a URL, or label them **"AI estimate, not sourced"**
10. **Dashboard simulation separation & KPI-sum invariant** — the Marketing Studio dashboard NEVER attaches simulated results to current-week campaigns (caps-only, `spend: 0`, DRAFT). Simulated previous-week results live only in `previous_week.campaign_results` (Analytics tab, under previous week's names). Each row's **revenue = conversions × unit_price** (bundle price for bundles), and every analytics total equals the sum of the campaign rows, with **ROAS = revenue ÷ spend**; simulated ROAS stays within 0.8x–4.0x with exactly one campaign below the 2.0x target and an AI recommendation to fix it.
11. **Day-of-week consistency in titles/captions** — If a post title or caption mentions a day of the week, it must match the scheduled day. Otherwise use a title with no day name.
12. **Routine step labels must match actual product use** — Leave-on products (serum, toner, moisturizer) never include a "Rinse" step. Only wash-off products (cleanser, clay mask) can include "Rinse". Step labels on visuals and in captions must reflect this accurately.
13. **Single source of truth = `bizpilot/shared/business_profile.json`** — Module C must read products, prices, and campaign IDs from this file (not hand-keyed). Campaign IDs are unique across all weeks: the current week uses `camp-005`..`camp-008`; the previous week's simulated results keep `camp-001`..`camp-004`. Every new run continues the `camp-XXX` sequence without reusing an old ID. The current week's dashboard `campaigns` array must use the current week's IDs; previous-week simulated results in `previous_week.campaign_results` keep their own IDs.
14. **Where-to-buy text uses sales_channels only** — When a caption or CTA says where to buy, use only the sales_channels in business_profile.json (display as 'Shopee' and 'TikTok Shop'). Never name a marketing-only platform (Instagram, Facebook) as a place to buy.
