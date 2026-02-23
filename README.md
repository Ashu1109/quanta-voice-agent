CREATE TABLE public.leads (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
  full_name text,
  email text,
  company text,
  use_case text,
  budget text,
  timeline text,
  raw_transcript jsonb,
  call_duration_sec integer,
  call_status text
);

# Quanta AI Lab — Inbound Voice Lead Qualification Agent

AI-powered phone agent that answers inbound calls 24/7, qualifies leads via natural conversation, and routes data to your CRM, database, and Slack in real time.

**Stack:** ElevenLabs Conversational AI · Twilio · Node.js/Express · Claude Haiku · Supabase · HubSpot · Slack

---

## Architecture

```
Caller → Twilio → POST /incoming-call → ElevenLabs Agent (Maya)
                                              │
                                        Call ends
                                              │
                                   POST /conversation-end
                                              │
                              Claude parses transcript → JSON
                                              │
                           ┌──────────────────┼──────────────────┐
                           ▼                  ▼                  ▼
                       Supabase           HubSpot             Slack
                     (leads table)     (new contact)      (notification)
```

---

## Quick Start

### 1. Prerequisites

- **Node.js 18+** (required for built-in `fetch`)
- Accounts: [ElevenLabs](https://elevenlabs.io), [Twilio](https://twilio.com), [Supabase](https://supabase.com), [HubSpot](https://hubspot.com), [Slack](https://slack.com), [Anthropic](https://console.anthropic.com)

### 2. Install

```bash
git clone <repo-url> && cd quanta-voice-agent
npm install
cp .env.example .env   # ← fill in your API keys
```

### 3. Database Setup

Run the migration in **Supabase → SQL Editor**:

```bash
# Contents in db/migration.sql
```

### 4. ElevenLabs Agent

1. Go to **ElevenLabs → Conversational AI → Create New Agent**
2. Paste the system prompt and first message from [`agent-prompt.md`](./agent-prompt.md)
3. Copy the **Agent ID** into your `.env`

### 5. Run Locally

```bash
npm run dev                    # starts with --watch for auto-reload
# In a second terminal:
npx ngrok http 3000            # exposes localhost to the internet
```

Then configure:
- **Twilio** → Phone Number → Voice webhook → `https://<ngrok-url>/incoming-call` (POST)
- **ElevenLabs** → Agent → Webhooks → `https://<ngrok-url>/conversation-end`

### 6. Deploy to Railway

```bash
npm i -g @railway/cli
railway login && railway init && railway up
railway domain   # get your public URL
```

Set all environment variables in the Railway dashboard or CLI.

Update Twilio and ElevenLabs webhook URLs to point at your Railway domain.

---

## API Routes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check (returns uptime) |
| `POST` | `/incoming-call` | Twilio webhook — connects caller to Maya |
| `POST` | `/conversation-end` | ElevenLabs webhook — processes call data |

---

## Environment Variables

See [`.env.example`](./.env.example) for the full list. All keys are required except `SLACK_WEBHOOK_URL` and `HUBSPOT_API_KEY` (features degrade gracefully if omitted).

---

## HubSpot Custom Properties

Create these **Text** properties in HubSpot (Settings → Properties → Contact):

| Internal Name | Label |
|---|---|
| `quanta_use_case` | Use Case |
| `quanta_budget` | Budget |
| `quanta_timeline` | Timeline |

---

## License

Proprietary — Quanta AI Lab. Internal use only.
