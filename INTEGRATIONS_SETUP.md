# Integrations setup

Enter credentials in **Settings → Integrations**, click **Save**, then **Test connection**
(or **Connect** for marketplaces). Credentials are stored on the server per business.
Values in `server/.env` act as defaults (see `server/.env.example`).

> Marketplace OAuth needs the platform to redirect back to your server. Set
> `PUBLIC_SERVER_URL` in `server/.env` to a public HTTPS URL (deployed server, or a tunnel
> such as `cloudflared tunnel --url http://localhost:4000`) and register the callback URL
> shown on each card in that platform's developer console.

## WorkBuddy (AI engine)
BizPilot runs on one built-in WorkBuddy account; users never sign in. The operator signs the
server in once: `npm run workbuddy:login` (local) or at `/admin/workbuddy` on the
cloud server (see DEPLOY.md).
If you have the WorkBuddy desktop app you can point `CODEBUDDY_CODE_PATH` at its bundled CLI.

## Shopee (orders + reviews)
1. https://open.shopee.com → create an app (Seller in-house system) → get **Partner ID** and **Partner Key**. Use the test-stable keys + `SHOPEE_ENV=sandbox` while testing.
2. Set the redirect URL domain to your `PUBLIC_SERVER_URL`.
3. In BizPilot: enter Partner ID/Key → **Connect Shopee** → log in as the shop and authorise.
4. **Sync now** imports orders from the last 30 days (then incrementally) and buyer reviews.
5. Map products: Inventory → Edit product → Channel SKUs → the Shopee SKU, so imported orders deduct the right stock.

## Lazada (orders)
1. https://open.lazada.com → create an app → **App Key** and **App Secret**; set the callback URL shown in BizPilot.
2. Enter them → **Connect Lazada** → authorise the seller account (Malaysia).
3. Reviews are not imported from Lazada yet.

## TikTok Shop (orders)
1. https://partner.tiktokshop.com → create a custom app → **App Key**, **App Secret**, **Service ID**. Set the app's redirect URL to the callback URL shown in BizPilot.
2. Enter them → **Connect TikTok Shop** → authorise the shop.

## Your own website

For a shop site the business already runs (self-hosted, WooCommerce, Shopify or custom). No developer app is needed.

1. Settings → Integrations → **Your own website**: enter the site address (and an API key only if the site's data needs one), then **Save**.
2. Click **Test connection**. BizPilot looks over the site and lists the data it found (for example `/api/products`, `/api/stock`, `/api/orders`).
3. The first successful test starts BizPilot's agent by itself. It reads the site and fills in products, opening stock, prices, suppliers, orders and delivery options, without double counting. **Import again** re-reads it any time, and the daily autopilot keeps it in step.

BizPilot only reads public addresses on the saved site, never local or private ones. Text read from the site is treated as data, not instructions. Price changes to products that already exist still wait in Approvals.

## EasyParcel (courier rates, booking, tracking)
1. https://easyparcel.com/my → Integrations → API → copy the **API key**. Top up the wallet; bookings are paid from it.
2. Set your **ship-from postcode** in Settings → Business profile.
3. In Finance → Sales, an order with a delivery address and postcode can be quoted and booked. Booking needs your approval.

## LHDN MyInvois (e-invoice)
1. MyInvois portal (sandbox: https://preprod.myinvois.hasil.gov.my) → register an ERP system → **Client ID** and **Client Secret**.
2. Fill in Settings → Business profile → Tax & e-Invoice: registered name, TIN, SSM no., SST no. (or NA), MSIC code + description, address, phone, email.
3. Invoice → **Submit e-invoice** creates an approval; approving it submits the UBL 2.1 JSON document (v1.0) and fetches the validation result and QR link.
4. Keep `MYINVOIS_ENV=sandbox` until LHDN approves you for production.

## Facebook & Instagram
1. Your Facebook Page must be linked to an Instagram Business/Creator account (for Instagram).
2. https://developers.facebook.com → create an app → Graph API Explorer → get a **Page access token** with `pages_manage_posts`, `pages_read_engagement` and `instagram_content_publish`. Exchange it for a long-lived token.
3. Enter Page ID + token → **Test connection**.
4. Approved posts publish immediately if their scheduled time has passed, otherwise the server publishes them on time. Instagram posts need a public image URL.

## Email (SMTP)
Gmail: turn on 2-step verification → create an **App password** → host `smtp.gmail.com`, port 587, username = your address, password = the app password.
Used to send invoices, POs to suppliers (after approval) and approved customer emails.

## POS / till
Settings → POS → **Create token**. Your POS or till app posts each sale to
`POST /api/pos/sales` with `Authorization: Bearer <token>` (example on the page). Items are
matched by SKU or barcode and stock is deducted immediately.
