// --- The guided tour ---
//
// Runs itself once on a first visit and is replayable from the ? in the
// toolbar. The idiom is the ordinary one: dim the board, cut a lit hole around
// one thing, ring it, and float a box beside it saying what it is.
//
// Two things make this board awkward to tour, and both are answered here. A new
// user's board is empty, so there is nothing real to point at - so the card
// steps point at a fictitious card floated over the dim, built by canvas.js's
// own buildCardElement so it is the real component rather than a drawing of it.
// And the filter bar of an empty board has no chips, so the filter step seeds
// it with example ones, which are taken back out on the way through the door.

const tourStartBtn = document.getElementById("tour-start");
const tourToolbar = document.getElementById("toolbar");
const tourFilterBar = document.getElementById("filter-bar");
const tourFilterToggle = document.getElementById("filter-toggle");

const TOUR_SEEN_KEY = "whirlpool.tour.v1";
const TIP_GAP = 14; // between the ring and the box explaining it
const TIP_MARGIN = 8; // the box never comes closer than this to a screen edge
const HOLE_PAD = 8; // breathing room between a lit target and the dim
const DEMO_CARD_W = 240; // .card's width, as CARD_W in canvas.js

// A fictitious article, so the card steps work on a board with nothing on it.
// No imageUrl on purpose: nothing to fetch, and nothing that can arrive late
// and change the card's height after the hole has been drawn around it.
const DEMO_ITEM = {
  id: "__tour_demo__",
  type: "link",
  label: "Why the good ideas arrive in the shower",
  summary: "A short argument that stepping away from a problem is usually the part that solves it.",
  excerpt: null,
  isLongForm: true,
  isMusic: false,
  isVideo: false,
  isPlace: false,
  isBroken: false,
  hasPreview: true,
  imageUrl: null,
  rawUrl: null,
  author: null,
  siteName: null,
  sourceHostname: null,
  category: "ideas",
  tags: ["attention", "creativity", "deep-work"],
  folderId: null,
  folderName: null,
  canvasX: 0,
  canvasY: 0,
};

// An invented publication rather than a real one - a tour is not the place to
// put someone else's name and brand colour on a card they didn't write.
// hasIcon false, so the card asks /api/sources for nothing.
const DEMO_SOURCE = {
  hostname: "example.com",
  name: "Field Notes",
  color: "#2f3d63",
  textColor: "#ffffff",
  hasIcon: false,
};

// Each step lights one element (the hole) and rings another (what the box
// points at). `focus` defaults to `lit`; the card steps set them separately so
// the whole example card stays readable while one control on it is ringed.
// Both are resolved per step, because the example card does not exist until the
// step that shows it.
const TOUR_STEPS = [
  {
    title: "Your board",
    body: "Everything you text Whirlpool lands here as a card, and stays wherever you drag it. Scroll to move around, pinch or use the zoom controls in the corner to get closer, and click any card to open the original.",
  },
  {
    title: "Filters",
    body: "This shows and hides the bar of chips below. Hiding it also clears whatever you had filtered and closes any open folder, so the whole board comes back at once.",
    lit: () => tourFilterToggle,
    needsFilterBar: true,
  },
  {
    title: "Folders, categories and tags",
    body: "Green rectangles are folders you made. Blue chips are the tags we put on your items automatically. If we notice any similarities or threads in your cards, we create categories for you to explore.",
    lit: () => tourFilterBar,
    needsFilterBar: true,
  },
  {
    title: "A card",
    body: "Here is what a saved link turns into: the site it came from along the top, the headline, a summary, and its tags. Click it to open the original in a new tab, or drag it anywhere on the board — it stays where you put it.",
    lit: () => demoCard,
    demo: true,
  },
  {
    title: "Remove a card",
    body: "Click the x and you can remove any cards you don't need anymore.",
    lit: () => demoCard,
    focus: () => demoCard?.querySelector(".card-delete"),
    demo: true,
  },
  {
    title: "Put it in a folder",
    body: "Click the plus to manage the folder that the card lives in. Either create a new one, or add it to an existing one.",
    lit: () => demoCard,
    focus: () => demoCard?.querySelector(".card-folder"),
    demo: true,
  },
  {
    title: "Tags",
    body: "Whirlpool reads each link as it saves it and tags what it is about. Click a tag and it will show you all cards saved with that tag.",
    lit: () => demoCard,
    focus: () => demoCard?.querySelector(".card-tags"),
    demo: true,
  },
  {
    title: "That's the board",
    body: "This tour lives behind the question mark whenever you want it again.",
    lit: () => tourStartBtn,
    ringRadius: "50%", // the ? is a circle; a rounded square around it reads as a miss
  },
];

let tourOpen = false;
let stepIndex = 0;
let demoCard = null;
let blockEl = null;
let demoLayer = null;
let holeEl = null;
let ringEl = null;
let tipEl = null;
// What the tour changed about the page, so leaving can put it all back.
let restoreFilterBarHidden = null;

function buildTourChrome() {
  if (blockEl) return;

  blockEl = document.createElement("div");
  blockEl.id = "tour-block";
  // Swallows the lot: without this a drag on the dim pans the board behind it,
  // and a click lands on whatever card happens to be under the cursor.
  for (const type of ["pointerdown", "pointermove", "pointerup", "click", "wheel"]) {
    blockEl.addEventListener(type, (e) => e.preventDefault(), { passive: false });
  }

  demoLayer = document.createElement("div");
  demoLayer.id = "tour-demo";

  holeEl = document.createElement("div");
  holeEl.id = "tour-hole";

  ringEl = document.createElement("div");
  ringEl.id = "tour-ring";

  tipEl = document.createElement("div");
  tipEl.id = "tour-tip";
  tipEl.setAttribute("role", "dialog");
  tipEl.setAttribute("aria-modal", "true");
  tipEl.setAttribute("aria-labelledby", "tour-tip-title");

  document.body.append(blockEl, demoLayer, holeEl, ringEl, tipEl);
  // Give the hole a starting geometry before anything can paint, so the first
  // step opens out of the middle of the screen rather than out of `auto`.
  drawHole(null);
  drawRing(null);
}

// --- The example card ---

function showDemoCard() {
  if (!demoCard) {
    demoCard = buildCardElement(DEMO_ITEM, DEMO_SOURCE);
    demoCard.classList.add("card--demo");
    demoLayer.appendChild(demoCard);
  }
  demoLayer.hidden = false;
  positionDemoCard();
}

// Left of centre on a wide screen so the box has somewhere to sit beside it,
// centred in whatever height the toolbar and the filter bar leave free - the
// same free area fitAll measures. Plain pixel arithmetic in JS rather than
// centring in CSS, because the height can only be had by measuring the card.
function positionDemoCard() {
  if (!demoCard) return;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const freeTop = tourToolbar.offsetHeight + (tourFilterBar.hidden ? 0 : tourFilterBar.offsetHeight);
  const height = demoCard.offsetHeight;

  const left = Math.max(24, Math.min(vw - DEMO_CARD_W - 24, Math.round(vw * 0.42 - DEMO_CARD_W / 2)));
  const top = Math.max(freeTop + 16, Math.round(freeTop + (vh - freeTop - height) / 2));
  demoCard.style.left = `${left}px`;
  demoCard.style.top = `${top}px`;
}

function hideDemoCard() {
  if (demoLayer) demoLayer.hidden = true;
}

// --- Example filter chips, for a board with no cards on it yet ---

// Only when the real bar has none of its own. Spans rather than buttons: they
// are illustrations of chips, and nothing should be able to focus or click one.
function addDemoChips() {
  if (!tourFilterBar || tourFilterBar.querySelector(".filter-chip")) return;

  const chip = (label, count, cls) => {
    const el = document.createElement("span");
    el.className = cls;
    el.dataset.tourDemo = "";
    el.innerHTML = `${escapeHtml(label)} <span class="filter-count">${count}</span>`;
    return el;
  };
  const divider = () => {
    const el = document.createElement("span");
    el.className = "filter-divider";
    el.dataset.tourDemo = "";
    return el;
  };

  tourFilterBar.append(
    chip("Reading list", 6, "filter-chip filter-chip--folder"),
    chip("Recipes", 3, "filter-chip filter-chip--folder"),
    divider(),
    chip("ideas", 9, "filter-chip"),
    chip("design", 5, "filter-chip"),
    divider(),
    chip("attention", 4, "filter-chip"),
    chip("deep-work", 2, "filter-chip"),
  );
}

function removeDemoChips() {
  for (const el of tourFilterBar?.querySelectorAll("[data-tour-demo]") ?? []) el.remove();
}

// --- Geometry ---

// The dim comes from the hole's own spread shadow, so a step with nothing to
// light collapses the hole to a point and the shadow covers the screen.
function drawHole(rect) {
  if (!rect) {
    holeEl.style.left = `${Math.round(window.innerWidth / 2)}px`;
    holeEl.style.top = `${Math.round(window.innerHeight / 2)}px`;
    holeEl.style.width = "0px";
    holeEl.style.height = "0px";
    return;
  }
  holeEl.style.left = `${Math.round(rect.left - HOLE_PAD)}px`;
  holeEl.style.top = `${Math.round(rect.top - HOLE_PAD)}px`;
  holeEl.style.width = `${Math.round(rect.width + HOLE_PAD * 2)}px`;
  holeEl.style.height = `${Math.round(rect.height + HOLE_PAD * 2)}px`;
}

function drawRing(rect, radius) {
  ringEl.hidden = !rect;
  if (!rect) return;
  ringEl.style.borderRadius = radius ?? "10px";
  ringEl.style.left = `${Math.round(rect.left - 4)}px`;
  ringEl.style.top = `${Math.round(rect.top - 4)}px`;
  ringEl.style.width = `${Math.round(rect.width + 8)}px`;
  ringEl.style.height = `${Math.round(rect.height + 8)}px`;
}

// Below, then right, then left, then above - the first side the box fits on
// whole, and if none of them fit, below, clamped onto the screen. Measured
// after the content is written, since the box's height depends on the words.
function placeTip(rect) {
  const w = tipEl.offsetWidth;
  const h = tipEl.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  if (!rect) {
    tipEl.style.left = `${Math.round((vw - w) / 2)}px`;
    tipEl.style.top = `${Math.round((vh - h) / 2)}px`;
    return;
  }

  const midX = rect.left + rect.width / 2 - w / 2;
  const midY = rect.top + rect.height / 2 - h / 2;
  const candidates = [
    { x: midX, y: rect.bottom + TIP_GAP },
    { x: rect.right + TIP_GAP, y: midY },
    { x: rect.left - TIP_GAP - w, y: midY },
    { x: midX, y: rect.top - TIP_GAP - h },
  ];

  const fits = candidates.find(
    (c) =>
      c.x >= TIP_MARGIN && c.x + w <= vw - TIP_MARGIN && c.y >= TIP_MARGIN && c.y + h <= vh - TIP_MARGIN,
  );
  const chosen = fits ?? candidates[0];

  tipEl.style.left = `${Math.round(Math.max(TIP_MARGIN, Math.min(vw - TIP_MARGIN - w, chosen.x)))}px`;
  tipEl.style.top = `${Math.round(Math.max(TIP_MARGIN, Math.min(vh - TIP_MARGIN - h, chosen.y)))}px`;
}

// --- Running a step ---

function showStep(index) {
  stepIndex = Math.max(0, Math.min(TOUR_STEPS.length - 1, index));
  const step = TOUR_STEPS[stepIndex];
  const last = stepIndex === TOUR_STEPS.length - 1;

  // The bar has to be open before anything is measured against it - it is what
  // step 2 points at, and it moves the free area the example card sits in.
  if (step.needsFilterBar) setFilterBarOpen(true);
  if (step.demo) showDemoCard();
  else hideDemoCard();

  tipEl.innerHTML = `
    <button type="button" class="tour-skip" data-tour-skip aria-label="End the tour">✕</button>
    <h2 id="tour-tip-title" class="tour-tip-title">${escapeHtml(step.title)}</h2>
    <p class="tour-tip-body">${escapeHtml(step.body)}</p>
    <div class="tour-tip-foot">
      <span class="tour-tip-count">${stepIndex + 1} of ${TOUR_STEPS.length}</span>
      <button type="button" class="tour-back" data-tour-back${stepIndex === 0 ? " disabled" : ""}>Back</button>
      <button type="button" class="tour-next" data-tour-next>${last ? "Done" : "Next"}</button>
    </div>
  `;
  tipEl.querySelector("[data-tour-skip]").addEventListener("click", endTour);
  tipEl.querySelector("[data-tour-back]").addEventListener("click", () => showStep(stepIndex - 1));
  tipEl.querySelector("[data-tour-next]").addEventListener("click", () => (last ? endTour() : showStep(stepIndex + 1)));

  layoutStep();
  tipEl.querySelector("[data-tour-next]").focus();
}

// Split from showStep so a resize can redo the geometry without rebuilding the
// box or moving focus out from under the user.
function layoutStep() {
  const step = TOUR_STEPS[stepIndex];
  if (step.demo) positionDemoCard();

  const litEl = step.lit?.() ?? null;
  const focusEl = (step.focus ?? step.lit)?.() ?? null;
  const focusRect = focusEl ? focusEl.getBoundingClientRect() : null;
  drawHole(litEl ? litEl.getBoundingClientRect() : null);
  drawRing(focusRect, step.ringRadius);
  placeTip(focusRect);
}

// Set directly rather than by clicking #filter-toggle: that handler also clears
// any active filter and closes every open folder, which is not the tour's to do
// to somebody's board.
function setFilterBarOpen(open) {
  if (!tourFilterBar || !tourFilterToggle) return;
  tourFilterBar.hidden = !open;
  tourFilterToggle.setAttribute("aria-expanded", String(open));
}

// --- Starting and ending ---

function startTour() {
  if (tourOpen) return;
  tourOpen = true;
  buildTourChrome();

  restoreFilterBarHidden = tourFilterBar ? tourFilterBar.hidden : null;
  addDemoChips();

  document.addEventListener("keydown", onTourKey, true);
  window.addEventListener("resize", layoutStep);
  showStep(0);
}

function endTour() {
  if (!tourOpen) return;
  tourOpen = false;

  document.removeEventListener("keydown", onTourKey, true);
  window.removeEventListener("resize", layoutStep);

  hideDemoCard();
  demoCard?.remove();
  demoCard = null;
  removeDemoChips();
  // Back to whatever the bar was doing before the tour opened it.
  if (restoreFilterBarHidden !== null) setFilterBarOpen(!restoreFilterBarHidden);
  restoreFilterBarHidden = null;

  for (const el of [blockEl, demoLayer, holeEl, ringEl, tipEl]) el?.remove();
  blockEl = demoLayer = holeEl = ringEl = tipEl = null;

  tourStartBtn?.focus();
}

// Capturing, so Escape ends the tour rather than reaching canvas.js's own
// Escape handler underneath it.
function onTourKey(e) {
  if (e.key === "Escape") {
    e.stopPropagation();
    endTour();
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    if (stepIndex < TOUR_STEPS.length - 1) showStep(stepIndex + 1);
    else endTour();
  } else if (e.key === "ArrowLeft") {
    e.preventDefault();
    showStep(stepIndex - 1);
  }
}

tourStartBtn?.addEventListener("click", startTour);

// Once, on a first visit. Reading and writing are both wrapped: storage access
// throws outright in a locked-down browser, and a tour is not worth taking the
// board down over. A browser that won't remember gets the tour every time,
// which is the harmless direction to fail in.
function tourAlreadySeen() {
  try {
    return localStorage.getItem(TOUR_SEEN_KEY) !== null;
  } catch {
    return false;
  }
}

function markTourSeen() {
  try {
    localStorage.setItem(TOUR_SEEN_KEY, new Date().toISOString());
  } catch {
    // Nothing to do about it, and nothing depends on it having worked.
  }
}

if (!tourAlreadySeen()) {
  markTourSeen();
  startTour();
}
