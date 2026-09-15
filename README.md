# Whirlpool

An SMS capture inbox: text it a link, a thought, or an idea and it's silently
saved, summarized, and tagged with Claude. It only replies when you actually
ask it something — a question about what you've saved, or one of its commands.

Each phone number is its own account with its own saves. There is no sign-up
form: the first text from a number creates the account, and that message is
also the opt-in record. The web canvas is reached by logging in with a code
sent to the same number.

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
- **STOP** / **START**: opt out of and back into messages. Recognised as whole
  messages only, so "stop doing that" is still saved as a thought.

## One app, four paths

The landing page, the privacy policy, the login form and the canvas are all
served by the same Express process out of `public/`:

| Path | What |
|---|---|
| `/` | landing page |
| `/privacy` | privacy policy |
| `/login` | phone-code login |
| `/app` | the canvas, behind a session |

Keeping them on one origin is not only tidiness: the session cookie is set by
the API, and a cookie set on one origin cannot be read from another without
`SameSite=None`, which browsers are steadily switching off. One origin means
every link is relative and works in every environment with no configuration.
See `docs/site.md` for the routing rules and the two filenames that had to be
renamed when the sites merged.

## Logging in to the canvas

There is no password. `/login` takes a phone number, the server sends a
six-digit code to it, and entering the code sets a 30-day session cookie
scoped to that number. Everything under `/api` reads the phone off that
session, so two people who log in see two different boards.

Only a number that has already texted Whirlpool can get a code. That
prerequisite is stated on the login page, because the endpoint deliberately
cannot say so itself: it answers identically whether or not the number is
known, or is rate limited, or opted out. Anything else would turn it into a
way to ask "does this person use Whirlpool", which for a product made of what
someone reads is worth not answering.

**Codes are not sent until Twilio A2P registration is done.** US carriers drop
messages from unregistered long codes. Until then run with
`LOGIN_CODE_TRANSPORT=console`, the default, and the code is printed to the
server log instead — the whole flow works, it just does not use a carrier. Set
`LOGIN_CODE_TRANSPORT=sms` when a registered sender exists. The server refuses
to boot in console mode under `NODE_ENV=production`, so the dev path cannot
ship by accident.

Before submitting an A2P campaign, note that the reasons it gets rejected are
usually on the public site rather than in the code. The landing page now carries the
opt-in description, the "Msg & data rates may apply. Reply STOP to opt out,
HELP for help" disclosure and a privacy policy for that reason. One thing to
get right on the form: this number sends both a login code and conversational
replies, so a campaign registered as pure 2FA is a use-case mismatch.

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
- Login codes are only sent to +1 numbers. The allowlist is in `src/phone.ts`
  and exists to close off SMS pumping, where someone drives thousands of code
  requests at premium ranges they earn a cut of and leaves you the bill.
- Rate limits live in memory, so they reset on deploy. Fine for one process on
  one machine; move them to the database before running more than one.
- A phone number is the whole identity, so the usual caveat applies: anyone who
  controls the number — a SIM swap, or an unlocked phone on a table — can read
  the code and get in. Appropriate for a personal reading inbox, worth knowing
  you have accepted.
- Instagram and paywalled links will often only capture a title/caption
  (see `content_fidelity` on each saved item) rather than full content —
  this is a platform-access limitation, not something more prompting can
  fix. The original link is always preserved.
