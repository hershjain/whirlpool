const viewport = document.getElementById("viewport");
const world = document.getElementById("world");
const emptyState = document.getElementById("empty-state");
const filterBar = document.getElementById("filter-bar");
const filterToggle = document.getElementById("filter-toggle");

// Every rendered card paired with the item it came from, so filtering can
// reposition and restore without refetching.
const cards = new Map(); // id -> { item, el }
let activeFilter = null; // { kind: "category" | "tag", value: string } | null

const MAX_TAG_CHIPS = 12;

let scale = 1;
let panX = 100;
let panY = 100;
const MIN_SCALE = 0.25;
const MAX_SCALE = 2.5;

function applyTransform() {
  world.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
  updateZoomLabel();
}

// --- Panning the canvas background ---
let isPanning = false;
let panStartScreen = { x: 0, y: 0 };
let panStartOffset = { x: 0, y: 0 };

viewport.addEventListener("pointerdown", (e) => {
  if (e.target.closest(".card")) return; // cards handle their own drag
  isPanning = true;
  viewport.classList.add("panning");
  panStartScreen = { x: e.clientX, y: e.clientY };
  panStartOffset = { x: panX, y: panY };
  viewport.setPointerCapture(e.pointerId);
});

viewport.addEventListener("pointermove", (e) => {
  if (!isPanning) return;
  panX = panStartOffset.x + (e.clientX - panStartScreen.x);
  panY = panStartOffset.y + (e.clientY - panStartScreen.y);
  applyTransform();
});

viewport.addEventListener("pointerup", () => {
  isPanning = false;
  viewport.classList.remove("panning");
});

// --- Zooming toward a point, and panning ---

// Keeps the world point under `screen` pinned there while the scale changes,
// which is what makes zoom feel anchored rather than lurching.
function zoomAround(newScale, screenX, screenY) {
  const clamped = Math.min(MAX_SCALE, Math.max(MIN_SCALE, newScale));
  const worldX = (screenX - panX) / scale;
  const worldY = (screenY - panY) / scale;
  panX = screenX - worldX * clamped;
  panY = screenY - worldY * clamped;
  scale = clamped;
  applyTransform();
}

// A trackpad pinch arrives as a wheel event with ctrlKey set; a two-finger
// scroll arrives without it. Treating every wheel event as zoom - as this did -
// means scrolling zooms instead of panning, which makes the canvas feel
// impossible to steer. Same split Figma and Miro use.
viewport.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const rect = viewport.getBoundingClientRect();

    if (e.ctrlKey) {
      zoomAround(scale * Math.exp(-e.deltaY * 0.01), e.clientX - rect.left, e.clientY - rect.top);
      return;
    }

    panX -= e.deltaX;
    panY -= e.deltaY;
    applyTransform();
  },
  { passive: false },
);

// --- Floating zoom controls ---
const zoomControls = document.getElementById("zoom-controls");
const zoomLabel = document.getElementById("zoom-level");

function viewportCentre() {
  const rect = viewport.getBoundingClientRect();
  return [rect.width / 2, rect.height / 2];
}

function updateZoomLabel() {
  if (zoomLabel) zoomLabel.textContent = `${Math.round(scale * 100)}%`;
}

if (zoomControls) {
  // Swallow pointer events so using the controls never starts a canvas pan.
  for (const type of ["pointerdown", "pointermove", "pointerup"]) {
    zoomControls.addEventListener(type, (e) => e.stopPropagation());
  }

  zoomControls.addEventListener("click", (e) => {
    const action = e.target.dataset?.zoom;
    if (!action) return;
    const [cx, cy] = viewportCentre();
    if (action === "in") zoomAround(scale * 1.2, cx, cy);
    else if (action === "out") zoomAround(scale / 1.2, cx, cy);
    else if (action === "reset") zoomAround(1, cx, cy);
    updateZoomLabel();
  });
}

// --- Loading and laying out items ---
const GRID_COLS = 4;
const CARD_W = 240; // keep in sync with `width` on .card in style.css
const CARD_GAP = 32;
const CARD_ROW_HEIGHT = 560; // tall enough for a fully-clamped card with a tall media hero + breathing room

async function loadItems() {
  const [items, sources] = await Promise.all([
    fetch("/api/items").then((res) => res.json()),
    fetch("/api/sources").then((res) => res.json()),
  ]);
  const sourceByHostname = new Map(sources.map((source) => [source.hostname, source]));

  if (items.length === 0) {
    emptyState.hidden = false;
    return;
  }
  emptyState.hidden = true;

  // Anything without a saved position yet gets one now, oldest-first, and we
  // persist it immediately so it doesn't reshuffle on a later reload.
  const unplaced = items
    .filter((item) => item.canvasX === null || item.canvasY === null)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  unplaced.forEach((item, index) => {
    const col = index % GRID_COLS;
    const row = Math.floor(index / GRID_COLS);
    item.canvasX = col * (CARD_W + CARD_GAP);
    item.canvasY = row * CARD_ROW_HEIGHT;
    savePosition(item.id, item.canvasX, item.canvasY);
  });

  for (const item of items) {
    const source = item.sourceHostname ? (sourceByHostname.get(item.sourceHostname) ?? null) : null;
    const card = renderCard(item, source);
    world.appendChild(card);
    // Only measurable once it's in the document - an element outside the DOM
    // reports zero for both scrollHeight and clientHeight.
    attachCardExpander(card);
    cards.set(item.id, { item, el: card });
  }

  buildFilterBar(items);
}

// --- Filtering by category and tag ---

// Categories lead because they actually group: 6 values across 12 cards here,
// against 42 distinct tags used 46 times. A tag used once isn't a filter - it's
// a link to a single tile - so single-use tags are left out entirely.
function buildFilterBar(items) {
  if (!filterBar) return;

  const categories = new Map();
  const tags = new Map();
  for (const item of items) {
    if (item.category) categories.set(item.category, (categories.get(item.category) ?? 0) + 1);
    for (const tag of item.tags ?? []) {
      const key = tag.trim().toLowerCase();
      if (key) tags.set(key, (tags.get(key) ?? 0) + 1);
    }
  }

  const byCount = (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]);
  const categoryChips = [...categories].sort(byCount);
  const tagChips = [...tags].filter(([, n]) => n > 1).sort(byCount).slice(0, MAX_TAG_CHIPS);

  filterBar.replaceChildren();
  for (const [value, count] of categoryChips) filterBar.appendChild(filterChip("category", value, count));

  if (tagChips.length) {
    const divider = document.createElement("span");
    divider.className = "filter-divider";
    filterBar.appendChild(divider);
    for (const [value, count] of tagChips) filterBar.appendChild(filterChip("tag", value, count));
  }
}

function filterChip(kind, value, count) {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "filter-chip";
  chip.dataset.kind = kind;
  chip.dataset.value = value;
  chip.innerHTML = `${escapeHtml(value)} <span class="filter-count">${count}</span>`;
  chip.addEventListener("click", () => toggleFilter(kind, value));
  return chip;
}

function matchesFilter(item) {
  if (!activeFilter) return true;
  if (activeFilter.kind === "category") return item.category === activeFilter.value;
  return (item.tags ?? []).some((tag) => tag.trim().toLowerCase() === activeFilter.value);
}

function toggleFilter(kind, value) {
  const alreadyOn = activeFilter && activeFilter.kind === kind && activeFilter.value === value;
  activeFilter = alreadyOn ? null : { kind, value };
  applyFilter();
}

function applyFilter() {
  const visible = [];
  for (const entry of cards.values()) {
    const shown = matchesFilter(entry.item);
    entry.el.hidden = !shown;
    if (shown) visible.push(entry);
  }

  if (activeFilter) {
    // Gather matches into a readable grid, oldest first. Written straight to
    // style and never through savePosition - canvasX/canvasY stay the source
    // of truth so clearing the filter restores the hand-placed layout exactly.
    visible.sort((a, b) => new Date(a.item.createdAt) - new Date(b.item.createdAt));
    visible.forEach((entry, index) => {
      entry.el.style.left = `${(index % GRID_COLS) * (CARD_W + CARD_GAP)}px`;
      entry.el.style.top = `${Math.floor(index / GRID_COLS) * CARD_ROW_HEIGHT}px`;
    });
    // Put the grid on screen; a filter that leaves you looking at empty canvas
    // reads as "nothing matched".
    panX = 100;
    panY = 100;
    scale = 1;
  } else {
    for (const entry of cards.values()) {
      entry.el.style.left = `${entry.item.canvasX}px`;
      entry.el.style.top = `${entry.item.canvasY}px`;
    }
  }

  applyTransform();

  for (const chip of filterBar?.querySelectorAll(".filter-chip") ?? []) {
    const on =
      activeFilter && chip.dataset.kind === activeFilter.kind && chip.dataset.value === activeFilter.value;
    chip.classList.toggle("is-active", Boolean(on));
  }
}

if (filterToggle && filterBar) {
  filterToggle.addEventListener("click", () => {
    const wasVisible = !filterBar.hidden;
    filterBar.hidden = wasVisible;
    filterToggle.setAttribute("aria-expanded", String(!wasVisible));
    // Never leave tiles filtered with the controls hidden - there'd be no way
    // to get the rest back.
    if (wasVisible && activeFilter) {
      activeFilter = null;
      applyFilter();
    }
  });
}

function renderCard(item, source) {
  const card = document.createElement("div");
  // Tweets get Inter (standing in for Chirp) on their text; nothing else does.
  const isTweet = item.sourceHostname === "x.com" || item.sourceHostname === "twitter.com";
  card.className = ["card", isTweet ? "card--tweet" : "", item.isBroken ? "card--broken" : ""]
    .filter(Boolean)
    .join(" ");
  card.style.left = `${item.canvasX}px`;
  card.style.top = `${item.canvasY}px`;
  card.dataset.id = item.id;

  // A note has no source to brand it, so it gets its own fixed color - a
  // legal-pad yellow that reads as "something you wrote" next to the branded
  // link cards. A hostname with a resolved profile gets its real brand
  // color/logo; one still awaiting first resolution falls through to the
  // neutral header rather than an empty or mismatched-looking one.
  if (item.type === "note") {
    card.style.setProperty("--source-color", "var(--note-color)");
    card.style.setProperty("--source-text-color", "var(--note-text-color)");
  } else if (source) {
    card.style.setProperty("--source-color", source.color);
    card.style.setProperty("--source-text-color", source.textColor);
  }

  const headerName = source ? source.name : (item.sourceHostname ?? (item.rawUrl ? "Link" : "Note"));
  const logo =
    source && source.hasIcon
      ? `<img class="card-logo" src="/api/sources/${encodeURIComponent(source.hostname)}/icon" alt="" draggable="false" onerror="this.remove()" />`
      : "";

  let html = `
    <div class="card-header">
      <span class="card-source-name">${escapeHtml(headerName)}</span>
      ${logo}
    </div>
  `;

  if (item.imageUrl) {
    // For a post, a reel or an are.na block the image *is* the content, so it
    // gets room to be looked at; an article's image is decoration above the
    // summary and keeps the shorter band.
    const heroClass = item.isLongForm ? "card-hero" : "card-hero card-hero--tall";
    // Sits flush between the header bar and the body so it reads as part of
    // the card rather than an inset thumbnail. Some hosts block hotlinking,
    // so drop the image rather than leave a broken-image box behind.
    // draggable="false" so dragging from the image moves the tile instead of
    // peeling the picture off it as a native HTML5 drag.
    html += `<img class="${heroClass}" src="${escapeHtml(item.imageUrl)}" alt="" draggable="false" onerror="this.remove()" />`;
  }

  html += `<div class="card-body">`;

  // Say so plainly rather than leaving a card that just looks badly extracted.
  // Still clickable - you may well want to check for yourself.
  if (item.isBroken) {
    html += `<div class="card-broken">Link unavailable</div>`;
  }

  const byline = item.author || item.siteName || item.sourceHostname;

  // A post is its own words - the tweet or the caption is what you came back
  // for, so it leads and the account drops underneath as attribution. Reading
  // the account name in bold with the tweet as a grey footnote had the
  // hierarchy upside down. Articles and notes are the other way round: the
  // headline leads and a summary explains it.
  const leadsWithContent = Boolean(item.excerpt) && !item.isLongForm;

  if (leadsWithContent) {
    // A note is the user's own writing, not a quotation from somewhere else,
    // so it drops the left rule that marks borrowed words.
    const excerptClass = item.type === "note" ? "card-excerpt card-excerpt--plain" : "card-excerpt";
    html += `<div class="${excerptClass}">${escapeHtml(item.excerpt)}</div>`;
    if (byline) {
      html += `<div class="card-byline card-byline--under">${escapeHtml(byline)}</div>`;
    }
  } else {
    html += `<div class="card-title">${escapeHtml(item.label)}</div>`;
    if (byline) {
      html += `<div class="card-byline">${escapeHtml(byline)}</div>`;
    }
    // Articles keep their summary; anything else shows its own words when it
    // has them, since a summary of two sentences is worse than the sentences.
    const body = item.isLongForm ? (item.summary ?? item.excerpt) : (item.excerpt ?? item.summary);
    if (body) {
      const bodyClass = body === item.excerpt ? "card-excerpt" : "card-summary";
      html += `<div class="${bodyClass}">${escapeHtml(body)}</div>`;
    }
  }

  if (item.tags && item.tags.length) {
    html += `<div class="card-tags">${item.tags
      .map((tag) => `<span class="card-tag">${escapeHtml(tag)}</span>`)
      .join("")}</div>`;
  }
  html += `</div>`;

  card.innerHTML = html;

  attachCardDrag(card, item);
  return card;
}

// Long captions are clamped so one rambling post can't tower over the canvas.
// The button only appears when text is actually being hidden - measured, not
// guessed from a character count, since how much fits depends on line breaks.
function attachCardExpander(card) {
  const clamped = card.querySelector(".card-excerpt, .card-summary");
  if (!clamped) return;

  // scrollHeight exceeds clientHeight only while the line clamp is hiding
  // something. Cards are in the DOM by the time this runs, so it measures real
  // layout; the hero image loading later doesn't affect text height.
  if (clamped.scrollHeight <= clamped.clientHeight + 1) return;

  const button = document.createElement("button");
  button.className = "card-expand";
  button.type = "button";
  button.textContent = "\u22ef";
  button.setAttribute("aria-label", "Show the full text");

  // The card treats any tap that didn't move as "open the link", so the button
  // has to swallow the whole pointer sequence or expanding would also navigate.
  for (const type of ["pointerdown", "pointermove", "pointerup", "click"]) {
    button.addEventListener(type, (e) => e.stopPropagation());
  }

  button.addEventListener("click", () => {
    const expanded = card.classList.toggle("card--expanded");
    button.setAttribute("aria-expanded", String(expanded));
  });

  clamped.insertAdjacentElement("afterend", button);
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// --- Dragging a card, distinguishing a drag from a click-to-open ---
function attachCardDrag(card, item) {
  let dragging = false;
  let moved = false;
  let startScreen = { x: 0, y: 0 };
  let startPos = { x: 0, y: 0 };

  card.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    dragging = true;
    moved = false;
    startScreen = { x: e.clientX, y: e.clientY };
    startPos = { x: parseFloat(card.style.left), y: parseFloat(card.style.top) };
    card.setPointerCapture(e.pointerId);
    card.classList.add("dragging");
  });

  card.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dx = (e.clientX - startScreen.x) / scale;
    const dy = (e.clientY - startScreen.y) / scale;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
    card.style.left = `${startPos.x + dx}px`;
    card.style.top = `${startPos.y + dy}px`;
  });

  card.addEventListener("pointerup", () => {
    dragging = false;
    card.classList.remove("dragging");
    if (moved) {
      // Positions are only real when the full board is shown. While filtered,
      // cards sit at temporary grid coordinates and persisting one would
      // overwrite where the user actually put it.
      if (!activeFilter) {
        savePosition(item.id, parseFloat(card.style.left), parseFloat(card.style.top));
      }
    } else if (item.rawUrl) {
      window.open(item.rawUrl, "_blank", "noopener,noreferrer");
    }
  });
}

async function savePosition(id, x, y) {
  try {
    await fetch(`/api/items/${id}/position`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ x, y }),
    });
  } catch (error) {
    console.error("Failed to save card position", error);
  }
}

applyTransform();
loadItems();
