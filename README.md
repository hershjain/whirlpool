# Whirlpool

A personal SMS capture inbox: text it a link, a thought, or an idea and it's
silently saved, summarized, and tagged with Claude. It only replies when you
actually ask it something — a question about what you've saved, or one of
its commands.

## How it works

- **Capture**: text anything — a link or a plain thought — and Whirlpool
  saves it with no reply. Links get fetched and their article text extracted
  (falling back to metadata for JS-heavy sites like Instagram/Twitter, or
  paywalled articles); plain text is saved as-is. Either way, Claude Haiku
  summarizes and tags it in the background. If something goes wrong while
  saving, you *do* get a reply — errors are never silent, only success is.
- **Ask**: text a question about what you've saved (Claude decides whether
  a message is a capture or a question) → Claude searches your saved items
  itself via tool use and answers conversationally.
- **Digest**: text "digest" or "recap" → Claude writes a short recap
  resurfacing recent and older saves. On-demand only — nothing is sent
  automatically.
- **list** / **recent**: your 5 most recent saves.
- **search \<term\>**: keyword search across your saves.

Prompts live in `prompts/*.md` as versioned files — edit them directly to
tune tone/behavior; the version marker in each file is logged alongside
every enrichment/chat/digest so you can compare results across prompt
changes later.

## Requirements

- A [Twilio](https://console.twilio.com) account with a phone number
  (SMS-capable)
- An [Anthropic API key](https://console.anthropic.com)
- Node.js 20+

## Setup

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Configure environment**

   ```bash
   cp .env.example .env
   ```

   Fill in:
   - `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` — from
     the Twilio console
   - `OWNER_PHONE_NUMBER` — your own phone number, in E.164 format
     (`+1XXXXXXXXXX`). Only messages from this number are processed.
   - `ANTHROPIC_API_KEY` — from the Anthropic console
   - `PUBLIC_BASE_URL` — the public HTTPS URL this app will be reachable at
     (see deployment below). Used to validate that inbound webhook requests
     really came from Twilio.

3. **Set up the database**

   ```bash
   npx prisma migrate dev
   ```

   This creates a local SQLite file at `prisma/dev.db` (path controlled by
   `DATABASE_URL` in `.env`).

4. **Run it**

   ```bash
   npm run dev
   ```

5. **Point Twilio at it.** In the Twilio console, under your phone number's
   messaging configuration, set the webhook for "A message comes in" to:

   ```
   https://<your-public-url>/webhook/sms
   ```

   For local testing before you've deployed anywhere, expose your local
   server with a tunnel (e.g. `cloudflared tunnel --url http://localhost:3000`)
   and use the tunnel's URL for both `PUBLIC_BASE_URL` and the Twilio webhook
   — Twilio needs a real public HTTPS URL to reach you, even in development.

## Deployment (Fly.io)

```bash
fly launch        # creates the app, generates fly.toml
fly volumes create whirlpool_data --size 1
fly deploy
```

Attach the volume to `/data` in `fly.toml` and point `DATABASE_URL` at
`file:/data/dev.db` so the SQLite file survives deploys/restarts. Set your
`.env` values as Fly secrets instead of a committed file:

```bash
fly secrets set TWILIO_ACCOUNT_SID=... TWILIO_AUTH_TOKEN=... \
  TWILIO_PHONE_NUMBER=... OWNER_PHONE_NUMBER=... ANTHROPIC_API_KEY=... \
  PUBLIC_BASE_URL=https://<your-app>.fly.dev
```

Then update the Twilio webhook to point at your `.fly.dev` URL.

## A nice-to-have, not built into this MVP

Plain SMS has no app icon. To get something closer to a branded contact in
your Messages app, you can manually send yourself a vCard (`.vcf`) with a
"Whirlpool" name and photo the first time you text the number — iOS/Android
will offer to save it as a contact, and future messages will show that name
and photo. Not automated here; worth adding later if you want the polish.

## Notes on scope

- Images/MMS are not handled in this MVP — only links and text.
- Instagram and paywalled links will often only capture a title/caption
  (see `content_fidelity` on each saved item) rather than full content —
  this is a platform-access limitation, not something more prompting can
  fix. The original link is always preserved.
