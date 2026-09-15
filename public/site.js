/* whirlpool — shared site chrome.
 *
 * Everything that belongs to every page rather than to the hero: currently the
 * trail cursor. main.js is hero-only and would throw on login.html, which loads
 * this file on its own.
 *
 * Same conservative dialect as main.js: var/function, requestAnimationFrame,
 * and arithmetic kept here in plain pixels rather than in modern CSS. */

var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

var EASE = 0.15;

/* ------------------------------------------------------------ trail cursor */

var pointer = {
  vx: -9999, vy: -9999,  // viewport coordinates
  active: false
};

// main.js reads this for the swirl; it keeps no pointer state of its own.
window.WP_CURSOR = { pointer: pointer };

var TRAIL = 6;

// Built here rather than sitting in the markup, so a new page only has to load
// this file to get the cursor. Body-level and position: fixed, so #hero's
// overflow: hidden can't clip it and it carries onto the second screen.
var cursorEl = document.createElement('div');
cursorEl.className = 'cursor';
cursorEl.setAttribute('aria-hidden', 'true');
document.body.appendChild(cursorEl);

var dots = [];
var trailPos = [];

for (var d0 = 0; d0 < TRAIL; d0++) {
  var d = document.createElement('div');
  d.className = 'cursor__dot';
  cursorEl.appendChild(d);
  dots.push(d);
  trailPos.push({ x: -9999, y: -9999 });
}

// Viewport-derived, not tile-derived: the cursor also runs over the blank
// screens, which have no tiles.
var dotBase = 8;

function sizeDot() {
  dotBase = Math.max(7, Math.round(document.documentElement.clientWidth * 0.006));
}

sizeDot();
window.addEventListener('resize', sizeDot);

document.addEventListener('mousemove', function (e) {
  pointer.vx = e.clientX;
  pointer.vy = e.clientY;

  if (!pointer.active) {
    pointer.active = true;
    // Only hide the native cursor once a real mouse has moved, so a touch-only
    // device is never left in a cursorless state.
    document.documentElement.className += ' has-cursor';
  }
});

document.addEventListener('mouseleave', function () { pointer.active = false; });
document.addEventListener('mouseenter', function () { pointer.active = true; });

// Delegated, so the swell covers the logo, both chrome buttons and the hero
// arrow with no per-element wiring — and every future page for free.
var overLink = false;

document.addEventListener('mouseover', function (e) {
  if (e.target.closest && e.target.closest('a, button')) overLink = true;
});

document.addEventListener('mouseout', function (e) {
  if (e.target.closest && e.target.closest('a, button')) overLink = false;
});

var linkEase = 0;

function updateCursor() {
  // Scheduled first: an inactive pointer returns early, and the loop has to
  // survive that to pick up again when the mouse comes back.
  requestAnimationFrame(updateCursor);

  var show = pointer.active && !reduced;

  cursorEl.style.display = show ? 'block' : 'none';
  if (!show) return;

  // Ease the hover cue so the dots swell rather than snap.
  linkEase += ((overLink ? 1 : 0) - linkEase) * EASE;
  var size = dotBase * (1 + linkEase * 0.6);

  // Each dot eases toward the one ahead of it, so quick moves leave a wake.
  for (var i = 0; i < trailPos.length; i++) {
    var target = i === 0 ? pointer : trailPos[i - 1];
    var tx = i === 0 ? target.vx : target.x;
    var ty = i === 0 ? target.vy : target.y;

    trailPos[i].x += (tx - trailPos[i].x) * (0.35 - i * 0.04);
    trailPos[i].y += (ty - trailPos[i].y) * (0.35 - i * 0.04);

    var s = Math.round(size * (1 - i * 0.12));
    dots[i].style.width = s + 'px';
    dots[i].style.height = s + 'px';
    dots[i].style.transform =
      'translate(' + (trailPos[i].x - s / 2).toFixed(1) + 'px,' +
      (trailPos[i].y - s / 2).toFixed(1) + 'px)';
  }
}

requestAnimationFrame(updateCursor);
