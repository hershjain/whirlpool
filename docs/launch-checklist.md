# Launch checklist

The things only you can do. Everything else is in the code.

Items marked ⛔ block the deploy. Tick them off as you go.

Deploy target: **whrlpl.app** (apex, registered at Namecheap), on Fly.
Sending number: **+1 716 575 3906**. Contact address: **hprmoj@gmail.com**.

---

## Y1 — Accounts and credentials ⛔

- [ ] **1. Postgres.** Create a free database on [Neon](https://neon.tech) or
      [Supabase](https://supabase.com). Copy the **pooled** connection string —
      it becomes `DATABASE_URL`.

      Fly Postgres also works but is self-managed and costs more; Neon's free
      tier is the lower-effort choice and its pooled connection string is what
      you want for a single small app.

- [ ] **2. Fly.** Log in and create the app:

      ```bash
      fly auth login
      fly apps create whirlpool      # if taken, pick another and update fly.toml
      ```

      The `.fly.dev` hostname this gives you is **not** `PUBLIC_BASE_URL` — the
      domain is. That value is `https://whrlpl.app`: a bare origin, no path, no
      trailing slash. Three things read it and all three break on a malformed
      value — Twilio webhook signature validation, the `Origin` allowlist that
      rejects cross-site writes, and the domain in the login SMS that makes iOS
      offer to autofill the code.

      **Don't run `fly launch`.** It generates a `fly.toml`, and there is
      already a proper one in the repo.

- [ ] **3. DNS and certificates.** Do this as soon as the app exists — the wait
      is the long pole, and steps 7–8 can proceed while it propagates.

      ```bash
      fly ips allocate-v4 --shared    # free; a dedicated v4 costs extra
      fly ips allocate-v6
      fly certs add whrlpl.app
      fly certs add www.whrlpl.app    # the redirect in server.ts needs its own cert
      fly certs show whrlpl.app       # prints the exact records to create
      ```

      In Namecheap → Domain List → Manage → **Advanced DNS**:

      - `A` record, host `@`, pointing at the v4 from `fly ips list`
      - `AAAA` record, host `@`, pointing at the v6
      - `CNAME`, host `www`, value `<your-app>.fly.dev`
      - plus any `_acme-challenge` CNAME that `fly certs show` asks for

      **Delete Namecheap's default parking records first.** A fresh domain
      ships with a URL Redirect record on `@` and a `CNAME www →
      parkingpage.namecheap.com`. Leaving either in place means the certificate
      never validates, and the failure mode looks like a broken deploy rather
      than a DNS problem.

      **`.app` is on the HSTS preload list.** Browsers refuse plain http to it
      unconditionally, so until the certificate is issued the site is
      unreachable — not degraded, unreachable. `fly certs check whrlpl.app`
      tells you where it actually stands; don't debug the app until that's
      green.

- [ ] **4. Sentry.** Create a free project (platform: Node.js) and copy the
      DSN. This is what turns "the app broke at 3am" from something you find
      out about days later into something that emails you.

> Tip: you can run any of these in a Claude Code session by prefixing with
> `!` — e.g. `! fly auth login` — so the output lands in the conversation.

---

## Y2 — Content ⛔

- [x] **5. The real Twilio number** — `+17165753906`, wired into the `sms:`
      link at `public/index.html:102`. That link is the only sign-up path in
      the product; there is no sign-up form anywhere.

- [x] **6. Contact address** — `hprmoj@gmail.com`, on the landing page
      fineprint and named directly in both policy pages.

- [ ] **7. Governing law.** `public/terms.html` carries a literal `[STATE]`
      placeholder in "The legal part". Fill it in before the site goes live —
      a visible placeholder on a policy page is exactly what A2P vetting
      treats as an unfinished site.

---

## Y3 — Deploy ⛔

- [ ] **8. Set the secrets.**

      ```bash
      fly secrets set \
        NODE_ENV=production \
        DATABASE_URL="postgresql://..." \
        PUBLIC_BASE_URL="https://whrlpl.app" \
        ANTHROPIC_API_KEY="sk-ant-..." \
        TWILIO_ACCOUNT_SID="AC..." \
        TWILIO_AUTH_TOKEN="..." \
        TWILIO_PHONE_NUMBER="+17165753906" \
        OWNER_PHONE_NUMBER="+1..." \
        SENTRY_DSN="https://...@...ingest.sentry.io/..." \
        LOGIN_CODE_TRANSPORT=console \
        ALLOW_CONSOLE_CODES=1
      ```

      `LOGIN_CODE_TRANSPORT` stays `console` until A2P clears (Y4) — US
      carriers drop messages from unregistered long codes, so `sms` would send
      into a void. The server refuses to boot in `console` mode under
      `NODE_ENV=production` unless `ALLOW_CONSOLE_CODES=1` is also set, which
      is deliberate: it forces the choice to be explicit rather than a
      forgotten default. Both come off at Y4.

      `OWNER_PHONE_NUMBER` is only still required because the dev-login
      shortcut is still in the codebase. It drops off when that does.

- [ ] **9. Deploy.**

      ```bash
      fly deploy
      ```

      Database migrations run automatically via the release command in
      `fly.toml` — you don't run them by hand.

- [ ] **10. Confirm the certificate issued** (`fly certs check whrlpl.app`) and
      load `https://whrlpl.app` in a browser. Check `https://www.whrlpl.app`
      redirects to the apex.

- [ ] **11. Point Twilio at it.** In the Twilio console, under the number's
      messaging configuration, set **"A message comes in"** to:

      ```
      https://whrlpl.app/webhook/sms
      ```

      Signature validation reconstructs this URL from `PUBLIC_BASE_URL` rather
      than trusting the incoming request, so a trailing slash or an added query
      string silently 403s every inbound message — with no error anywhere
      except the logs.

---

## Y4 — When A2P registration clears

- [ ] **12.** `fly secrets set LOGIN_CODE_TRANSPORT=sms` and
      `fly secrets unset ALLOW_CONSOLE_CODES`.
- [ ] **13.** Request a login code and confirm it arrives on a real handset.
- [ ] **14.** Text `STOP`, then text anything else, and confirm opt-out and
      opt-in both work against a live carrier.

**One filing hazard**: this number sends both login codes *and* conversational
replies. A campaign registered as pure 2FA is a use-case mismatch and is a
common rejection reason. Register it as what it is.

---

## Y5 — Verification only you can do

- [ ] **15.** Text a link from your own phone. Confirm it lands on the canvas
      with a summary, tags, and the source's branding on the card.
- [ ] **16.** Log in end to end on your phone's browser: request a code,
      receive it (from the Fly logs until Y4 lands), enter it, reach `/app`.
- [ ] **17.** Have one friend sign up and confirm they see only their own
      board — not yours.
- [ ] **18.** Text `http://169.254.169.254/latest/meta-data/` to the live
      number. Confirm nothing is saved. (This is the cloud metadata endpoint;
      before the SSRF guard, the server would have fetched it and shown you
      the result.)
- [ ] **19.** Run `fly deploy` a second time while the canvas is open in a
      browser. Confirm your session survives and no in-flight save is lost.

---

## Afterwards

Two things worth doing once it's live and working:

- **A test suite**, before you iterate much further. Scoped to tenant
  isolation, the auth flow, and the pure functions where bugs are quiet —
  roughly a day's work. Ask Claude to plan it.
- **Remove the dev-login shortcut** when you no longer need it. All four
  pieces are tagged `DEV-LOGIN` in the source and come out together. It's
  wired shut under `NODE_ENV=production`, but it's one env var away from being
  an authentication bypass, so it shouldn't live there forever.
