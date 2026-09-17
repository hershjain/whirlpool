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
six-digit code to it, and entering the code sets a session cookie scoped to
that number. The cookie carries no expiry, so the browser drops it when it
quits, and the session row expires after 24 hours regardless of what the
browser chose to keep. Everything under `/api` reads the phone off that
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
- A Postgres database. Any will do; [Neon](https://neon.tech) and
  [Supabase](https://supabase.com) both have a free tier that fits this.
- Node.js 20+
- Optionally a [Sentry](https://sentry.io) project. Without a DSN errors are
  still logged, they just do not page anyone.

## Setup

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Configure environment**

   ```bash
   cp .env.example .env
   ```

   `.env.example` documents every variable. The ones without an obvious value:

   - `PUBLIC_BASE_URL` — the origin this app is reachable at. **A bare origin:
     no path, no trailing slash.** Three things read it — Twilio webhook
     signature validation, the `Origin` allowlist that rejects cross-site
     writes, and the domain in the login text's one-time-code line, which must
     match the origin serving `/login` or iOS won't offer to autofill it. The
     server refuses to boot on a malformed value rather than letting you
     discover it as silent 403s.
   - `DATABASE_URL` — a Postgres connection string. Locally, a container:

     ```bash
     docker run -d --name whirlpool-pg -p 5432:5432 \
       -e POSTGRES_PASSWORD=whirlpool -e POSTGRES_DB=whirlpool postgres:16
     ```

   - `OWNER_PHONE_NUMBER` — the number the DEV-LOGIN shortcut signs in as.
     Nothing else reads it, and it comes out when DEV-LOGIN does.

3. **Set up the database**

   ```bash
   npx prisma migrate dev
   ```

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
   — Twilio needs a real public HTTPS URL to reach you, even in development.

   Rather than editing `.env` back and forth, keep it on localhost and put the
   tunnel-only settings in `.env.tunnel`:

   ```bash
   npm run dev          # localhost, DEV-LOGIN available
   npm run dev:tunnel   # .env.tunnel layered over .env
   ```

   `--env-file` loads `.env.tunnel` before `dotenv` reads `.env`, and `dotenv`
   does not overwrite what is already set — so the tunnel file only has to carry
   what differs, and secrets stay in one place. What differs is the tunnel
   hostname (update it each session; these rotate) and `NODE_ENV=production`,
   which an https origin requires: the boot guard in `src/config.ts` refuses to
   run as development on a public hostname, where DEV-LOGIN would be an open
   auth bypass. So in tunnel mode you sign in with a real code — printed to the
   server log while `LOGIN_CODE_TRANSPORT=console` — and the session cookie gets
   `Secure`, meaning you must use the tunnel URL in the browser rather than
   `http://localhost:3000`.

## Checks

```bash
npm run typecheck   # tsc --strict, no emit
npm test            # builds, then runs node --test over test/
```

The suite is deliberately narrow: it covers the SSRF guard in
`src/safeFetch.ts`, where a subtle mistake is a working read primitive against
the private network. Everything else is still unverified — see "Notes on
scope".

## Deployment (Fly.io)

The repo carries its own `Dockerfile` and `fly.toml`, so **do not run
`fly launch`** — it would overwrite them.

```bash
fly auth login
fly apps create whirlpool          # the name decides your .fly.dev hostname
```

Set `app` in `fly.toml` to that name. The public origin is the custom domain,
not the `.fly.dev` host — see `docs/launch-checklist.md` for the certificate
and DNS records, which are worth starting early. Then set the secrets:

```bash
fly secrets set \
  NODE_ENV=production \
  DATABASE_URL="postgresql://..." \
  PUBLIC_BASE_URL="https://whrlpl.app" \
  ANTHROPIC_API_KEY=... \
  TWILIO_ACCOUNT_SID=... TWILIO_AUTH_TOKEN=... TWILIO_PHONE_NUMBER=... \
  OWNER_PHONE_NUMBER=... \
  SENTRY_DSN="https://...ingest.sentry.io/..." \
  LOGIN_CODE_TRANSPORT=console ALLOW_CONSOLE_CODES=1
```

`LOGIN_CODE_TRANSPORT=console` with the override is the right setting **until
A2P registration clears** — carriers drop messages from unregistered long
codes, so `sms` would send into a void. Drop both once you have a registered
sender. The server refuses to boot in console mode under `NODE_ENV=production`
without that explicit override, which is the point: the choice has to be made,
not inherited.

```bash
fly deploy
```

Migrations run automatically — `fly.toml` sets
`release_command = "npx prisma migrate deploy"`, which runs inside the built
image before the new version takes traffic. That is why `prisma` is a runtime
dependency rather than a dev one.

Then update the Twilio webhook to point at `<origin>/webhook/sms`. It has to match
`PUBLIC_BASE_URL` exactly: signature validation reconstructs the URL from that
variable rather than trusting the request, so an added trailing slash or query
string silently 403s every inbound message.

`docs/launch-checklist.md` has this as a tickable list, along with the parts
only you can do — accounts, the A2P switchover, and the end-to-end checks that
need a real handset.


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
- Rate limits are Postgres-backed, so they survive a deploy and would survive a
  second instance. They were in memory until the move off SQLite, which meant
  every deploy handed out a fresh global allowance of login codes — including to
  whoever was being limited.
- A phone number is the whole identity, so the usual caveat applies: anyone who
  controls the number — a SIM swap, or an unlocked phone on a table — can read
  the code and get in. Appropriate for a personal reading inbox, worth knowing
  you have accepted.
- The server will not fetch a private, loopback or link-local address on a
  sender's behalf, and refuses the save rather than storing a card that never
  fills in. `src/safeFetch.ts` has the ranges and the one residual risk it does
  not close (DNS rebinding between the check and the connection).
- Outbound fetches are capped at 2MB for a page and 256KB for an icon, enforced
  while reading rather than after, and a response that does not claim to be
  markup is never handed to JSDOM.
- **There are no tests beyond the SSRF guard, and no linter.** `tsc --strict`
  is the only other gate. The gap worth closing first is tenant isolation —
  `src/repo.ts` scopes every query by phone and nothing currently proves it
  stays that way. Note that TypeScript will not catch a missing `await` on a
  function used in a boolean position, which is exactly how a rate-limit check
  can silently stop working; `@typescript-eslint/no-misused-promises` is the
  rule that does.
- Search loads every item for a user into Node and substring-matches in JS
  (`searchItems` in `src/repo.ts`). Fine for a personal library, and the thing
  to replace with Postgres full-text search before it is not.
- `/api/items` returns the whole board with no pagination.
- One save makes several outbound requests — the page, then the source profile
  fetches the same page again for branding. `src/sourceProfile.ts` notes it.
- Instagram and paywalled links will often only capture a title/caption
  (see `content_fidelity` on each saved item) rather than full content —
  this is a platform-access limitation, not something more prompting can
  fix. The original link is always preserved.
