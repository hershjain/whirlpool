# whirlpool — product website

Static marketing site for Whirlpool. Plain HTML/CSS/JS, no build step. Drop new
pages and assets in this folder as they're designed.

## Files

- `index.html` — the whole landing page: hero, how it works, why, try now, as
  four full-viewport screens you scroll through in order
- `privacy.html` — a plain prose page, not a screen. Required for the Twilio A2P
  campaign submission and linked from the fine print on the try-now screen.
- `site.js` — shared chrome: currently the trail cursor. Loaded by every page.
- `main.js` — the landing page only: hero layout, typewriter, tile swirl, and
  the arrow / `learn more` scroll state. Loaded after `site.js`, which hands it
  the pointer via `WP_CURSOR`.
- `style.css` — everything visual
- `dithered-floyd-steinberg-1788999256128.png` — the art on the why screen,
  518x400. It renders ~340px wide on a desktop viewport, about 1.5x density, and
  is capped at 440. If you swap the file, update the `<img>`'s `width`/`height`
  **attributes** to match: they're what reserves the box before it decodes.

## Two placeholders to fill in before this goes live

Both are in `index.html` and both are currently pointing at nothing real:

- `#sms-link` — `sms:+15550100?&body=...`. Replace with the actual Twilio
  number. This link is the sign-up: there is no form anywhere in the product,
  the first text is what creates the account, so this is the top of the funnel.
  Keep the `?&body=` spelling — iOS wants the ampersand and Android tolerates
  it, while `?body=` alone fails on iOS.
- `#login-link` — `https://app.whirlpool.xyz/login`. Replace with wherever the
  Node app is deployed.

Login is **not** on this site. It is served by the app at `/login`, because the
session cookie is set by that origin and a cookie set on one origin cannot be
read by another without `SameSite=None`, which browsers are steadily switching
off. This site links out to it.

## Notes

- **Type** is Necto Mono (proprietary). [Space Mono](https://fonts.google.com/specimen/Space+Mono)
  is loaded from Google Fonts as a free stand-in; add the licensed Necto Mono
  webfont and it takes over via the `--mono` stack in `style.css`.
- The hero scales the **300×200 Figma frame** to the viewport width. Square
  coordinates live in `SQUARES` in `main.js`; the two blues are `#00C3D0` (teal)
  and `#00C0E8` (cyan).
- **Keep layout arithmetic in `main.js`, not CSS.** An earlier version scaled the
  tiles with `scale(calc(100vw / 300px))` — length-divided-by-length is CSS
  Values 4, and browsers without it discard the whole `transform` and leave the
  tiles unscaled in the corner. `layout()` emits plain pixels for that reason.
- Tiles are drawn `2 * pad` larger than their nominal size and shifted back, so
  neighbours overlap rather than merely touch. Without that, per-tile motion
  tears white seams through the field.

- **The content screens came from 300x200 Figma frames.** Those frames' font
  sizes are *frame units*, not pixels — mapping them literally gives ~48px body
  copy, since the site does not scale type at the frame ratio the way the hero
  scales its tiles. Read the frames for hierarchy and widths (the why row is
  183 + 89 of 300, which is why copy and art sit side by side) and express the
  sizes with the site's `clamp()` idiom. `--copy` is the body-copy token.
- **The user's copy is verbatim.** That includes `consume conciously` in the
  hero, "so much shit" on the why screen, and `recieve` in step (3) of the join
  copy. Don't tidy any of it without asking.
- **The why art's ratio comes from the `<img>` width/height attributes**, not
  `aspect-ratio` — attributes are the oldest, safest way to reserve intrinsic
  ratio, which matters on this project. It's a dithered image, so it carries
  `image-rendering: pixelated`; a smooth upscale muddies the dither.

## Interaction

- **Swirl** — tiles near the pointer rotate around it and are drawn slightly
  inward, falling off with distance. `frame()` in `main.js`.
- **Trail cursor** — site-wide, in `site.js`. The native cursor can't be animated
  (`cursor: url()` is static only), so it's hidden via the `has-cursor` class and
  six trailing dots follow the pointer instead. The element is built in JS as a
  **body-level child with `position: fixed`** — inside `#hero` it would be
  clipped by that section's `overflow: hidden` and missing from screen 2. It
  swells over any `a` or `button` by delegated hover, so new links need no wiring.
- **Buttons** — `.btn` is an unfilled rounded rectangle that fills with `--cyan`
  on hover and drops its outline (`border-color: transparent`, not `border: 0`,
  so the box doesn't resize). `learn more` belongs to the hero: it
  points at `#how` and fades out once you scroll past half the first screen.
  `login` sits at the foot of the page, on the try-now screen, since it is the
  only link that leaves this page. The logo is the only chrome that persists
  everywhere.
- **Arrow** — fixed, not pinned inside `#hero`, so it rides every screen as a
  standing cue that more is below. Each click advances exactly one screen
  (`nextScreen()` in `main.js`) and plays a nudge; on the last screen it hides
  itself, since there is nothing left to point at.
- **Fill modes matter here.** `.arrow` and the header button reveal with
  `backwards` fill, not `both`. `both` holds opacity at the keyframe's end value
  forever, which would beat the `.is-hidden` rule that later fades them out;
  `backwards` covers the pre-delay period and then hands opacity back to the
  declared value. If you add another element that both reveals and later hides,
  use `backwards`.
- **Load-in reveal** — wordmark, `learn more`, tagline, arrow, then headline
  fade up in turn,
  as CSS animations with `both` fill so nothing flashes before its delay. The
  arrow and headline animate opacity only, since both already own a `transform`
  that a `translateY` would clobber. `REVEAL_HEADLINE` in `main.js` keeps the
  typewriter's start in sync with the headline's delay — change both together.

## Verifying

Headless Chrome with `--virtual-time-budget` advances `setTimeout` but **not CSS
animations, CSS transitions, or scroll events**. So in that environment:

- a transitioning property reports its *start* value forever — an element with
  `transition: opacity` reads `1` even after `.is-hidden` applies, while an
  untransitioned property in the same rule (`pointer-events`) flips immediately;
- scroll handlers never run, so `window.dispatchEvent(new Event('scroll'))` is
  needed to drive them by hand;
- `scrollIntoView({ behavior: 'smooth' })` never completes.

To assert on the real cascade, neutralise the time-driven parts first
(`el.style.animation = 'none'; el.style.transition = 'none'`), or scrub an
animation with `el.getAnimations()` and set `currentTime`. Verify numerically
rather than by screenshot, then confirm in a real browser.

## Local preview

```bash
python3 -m http.server -d website 8080
# then open http://localhost:8080
```
