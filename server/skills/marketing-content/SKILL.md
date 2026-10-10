---
name: marketing-content
description: Use for any marketing work: planning a week or month of posts, captions, hashtags, carousels, promotional videos (scripts, storyboards, shot lists), ads and campaigns, or reviewing marketing results and what to change.
---

# marketing-content: plan, create and measure marketing (Marketing Studio)

Do the work yourself and save everything in BizPilot. Posts are saved as drafts. Only
publishing and ad spending go to the owner for approval. Work fast: make the reads in
step 1 in parallel and don't explain your steps.

## 1. Context (one parallel batch)

- `get_business_overview`: brand voice, audience, prohibited claims, mode, and connected
  integrations (Meta = Facebook/Instagram auto-publish).
- `get_business_profile` for the brand details.
- `list_products` (stock levels) and `sales_report` (best sellers and slow movers,
  last 30 days).
- `list_marketing` for content already planned or published, so nothing is duplicated,
  and for campaign results.

Defaults when the brand profile is empty (mark them ASSUMED in your summary):
- voice: friendly and simple;
- languages: English plus a Malay version;
- audience: Malaysian shoppers of this category.

## 2. Choose what to promote

Priority order:
1. New launches.
2. Best sellers that have stock (at least 2 weeks of cover).
3. Slow movers with plenty of stock (bundle or offer ideas).
4. Seasonal moments in Malaysia within the next 3 weeks, such as payday (25th–1st),
   school holidays, Hari Raya, CNY, Deepavali, Christmas, 11.11 and 12.12, Merdeka or
   Malaysia Day. Check the date with WebSearch if unsure.

Never promote items that are out of stock or have less than 1 week of cover.

## 3. Weekly plan (Workflow C)

For a week, create 5–7 pieces Monday to Sunday with `draft_content`
(`requestPublish: false`):
- Mix: about 3 posts, 1 carousel, 1 video_script, and 1 ad if a campaign is running.
- Platforms: Facebook/Instagram for Retail or Hybrid; TikTok/Instagram for Online.
  LinkedIn only for B2B.
- Times (MYT): weekdays 12:30 or 20:30, weekends 10:00 or 21:00. Pass ISO dates with
  the +08:00 offset.
- Each body must contain:
  - a hook (first line);
  - 2–4 short lines of value, using only true facts from products and the brand profile;
  - a call to action (Shopee link, WhatsApp, or "visit our stall at …" when known);
  - 5–10 hashtags (#MalaysiaFood-style local tags plus product tags);
  - a Malay version below the English one when Malay is a brand language.
- Title: short and internal, e.g. "Mon: Chicken satay payday promo".

## 4. Carousel

Write the body as slides: "Slide 1: … / Slide 2: …" (5–7 slides). Give each slide a
headline and one line, ending with a CTA slide.

## 5. Promotional video (C5)

Use type `video_script` with this body:
- **Concept:** one line, plus the target length (15–30 s for TikTok/Reels).
- **Script and voice-over** with timestamps (0–3 s hook, …).
- **Storyboard / shot list:** a numbered list of shots (what is on screen, angle, prop).
- **On-screen text and subtitles** (English, plus Malay if used).
- **Music mood**, 3 **title** options and a **thumbnail** idea.
- **Variants:** 9:16 for TikTok/Reels and 1:1 for the feed.

BizPilot cannot render video. Say that the script is ready to film or to hand to an
editor or a tool such as CapCut.

## 6. Campaigns and ads (C4)

- Use `create_campaign` only to draft a plan with the objective, budget and a daily cap.
  Keep the total budget within get_business_overview `cash.balance` and suggest
  10–20% of it at most.
- Never launch a campaign or raise spending yourself: tell the owner it needs their go.
- Write 2–3 ad copy variants as `ad` drafts for A/B testing.

## 7. Compliance (always)

- Never use a word from `prohibitedClaims`; the tool rejects it anyway.
- Make no health, cure, "best in Malaysia", or guaranteed-result claims. Never say halal
  unless the brand profile says the product is certified.
- Don't name competitors negatively.

## 8. Review results (C6)

Use `list_marketing` and `sales_report`:
- **Facts:** published versus failed posts, campaign ROAS = revenue ÷ spend, CPA = spend ÷
  conversions, and sales in the campaign dates.
- **Guesses:** clearly marked as "may be because …"; never claim a post caused a sale
  without data.
- Give 3 concrete changes for next week, such as pausing a campaign with ROAS < 1, more of
  the best format, or a new hook to test.

## 9. Finish

Answer in at most 10 lines: what was created (count by type, with dates), what is waiting
for approval, and the one thing the owner must do (for example "connect Meta to
auto-publish", or "film the video"). Tell them to review the drafts in Marketing Studio →
Post & video drafts and press **Submit for approval**. Never ask "would you like me to".
