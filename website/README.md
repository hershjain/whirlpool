# whirlpool — product website

Static marketing site for Whirlpool. Plain HTML/CSS/JS, no build step. Drop new
pages and assets in this folder as they're designed.

## Files

- `index.html` — landing / hero, markup only
- `main.js` — layout, typewriter, tile + cursor interaction
- `style.css` — everything visual

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

## Interaction

- **Swirl** — tiles near the pointer rotate around it and are drawn slightly
  inward, falling off with distance. `frame()` in `main.js`.
- **Trail cursor** — site-wide. The native cursor can't be animated (`cursor:
  url()` is static only), so it's hidden via the `has-cursor` class and six
  trailing dots follow the pointer instead. The element is a **body-level child
  with `position: fixed`** — inside `#hero` it would be clipped by that
  section's `overflow: hidden` and missing from screen 2.
- **Load-in reveal** — wordmark, tagline, arrow, then headline fade up in turn,
  as CSS animations with `both` fill so nothing flashes before its delay. The
  arrow and headline animate opacity only, since both already own a `transform`
  that a `translateY` would clobber. `REVEAL_HEADLINE` in `main.js` keeps the
  typewriter's start in sync with the headline's delay — change both together.

## Local preview

```bash
python3 -m http.server -d website 8080
# then open http://localhost:8080
```
