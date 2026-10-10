---
name: bizpilot-marketing
description: "Module C weekly marketing cycle. Use when the owner says 'run this week's marketing', 'plan next week', 'generate weekly content' or 'create marketing posts', and for the Marketing Studio 'Plan next week' button. Produces 5 bilingual posts and 1 video script, draft campaigns, a compliance check, an analytics summary and an approvals list, all as drafts in BizPilot."
---

# BizPilot Marketing: the weekly marketing cycle (Module C)

This is the owner's weekly marketing workflow, adapted to BizPilot's live data and tools.
Everything is saved in BizPilot (the content calendar, campaigns and approvals), not in
files.

**Hard rule:** never publish, launch ads or spend money. Every draft_content call uses
`requestPublish: false`. Campaigns are created as drafts. Every run ends with an
"Approvals needed" list. Don't ask the owner anything mid-way: make reasonable
assumptions, note them, and continue. Work fast and make independent reads in parallel.

## Step 1: Brand and business (one parallel batch)

- `get_business_overview`: brand voice, audience, differentiators, visual style,
  languages, competitors, prohibited claims, integrations and cash.
- `get_business_profile`: the business details.
- `list_products`: names, SKUs, prices and stock. These are the **only** source of
  products and prices; never type a price by hand.

Content pillars, rotated across the week: **Education, Product Showcase, Customer
Stories, Lifestyle, Promotions.**

## Step 2: Cross-module data (same batch)

- **Inventory (Module B):** `list_products` stock, `get_reorder_suggestions` (days left).
- **Customer experience (Module E):** `list_reviews` with the sentiment for each product.
- **Finance (Module D):** `sales_report` (days 30), giving sales by product and channel.
- **Marketing history:** `list_marketing`, covering last week's posts and topics and the
  campaign results.

If any of these returns nothing, write "missing" for it and continue. List it under
Missing data at the end.

## Step 3: Decide what to push and what to avoid

- **Exclude** products that are out of stock or have less than 7 days of stock left.
- **Exclude** a product with 3 or more recent negative reviews about a serious issue
  (irritation, allergy, defect, food safety). Flag it for the owner.
- **Prioritise** products that are in stock and have positive reviews, then the best
  sellers.
- **Rotate:** the product, topic and hook must differ from last week's posts in
  `list_marketing`.

If every product is excluded, create no promotional posts. Still produce the analytics
summary and the approvals list.

## Step 4: Draft 5 posts and 1 video script for next week (Mon–Fri)

Use `draft_content` once per post, scheduled Monday to Friday of next week. Pass an ISO
date with +08:00, at good Malaysian times (12:30 or 20:30). The product decides the
platform rotation. Use Instagram, TikTok, Facebook, Instagram Reels, and Facebook +
Instagram; the platform enum allows Facebook, Instagram, TikTok, YouTube and LinkedIn.

For each post:
- Choose a pillar, a product (from step 3) and a persona (the audience in the brand
  profile).
- The body contains:
  1. an **English caption**, natural and human, with no AI clichés;
  2. a **Malay caption** in natural Bahasa Malaysia, not a word-for-word translation;
  3. **8–10 hashtags** mixing English and Malay;
  4. a **CTA** with the exact price from `list_products`. Where-to-buy may name only real
     sales channels (Shopee, Lazada, TikTok Shop, or the shop or stall); never call
     Instagram or Facebook a place to buy.
- Title: short. Name a weekday only if it matches the scheduled day.

One of the 5 is `type: video_script`, containing:
- a scene-by-scene breakdown with timings;
- the voice-over in English and Malay;
- a shot list table (scene | duration | shot type | action | text overlay);
- the specs: 9:16, 15–30 s, music mood, subtitles on;
- a thumbnail concept.

Visuals: after saving each post with `draft_content`, call `generate_image` with its
`contentId` and a detailed prompt in the brand's visual style (aspect 4:5 or 1:1 for feed,
9:16 for TikTok/Reels). Describe the real product exactly; no text, logos or prices in the
image and never fake before/after shots. If the owner gave a product photo URL, use it as
`imageUrl` instead.

Video: after the video script draft, call `make_video` with its `contentId` and 3–5 scenes
(caption plus image prompt each) so a real video is rendered and saved on the draft.

## Step 5: Campaigns (drafts only)

Draft 2–3 campaigns with `create_campaign`:
- objective, platform, a total budget and a daily cap, and start/end dates for next week;
- the combined total at or below 20% of `cash.balance`;
- daily caps that are realistic for an SME (RM10–30).

Write 2–3 ad copy variants for the main campaign as `ad` drafts.

## Step 6: Compliance check (fix before saving)

Check every caption, ad and on-image text for:
- prohibited claims from the brand profile, plus whitening, medical or cure claims,
  "guaranteed results" and "chemical-free";
- unverified claims (halal, dermatologist-tested, clinically proven, or numbers without a
  source);
- pressure tactics ("limited stock", "buy now before it's gone", fake flash-sale urgency);
- first-person testimonials that are invented (use how-to demonstrations instead);
- prices that don't match `list_products`;
- usage steps that are wrong for the product (for example, no "rinse" step for leave-on
  products).

Fix any violation in the content before calling draft_content. Report what you checked
and what you fixed.

## Step 7: Analytics summary

Report only real BizPilot numbers, and label each one:
- **actual:** from `list_marketing` campaigns or `sales_report`;
- **estimated:** calculated from partial data;
- **forecast:** your projection.

Any industry benchmark or rule of thumb (for example "TikTok outperforms static posts")
needs a source link from WebSearch or the label **"AI estimate, not sourced"**.

If there is no campaign data yet, say "No live results yet: campaigns are drafts." Never
invent or simulate results; BizPilot shows real data only. Recommend one concrete fix for
the weakest campaign (ROAS below 2.0×), such as a lower daily cap or a new how-to hook.

## Step 8: Approvals needed, and finish

Call `notify_owner` (info) with a one-line summary. Then answer with:
1. **Content:** the 5 posts and the video (day, platform, title). The owner reviews them
   in Marketing Studio → Post & video drafts and presses Submit for approval.
2. **Campaigns:** each draft, with its daily and total cap.
3. **Budget:** the total proposed daily and weekly ad spend.
4. **Compliance flags:** anything that needs human judgement.
5. **Missing data** and the assumptions you made.

End with: "No content was published. No ads were launched. No money was spent. All items
above require your approval before action."
