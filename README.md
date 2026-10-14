<div align="center">

# 🚀 BizPilot

### SME operations agent powered by WorkBuddy

**One goal in. Real work done. You approve what matters.**

[![Live Demo](https://img.shields.io/badge/Live_Demo-biz--pilot--eight.vercel.app-FF6B35?style=for-the-badge&logo=vercel&logoColor=white)](https://biz-pilot-eight.vercel.app)
[![DORMATHON 2026](https://img.shields.io/badge/DORMATHON_2026-Track_2_·_WorkBuddy-8A2BE2?style=for-the-badge)](#)

![Tencent WorkBuddy](https://img.shields.io/badge/Tencent_WorkBuddy-Agent_Runtime-0052D9?style=for-the-badge&logo=tencentqq&logoColor=white)
![React](https://img.shields.io/badge/React-20232A?style=for-the-badge&logo=react&logoColor=61DAFB)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-646CFF?style=for-the-badge&logo=vite&logoColor=white)
![Tailwind CSS](https://img.shields.io/badge/Tailwind-06B6D4?style=for-the-badge&logo=tailwindcss&logoColor=white)
![Express](https://img.shields.io/badge/Express-000000?style=for-the-badge&logo=express&logoColor=white)
![Supabase](https://img.shields.io/badge/Supabase-3FCF8E?style=for-the-badge&logo=supabase&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white)

![Shopee](https://img.shields.io/badge/Shopee-EE4D2D?style=flat-square&logo=shopee&logoColor=white)
![Lazada](https://img.shields.io/badge/Lazada-0F146D?style=flat-square)
![TikTok Shop](https://img.shields.io/badge/TikTok_Shop-000000?style=flat-square&logo=tiktok&logoColor=white)
![Meta](https://img.shields.io/badge/Meta-0467DF?style=flat-square&logo=meta&logoColor=white)
![MyInvois](https://img.shields.io/badge/LHDN_MyInvois-003876?style=flat-square)
![EasyParcel](https://img.shields.io/badge/EasyParcel-F7941D?style=flat-square)
![SMTP](https://img.shields.io/badge/SMTP-555555?style=flat-square&logo=maildotru&logoColor=white)

</div>

<!-- 📸 Tip: drop a screenshot or GIF of the Command Centre here — it's the single biggest visual upgrade.
<p align="center"><img src="docs/screenshots/command-centre.png" width="85%" alt="BizPilot Command Centre"></p>
-->

---

## 🧭 What it does

BizPilot runs the day-to-day operations of a **Malaysian SME** (online, retail or both):

| | Area | | Area |
|:-:|---|:-:|---|
| 📦 | Inventory | 🧾 | Invoices & LHDN e-invoicing |
| 🤝 | Suppliers & purchasing | 💰 | Expenses & P&L |
| 🛒 | Sales from Shopee / Lazada / TikTok Shop / POS | ⭐ | Reviews & support |
| 🚚 | Courier booking | 📣 | Marketing content |

> [!NOTE]
> **All data is real (Supabase); there is no sample data.**

---

## 🤖 WorkBuddy is the execution engine

The owner types **one goal** in the Command Centre. BizPilot's server hands it to the WorkBuddy agent runtime together with **39 BizPilot tools**. WorkBuddy shares a plan, calls the tools on the business's real records, retries when a tool reports an error, and finishes with a summary. Every step streams live into the Command Centre and is saved to `agent_tasks`.

```mermaid
sequenceDiagram
    autonumber
    actor O as 👤 Owner
    participant CC as 💬 Command Centre
    participant S as ⚙️ BizPilot server
    participant W as 🤖 WorkBuddy runtime
    participant AP as ✅ Approvals
    participant X as 🌐 External API

    O->>CC: Types one goal
    CC->>S: Goal
    S->>W: Goal + 39 BizPilot tools
    W-->>CC: Shares a plan (streams live)
    loop Every step
        W->>S: Calls tools on real records
        S-->>W: Result (retries on error)
    end
    W-->>CC: Summary (saved to agent_tasks)
    W->>AP: Risky action becomes an approval
    O->>AP: Accepts
    AP->>X: Only then does the server call the API
```

> [!IMPORTANT]
> Anything risky — **POs, price changes, posts, customer emails, e-invoices, courier bookings, stock corrections** — becomes an approval the owner accepts in **Approvals**; only then does the server call the external API.

---

## 🏗️ Architecture

```mermaid
flowchart LR
    B["🖥️ Browser<br/>(React)"] -->|"Supabase Auth + RLS"| DB[("🗄️ Supabase<br/>Postgres")]
    B --> S["⚙️ BizPilot server<br/>(Express)"]
    S -->|"service role,<br/>per-business lock"| DB
    S --> W["🤖 WorkBuddy runtime<br/>@tencent-ai/agent-sdk<br/>+ BizPilot MCP tools"]
    S --> A["✅ Approvals executor"]
    S --> M["🛒 Marketplace sync"]
    S --> P["🧾 POS bridge<br/>token-authenticated<br/>sales endpoint"]
    A --> A1["Meta · MyInvois<br/>EasyParcel · SMTP"]
    M --> M1["Shopee · Lazada<br/>TikTok Shop"]

    classDef client fill:#61DAFB,stroke:#20232A,color:#20232A
    classDef server fill:#7C3AED,stroke:#4C1D95,color:#fff
    classDef db fill:#3FCF8E,stroke:#166534,color:#0b2e1c
    classDef agent fill:#0052D9,stroke:#002E7A,color:#fff
    classDef ext fill:#F97316,stroke:#9A3412,color:#fff
    class B client
    class S,A,M,P server
    class DB db
    class W agent
    class A1,M1 ext
```

---

## 🌐 Put it online

See **[DEPLOY.md](DEPLOY.md)**: web app on **Vercel**, server + WorkBuddy engine on **Render**.

---

## 💻 Run it locally

1. 🗄️ **Database:** follow [SUPABASE_SETUP.md](SUPABASE_SETUP.md) (run `supabase/schema.sql`).
2. 🔑 **Web app env:** copy `.env.example` → `.env` and fill in the Supabase URL and anon key.
3. 🔐 **Server env:** copy `server/.env.example` → `server/.env` and fill in `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.
4. ⚙️ **Start the server:**
   ```bash
   cd server && npm install && npm start   # port 4000
   ```
5. 🖥️ **Start the app:**
   ```bash
   npm install && npm run dev              # → http://localhost:5173
   ```
6. 🤖 **Once only**, sign the server in to BizPilot's WorkBuddy account:
   ```bash
   cd server && npm run workbuddy:login
   ```
   > [!TIP]
   > Users never see this; the whole app runs on that one account.
7. 🔌 Add integrations in **Settings → Integrations** (see [INTEGRATIONS_SETUP.md](INTEGRATIONS_SETUP.md)).
8. 🎯 Go to **Command Centre** and give WorkBuddy a goal.

---

## 🗂️ Where things live

| Path | What |
|---|---|
| 📁 `src/lib/ops.ts` | All business operations (stock, POs, sales, invoices, approvals…). Shared by the UI, the server and WorkBuddy's tools. |
| 📊 `src/lib/metrics.ts` | KPIs, P&L, reorder logic, review stats — computed from real records. |
| 🔄 `src/lib/db/remote.ts` | Supabase load / diff / save of a business workspace. |
| 🤖 `server/src/agent/` | WorkBuddy sign-in, tool definitions, task runner. |
| 🌐 `server/src/providers/` | Real API clients: Shopee, Lazada, TikTok Shop, EasyParcel, MyInvois, Meta, SMTP. |
| ✅ `server/src/lib/execute.ts` | What happens when an approval is approved. |
| 🗄️ `supabase/schema.sql` | Tables, Row Level Security, indexes. |

---

## 🛡️ Safety model (blueprint §12)

| Level | WorkBuddy can… |
|:-:|---|
| 🟢 **1** | Read and recommend only. |
| 🟡 **2** | Draft — every risky action needs approval. |
| 🔵 **3** | Run low-risk POs, review replies and stock corrections **under the approval limit** automatically. |

> [!WARNING]
> - WorkBuddy has **no shell, file or web access**: only BizPilot tools, scoped to the signed-in business.
> - Integration secrets are **only readable by the server** (RLS with no client policy) and never returned to the browser.
> - Every change is written to the **audit log** with who did it (owner, WorkBuddy agent, POS, scheduler).

---

## 👥 Team

| Member | GitHub | Role |
|---|---|---|
| Ng Wei Bin | [@ngweibin050-dev](https://github.com/ngweibin050-dev) | |
| Jian Cheng | [@JianCheng929](https://github.com/JianCheng929) | |
| Lee Kok Meng | <!-- TODO: GitHub handle --> | |
| Lew Sean Yew | <!-- TODO: GitHub handle --> | |

<div align="center">

Built in 24 hours at **DORMATHON 2026** · Track 2: WorkBuddy — Agentic Solutions

</div>
