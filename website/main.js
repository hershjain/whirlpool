/* whirlpool — hero behaviour.
 *
 * Deliberately conservative: var/function, requestAnimationFrame, and
 * transform: translate/rotate/scale only. An earlier build scaled the tiles in
 * CSS with `calc(<length> / <length>)`, which is CSS Values 4 — browsers
 * without it threw away the whole transform and dropped the tiles, unscaled,
 * into the corner. Keep the arithmetic here, in plain pixels. */

// [x, y] in the 300x200 frame; a third truthy value marks the lighter cyan.
var SQUARES = [
  [0, 49], [40, 49], [40, 89], [80, 89], [80, 65], [80, 129],
  [15, 74, 1], [55, 34, 1], [60, 120, 1],
  [120, 89], [120, 65], [160, 65], [160, 101], [200, 65], [240, 61],
  [260, 85], [260, 60], [260, 41], [155, 160], [117, 53], [157, 141],
  [197, 141], [200, 101], [237, 101], [120, 160], [120, 129],
  [177, 154, 1], [222, 54, 1], [237, 109, 1]
];

var FRAME_W = 300;  // Figma frame width
var ART_TOP = 34;   // y of the topmost square
var ART_H = 166;    // 200 - 34, the artwork's true height
var SQ = 40;        // square edge, frame units
var TOP_GAP = 0.12; // min share of the viewport kept clear for the logo
var MAX_TOP = 0.55; // ...and the artwork may not start below this

var REVEAL_HEADLINE = 1050; // matches .headline's animation-delay in style.css

var hero = document.getElementById('hero');
var field = document.getElementById('squares');
var cursorEl = document.getElementById('cursor');

var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ------------------------------------------------------------------ layout */

var nodes = SQUARES.map(function (s) {
  var d = document.createElement('div');
  d.className = 'sq' + (s[2] ? ' sq--cyan' : '');
  field.appendChild(d);
  return d;
});

var rects = [];     // each tile's centre, at rest, in hero coordinates
var tileSize = SQ;  // nominal tile size, used for effect strengths
var dotBase = 8;    // trail dot size; viewport-derived, not tile-derived,
                    // because the cursor also runs over the blank screen
var heroTop = 0;    // hero's viewport offset, cached out of the hot path

function syncHeroTop() {
  heroTop = hero.getBoundingClientRect().top;
}

function layout() {
  var vw = document.documentElement.clientWidth; // excludes the scrollbar
  var vh = hero.clientHeight;
  var k = vw / FRAME_W;                          // px per frame unit
  var artH = Math.round(ART_H * k);

  // Bottom-anchored, but never rising into the logo's space nor sinking so low
  // that it leaves a thin strip on a tall screen.
  var top = Math.max(vh - artH, Math.round(vh * TOP_GAP));
  top = Math.min(top, Math.round(vh * MAX_TOP));

  field.style.top = top + 'px';
  field.style.height = artH + 'px';

  tileSize = Math.ceil(SQ * k);
  dotBase = Math.max(7, Math.round(vw * 0.006));

  // Draw every tile larger than its nominal size and shift it back by the same
  // amount, so flush neighbours overlap by 2*pad instead of merely touching.
  // Without this, any per-tile motion tears a white seam straight through what
  // should read as one solid mass.
  var pad = Math.max(3, Math.round(tileSize * 0.05));
  var drawn = tileSize + pad * 2;

  nodes.forEach(function (el, i) {
    var s = SQUARES[i];
    // round the position but ceil the size: neighbours then overlap by at most
    // a pixel instead of leaving a hairline seam between them.
    var x = Math.round(s[0] * k) - pad;
    var y = Math.round((s[1] - ART_TOP) * k) - pad;

    el.style.left = x + 'px';
    el.style.top = y + 'px';
    el.style.width = drawn + 'px';
    el.style.height = drawn + 'px';

    rects[i] = {
      cx: x + drawn / 2,
      cy: y + top + drawn / 2   // hero coordinates
    };
  });

  syncHeroTop();
}

layout();
window.addEventListener('resize', layout);
window.addEventListener('scroll', syncHeroTop, { passive: true });

/* -------------------------------------------------------------- typewriter */

var TYPE_TEXT = 'consume\nconciously';
var TYPE_MS = 150, ERASE_MS = 75, HOLD_FULL = 2200, HOLD_EMPTY = 700;

var typeEl = document.getElementById('type');
var n = 0;
var erasing = false;

function tick() {
  typeEl.textContent = TYPE_TEXT.slice(0, n);

  var delay;
  if (!erasing) {
    if (n < TYPE_TEXT.length) { n++; delay = TYPE_MS; }
    else { erasing = true; delay = HOLD_FULL; }
  } else {
    if (n > 0) { n--; delay = ERASE_MS; }
    else { erasing = false; delay = HOLD_EMPTY; }
  }
  setTimeout(tick, delay);
}

if (reduced) {
  typeEl.textContent = TYPE_TEXT;
} else {
  // Start as the headline fades in, not after, so the two read as one motion.
  setTimeout(tick, REVEAL_HEADLINE);
}

/* ------------------------------------------------------------------ swirl */

var pointer = {
  vx: -9999, vy: -9999,  // viewport coordinates, for the cursor
  active: false
};

var overArrow = false;
var arrowEase = 0;

// Eased state per tile, so the swirl gets a smooth approach and return.
var state = SQUARES.map(function () {
  return { dx: 0, dy: 0, rot: 0 };
});

document.addEventListener('mousemove', function (e) {
  pointer.vx = e.clientX;
  pointer.vy = e.clientY;

  if (!pointer.active) {
    pointer.active = true;
    // Only hide the native cursor once a real mouse has moved, so a touch-only
    // device never ends up in a cursorless state.
    document.documentElement.className += ' has-cursor';
  }
});

document.addEventListener('mouseleave', function () { pointer.active = false; });
document.addEventListener('mouseenter', function () { pointer.active = true; });

var EASE = 0.15;
var SWIRL_ANG = 0.6;  // radians at the very centre of the vortex

function frame(now) {
  var t = now / 1000;
  var R = tileSize * 2.2;                 // radius of influence
  var live = pointer.active && !reduced;

  var px = pointer.vx;
  var py = pointer.vy - heroTop;          // into hero coordinates

  for (var i = 0; i < nodes.length; i++) {
    var r = rects[i];
    var st = state[i];

    var tdx = 0, tdy = 0, trot = 0;

    if (live) {
      var ox = r.cx - px;
      var oy = r.cy - py;
      var dist = Math.sqrt(ox * ox + oy * oy);
      var inf = Math.max(0, 1 - dist / R);
      var eased = inf * inf;

      if (eased > 0) {
        // Rotate the tile's offset about the pointer, and draw it slightly
        // inward — the pull is what makes it read as a vortex rather than a
        // plain spin.
        var ang = SWIRL_ANG * eased;
        var ca = Math.cos(ang), sa = Math.sin(ang);
        var pull = 1 - 0.12 * eased;
        tdx = (ox * ca - oy * sa) * pull - ox;
        tdy = (ox * sa + oy * ca) * pull - oy;
        trot = ang * 28.6;                // (ang/2) in degrees
      }
    }

    st.dx += (tdx - st.dx) * EASE;
    st.dy += (tdy - st.dy) * EASE;
    st.rot += (trot - st.rot) * EASE;

    nodes[i].style.transform =
      'translate(' + st.dx.toFixed(2) + 'px,' + st.dy.toFixed(2) + 'px) ' +
      'rotate(' + st.rot.toFixed(2) + 'deg)';
  }

  updateCursor();
  requestAnimationFrame(frame);
}

/* --------------------------------------------------------- trail cursor */

var TRAIL = 6;
var dots = [];
var trailPos = [];

for (var d0 = 0; d0 < TRAIL; d0++) {
  var d = document.createElement('div');
  d.className = 'cursor__dot';
  cursorEl.appendChild(d);
  dots.push(d);
  trailPos.push({ x: -9999, y: -9999 });
}

function updateCursor() {
  var show = pointer.active && !reduced;

  cursorEl.style.display = show ? 'block' : 'none';
  if (!show) return;

  // Ease the hover cue so the dots swell rather than snap.
  arrowEase += ((overArrow ? 1 : 0) - arrowEase) * EASE;
  var size = dotBase * (1 + arrowEase * 0.6);

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

requestAnimationFrame(frame);

/* ------------------------------------------------------------------- arrow */

var arrow = document.getElementById('arrow');
var blank = document.getElementById('blank');

arrow.addEventListener('mouseenter', function () { overArrow = true; });
arrow.addEventListener('mouseleave', function () { overArrow = false; });

arrow.addEventListener('click', function () {
  arrow.classList.add('arrow--dive');
  blank.scrollIntoView({ behavior: 'smooth' });
});

// Coming back to the top brings the arrow back.
window.addEventListener('scroll', function () {
  if (window.scrollY < window.innerHeight * 0.5) {
    arrow.classList.remove('arrow--dive');
  }
}, { passive: true });
