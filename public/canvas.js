const viewport = document.getElementById("viewport");
const world = document.getElementById("world");
const emptyState = document.getElementById("empty-state");
const filterBar = document.getElementById("filter-bar");
const filterToggle = document.getElementById("filter-toggle");
const toolbarWho = document.getElementById("toolbar-who");
const logoutBtn = document.getElementById("logout");

// Every rendered card paired with the item it came from, so filtering can
// reposition and restore without refetching.
const cards = new Map(); // id -> { item, el }
let activeFilter = null; // { kind: "category" | "tag", value: string } | null

// Ids whose left/top are a layout artefact rather than where the user put the
// card - a filter grid, or the inside of an open folder. Saving one would
// overwrite the real position with a temporary one. Rebuilt by refresh().
const reflowed = new Set();

// [{id, name, itemCount, canvasX, canvasY}] from GET /api/folders - user-made
// collections, as against the model's tags and category. Refreshed whenever a
// filing changes.
let folders = [];

// The folders currently drawn on the board. A folder is an object *on* the
// canvas rather than a view of it: opening one puts its square where the user
// left it and gathers its items inside, while everything else carries on as
// normal - still there, still draggable, still clickable. Any number can be
// open at once, and an item belongs to at most one of them.
const openFolders = new Set(); // folder ids
const folderZoneEls = new Map(); // id -> the .folder-zone element, kept across opens
const folderZoneRects = new Map(); // id -> { left, top, right, bottom } in world px

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
// A row pitch, used only for the very first scatter of never-placed items -
// they aren't in the document yet there, so nothing can be measured. Every
// later layout packs by measured height instead. See packColumns.
const CARD_ROW_HEIGHT = 560;
// Stands in when a card's height can't be read - it's hidden, or not yet laid
// out. Roughly a card with a short hero and a couple of lines.
const CARD_FALLBACK_H = 320;

// A folder's cluster is narrower than the full grid - it's meant to read as a
// compact group sitting within the wider board, not another full-width row.
const FOLDER_COLS = 3;
const FOLDER_ZONE_PADDING = 40;
// What an empty folder's square is tall enough to hold - roughly one card, so
// it reads as a place a card could go rather than a stripe.
const EMPTY_FOLDER_H = 260;

const TOOLBAR_H = 48; // #toolbar's fixed height in style.css
const FIT_MARGIN = 48; // breathing room left around the board when framing it

// A session can expire or be revoked while the tab is open, at which point
// every /api call starts coming back 401. Without this the JSON parse throws
// and the board just stops working with nothing on screen to explain it.
function bounceToLogin() {
  window.location.replace("/login");
  // Never resolves: callers are mid-async and should not carry on rendering
  // against a page that is already navigating away.
  return new Promise(() => {});
}

async function getJson(url) {
  const res = await fetch(url, { credentials: "same-origin" });
  if (res.status === 401) return bounceToLogin();
  if (!res.ok) throw new Error(`${url} failed: ${res.status}`);
  return res.json();
}

async function loadItems() {
  const [items, sources, folderList] = await Promise.all([
    getJson("/api/items"),
    getJson("/api/sources"),
    getJson("/api/folders"),
  ]);
  folders = folderList;
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

  buildFilterBar(items, folderList);
  refresh();
}

// --- Filtering by folder, category, and tag ---

// Folders lead because the user made them on purpose; categories come next
// because they actually group (6 values across 12 cards here); tags trail
// and only the ones used more than once are shown (42 distinct tags used 46
// times - a tag used once isn't a filter, it's a link to a single tile).
function buildFilterBar(items, folderList) {
  if (!filterBar) return;
  folders = folderList;

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
  // An empty folder stays out of the bar - it's a chip that opens an empty
  // square, which reads as a dead click. It's still choosable from any tile's
  // own folder menu, which lists every folder whatever its count, so an empty
  // one gets its first card that way and earns its chip back.
  const folderChips = folderList
    .filter((folder) => folder.itemCount > 0)
    .sort((a, b) => b.itemCount - a.itemCount || a.name.localeCompare(b.name));

  filterBar.replaceChildren();
  let needsDivider = false;

  if (folderChips.length) {
    for (const folder of folderChips) {
      filterBar.appendChild(filterChip("folder", folder.id, folder.itemCount, folder.name));
    }
    needsDivider = true;
  }

  if (categoryChips.length) {
    if (needsDivider) filterBar.appendChild(filterDivider());
    for (const [value, count] of categoryChips) filterBar.appendChild(filterChip("category", value, count));
    needsDivider = true;
  }

  if (tagChips.length) {
    if (needsDivider) filterBar.appendChild(filterDivider());
    for (const [value, count] of tagChips) filterBar.appendChild(filterChip("tag", value, count));
  }
}

function filterDivider() {
  const divider = document.createElement("span");
  divider.className = "filter-divider";
  return divider;
}

function filterChip(kind, value, count, label = value) {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = kind === "folder" ? "filter-chip filter-chip--folder" : "filter-chip";
  chip.dataset.kind = kind;
  chip.dataset.value = value;
  chip.innerHTML = `${escapeHtml(label)} <span class="filter-count">${count}</span>`;
  // A folder chip and a tag chip do different things now: one opens a square on
  // the board, the other filters the board down. Only the second is exclusive.
  chip.addEventListener("click", () => (kind === "folder" ? toggleFolder(value) : toggleFilter(kind, value)));
  return chip;
}

function updateFilterChipStates() {
  for (const chip of filterBar?.querySelectorAll(".filter-chip") ?? []) {
    const on =
      chip.dataset.kind === "folder"
        ? openFolders.has(chip.dataset.value)
        : activeFilter && chip.dataset.kind === activeFilter.kind && chip.dataset.value === activeFilter.value;
    chip.classList.toggle("is-active", Boolean(on));
  }
}

function matchesFilter(item) {
  if (!activeFilter) return true;
  if (activeFilter.kind === "category") return item.category === activeFilter.value;
  return (item.tags ?? []).some((tag) => tag.trim().toLowerCase() === activeFilter.value);
}

function folderById(id) {
  return folders.find((folder) => folder.id === id) ?? null;
}

function toggleFilter(kind, value) {
  const alreadyOn = activeFilter && activeFilter.kind === kind && activeFilter.value === value;
  activeFilter = alreadyOn ? null : { kind, value };
  refresh();
}

// Opening a folder doesn't filter anything and doesn't hide anything - it only
// decides whether that folder's square is drawn on the board with its items
// gathered inside it. Any number can be open at once.
function toggleFolder(folderId) {
  if (openFolders.has(folderId)) openFolders.delete(folderId);
  else openFolders.add(folderId);
  refresh();
}

// --- Laying the board out ---

// The single re-render entry point: every chip, every folder toggle, every
// filing change and every delete comes through here. It decides where each
// card sits and draws the open folders' squares.
//
// Whether it also moves the camera depends on what asked. Anything that
// changes what the board is showing - a chip, a filter, opening or closing a
// folder, the first load - frames the result so it's on screen. An edit to one
// tile - filing it, unfiling it, deleting it - leaves the view exactly where
// the user had it: being zoomed out because you dropped a card in a folder is
// the view fighting you.
function refresh({ frame = true } = {}) {
  reflowed.clear();

  if (activeFilter) layoutFilterGrid();
  else layoutBoard();

  updateFilterChipStates();
  if (frame) fitAll();
}

// A tag or category filter is a search, not a place: it hides what doesn't
// match and gathers what does into a readable grid, oldest first. Folder
// squares stand down while one is on - a filter cutting across a folder would
// otherwise leave a square holding some of its items and not the rest.
// Drops each card into whichever column is currently shortest, so the next one
// starts right under the last rather than at a fixed row pitch. Card heights
// run from about 180px for a bare note to 500 for a tall photo post, and a grid
// spaced for the tallest left a band of dead canvas under every short one.
// Returns the height of the tallest column, which is the packed block's height.
//
// Every height is read before any position is written: reading offsetHeight
// after a write forces the browser to re-do layout, and interleaving the two
// would make it re-do it once per card.
function packColumns(entries, originX, originY, cols) {
  const heights = entries.map((entry) => entry.el.offsetHeight || CARD_FALLBACK_H);
  const columns = new Array(cols).fill(0);

  entries.forEach((entry, index) => {
    let shortest = 0;
    for (let col = 1; col < cols; col++) {
      if (columns[col] < columns[shortest]) shortest = col;
    }
    entry.el.style.left = `${originX + shortest * (CARD_W + CARD_GAP)}px`;
    entry.el.style.top = `${originY + columns[shortest]}px`;
    reflowed.add(entry.item.id);
    columns[shortest] += heights[index] + CARD_GAP;
  });

  // Each column carries a trailing gap that isn't part of the block.
  return Math.max(0, ...columns.map((height) => height - CARD_GAP));
}

function layoutFilterGrid() {
  removeAllFolderZones();

  const visible = [];
  for (const entry of cards.values()) {
    entry.el.classList.remove("card--foldered");
    const shown = matchesFilter(entry.item);
    entry.el.hidden = !shown;
    if (shown) visible.push(entry);
  }

  visible.sort((a, b) => new Date(a.item.createdAt) - new Date(b.item.createdAt));
  packColumns(visible, 0, 0, GRID_COLS);
}

// Nothing filtered: every card is on the board and every one of them stays
// draggable and clickable. Members of an *open* folder gather into its square;
// everyone else - including the members of a closed folder - sits exactly
// where it was last put. canvasX/canvasY stay the source of truth throughout;
// a folder only ever moves a card in memory, through style.left/top.
function layoutBoard() {
  for (const entry of cards.values()) {
    entry.el.hidden = false;
    entry.el.classList.remove("card--foldered");
    entry.el.style.left = `${entry.item.canvasX}px`;
    entry.el.style.top = `${entry.item.canvasY}px`;
  }

  for (const id of [...folderZoneEls.keys()]) {
    if (!openFolders.has(id)) removeFolderZone(id);
  }

  for (const id of [...openFolders]) {
    const folder = folderById(id);
    // A folder deleted out from under us stops being open rather than leaving
    // a square on the board with nothing behind it.
    if (folder) layoutFolder(folder);
    else openFolders.delete(id);
  }
}

// Lays one open folder out at its own spot: its members in a compact grid, the
// translucent square inflated around them. The origin is the folder's saved
// position, so it reopens where the user left it; the very first open picks a
// spot clear of everything already on the board and writes it back.
function layoutFolder(folder) {
  if (folder.canvasX === null || folder.canvasY === null) {
    const spot = firstClearSpot();
    folder.canvasX = spot.x;
    folder.canvasY = spot.y;
    saveFolderPosition(folder.id, spot.x, spot.y);
  }

  const members = [...cards.values()]
    .filter((entry) => entry.item.folderId === folder.id)
    .sort((a, b) => new Date(a.item.createdAt) - new Date(b.item.createdAt));

  const originX = folder.canvasX + FOLDER_ZONE_PADDING;
  const originY = folder.canvasY + FOLDER_ZONE_PADDING;
  const cols = Math.min(FOLDER_COLS, Math.max(1, members.length));

  for (const entry of members) entry.el.classList.add("card--foldered");
  const packedHeight = packColumns(members, originX, originY, cols);

  // The square is drawn around what was actually packed, so it closes just
  // under the longest column. An empty folder still gets a square one card
  // wide, so there's somewhere to drag the first one into.
  const contentHeight = members.length ? packedHeight : EMPTY_FOLDER_H;

  renderFolderZone(
    folder,
    {
      left: folder.canvasX,
      top: folder.canvasY,
      right: originX + cols * CARD_W + (cols - 1) * CARD_GAP + FOLDER_ZONE_PADDING,
      bottom: originY + contentHeight + FOLDER_ZONE_PADDING,
    },
    members.length,
  );
}

// Somewhere a square can open without covering anything: to the right of
// everything already placed, lined up with the top of it.
function firstClearSpot() {
  let right = 0;
  let top = 0;
  let seen = false;

  const consider = (edgeRight, edgeTop) => {
    right = seen ? Math.max(right, edgeRight) : edgeRight;
    top = seen ? Math.min(top, edgeTop) : edgeTop;
    seen = true;
  };

  for (const entry of cards.values()) {
    consider((entry.item.canvasX ?? 0) + CARD_W, entry.item.canvasY ?? 0);
  }
  for (const zone of folderZoneRects.values()) consider(zone.right, zone.top);

  return seen ? { x: right + CARD_GAP * 2, y: top } : { x: 0, y: 0 };
}

// --- A folder's square on the board ---

// One element per open folder, kept across opens rather than recreated, so
// only its position, size and label change. pointer-events:none is what lets a
// card sitting underneath it still be grabbed; drops are hit-tested against
// folderZoneRects instead, and the label is the square's own drag handle.
function renderFolderZone(folder, zone, memberCount) {
  let zoneEl = folderZoneEls.get(folder.id);
  if (!zoneEl) {
    zoneEl = document.createElement("div");
    zoneEl.className = "folder-zone";
    const label = document.createElement("span");
    label.className = "folder-zone-label";
    zoneEl.appendChild(label);
    attachZoneDrag(zoneEl, folder.id);
    folderZoneEls.set(folder.id, zoneEl);
    // First child of #world so cards (appended earlier) always paint over it.
    // Done once, here: re-inserting a node releases any pointer capture on it,
    // and this runs from inside the square's own drag. With one square open
    // the call was a no-op (it was already first), which is why dragging only
    // broke once a second square was on the board.
    world.insertBefore(zoneEl, world.firstChild);
  }

  zoneEl.style.left = `${zone.left}px`;
  zoneEl.style.top = `${zone.top}px`;
  zoneEl.style.width = `${zone.right - zone.left}px`;
  zoneEl.style.height = `${zone.bottom - zone.top}px`;
  zoneEl.querySelector(".folder-zone-label").textContent = `${folder.name} · ${memberCount}`;

  folderZoneRects.set(folder.id, zone);
}

function removeFolderZone(id) {
  folderZoneEls.get(id)?.remove();
  folderZoneEls.delete(id);
  folderZoneRects.delete(id);
}

function removeAllFolderZones() {
  for (const id of [...folderZoneEls.keys()]) removeFolderZone(id);
}

// Dragging the label drags the whole square, members and all, and saves the
// new origin. The folder is looked up by id on every event rather than closed
// over, because refreshFolders() replaces the objects in `folders` wholesale.
function attachZoneDrag(zoneEl, folderId) {
  const handle = zoneEl.querySelector(".folder-zone-label");
  // The id of the pointer currently dragging, or null when nothing is. Holding
  // the id rather than a boolean means a move belonging to some other pointer -
  // or arriving after the drag already ended - can never resume it.
  let dragPointer = null;
  let startScreen = { x: 0, y: 0 };
  let startOrigin = { x: 0, y: 0 };

  function endDrag() {
    if (dragPointer === null) return;
    dragPointer = null;
    zoneEl.classList.remove("dragging");
    document.body.classList.remove("dragging-zone");
    const folder = folderById(folderId);
    // No re-frame here: the view shouldn't move under the hand that's moving
    // the square.
    if (folder) saveFolderPosition(folder.id, folder.canvasX, folder.canvasY);
  }

  handle.addEventListener("pointerdown", (e) => {
    const folder = folderById(folderId);
    if (!folder) return;
    e.stopPropagation(); // otherwise the canvas takes it as the start of a pan
    dragPointer = e.pointerId;
    startScreen = { x: e.clientX, y: e.clientY };
    startOrigin = { x: folder.canvasX ?? 0, y: folder.canvasY ?? 0 };
    handle.setPointerCapture(e.pointerId);
    zoneEl.classList.add("dragging");
    // Cards ease between positions, which is right for a re-flow and wrong for
    // a drag - the members would trail the square by a third of a second.
    document.body.classList.add("dragging-zone");
  });

  handle.addEventListener("pointermove", (e) => {
    if (e.pointerId !== dragPointer) return;
    const folder = folderById(folderId);
    if (!folder) return;
    folder.canvasX = startOrigin.x + (e.clientX - startScreen.x) / scale;
    folder.canvasY = startOrigin.y + (e.clientY - startScreen.y) / scale;
    layoutFolder(folder);
  });

  // pointerup is the ordinary ending. The other two are the ones that used to
  // leave a drag stuck on: capture can be lost without a pointerup ever
  // reaching the handle, and the square would then follow the cursor whenever
  // it passed nearby.
  handle.addEventListener("pointerup", endDrag);
  handle.addEventListener("pointercancel", endDrag);
  handle.addEventListener("lostpointercapture", endDrag);
}

// --- Framing whatever is on the board ---

// Pans and zooms so every visible card and every open folder's square fits in
// the space the toolbar and filter bar leave free. Called at the end of every
// refresh, never after a drag - the view shouldn't move under the user's hand.
function fitAll() {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;

  for (const entry of cards.values()) {
    if (entry.el.hidden) continue;
    // The style just written, not a measured rect: cards ease between
    // positions, so getBoundingClientRect() mid-reflow reports where the card
    // *was*. Heights still have to be measured - they vary per card.
    const x = parseFloat(entry.el.style.left);
    const y = parseFloat(entry.el.style.top);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x + (entry.el.offsetWidth || CARD_W));
    bottom = Math.max(bottom, y + (entry.el.offsetHeight || CARD_FALLBACK_H));
  }

  for (const zone of folderZoneRects.values()) {
    left = Math.min(left, zone.left);
    top = Math.min(top, zone.top);
    right = Math.max(right, zone.right);
    bottom = Math.max(bottom, zone.bottom);
  }

  if (!Number.isFinite(left)) return; // nothing visible to frame

  const rect = viewport.getBoundingClientRect();
  const freeTop = TOOLBAR_H + (filterBar && !filterBar.hidden ? filterBar.offsetHeight : 0);
  const freeH = Math.max(1, rect.height - freeTop);
  const width = Math.max(1, right - left);
  const height = Math.max(1, bottom - top);

  // Plain pixel arithmetic in JS on purpose - layout maths expressed in newer
  // CSS has been silently dropped by a browser on this project before.
  const fit = Math.min((rect.width - FIT_MARGIN * 2) / width, (freeH - FIT_MARGIN * 2) / height);
  // Never past 100%: a board with two cards on it shouldn't balloon them.
  scale = Math.min(1, Math.max(MIN_SCALE, fit));
  panX = rect.width / 2 - (left + width / 2) * scale;
  panY = freeTop + freeH / 2 - (top + height / 2) * scale;

  applyTransform();
}

if (filterToggle && filterBar) {
  filterToggle.addEventListener("click", () => {
    const wasVisible = !filterBar.hidden;
    filterBar.hidden = wasVisible;
    filterToggle.setAttribute("aria-expanded", String(!wasVisible));
    // Never leave tiles filtered, or folders open, with the controls hidden -
    // there'd be no way to get the rest back or to close the squares.
    if (wasVisible && (activeFilter || openFolders.size)) {
      activeFilter = null;
      openFolders.clear();
    }
    refresh();
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

  // Logo hard left, the site it came from beside it, the delete control hard
  // right. The confirm row takes the name and the X's place in the bar rather
  // than opening a dialog - it's one tile's worth of a decision and it belongs
  // on the tile.
  let html = `
    <div class="card-header">
      ${logo}
      <span class="card-source-name">${escapeHtml(headerName)}</span>
      <button type="button" class="card-delete" data-delete-btn aria-label="Delete this item">\u2715</button>
      <div class="card-delete-confirm">
        <span class="card-delete-ask">Delete?</span>
        <button type="button" class="card-delete-no" data-delete-no>No</button>
        <button type="button" class="card-delete-yes" data-delete-yes>Yes</button>
      </div>
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
  } else if (!item.hasPreview) {
    // The link resolves, but it's a client-rendered app (Reddit, Bluesky) that
    // handed us nothing to show. Better an honest note than a bare hostname
    // dressed up as a real card.
    html += `<div class="card-broken">Preview unavailable</div>`;
  }

  const byline = item.author || item.siteName || item.sourceHostname;

  // A post is its own words - the tweet or the caption is what you came back
  // for, so it leads and the account drops underneath as attribution. Reading
  // the account name in bold with the tweet as a grey footnote had the
  // hierarchy upside down. Articles and notes are the other way round: the
  // headline leads and a summary explains it.
  // A song never leads with its own text - the name is the point and the
  // artist belongs directly under it, which is the title branch below.
  const leadsWithContent = Boolean(item.excerpt) && !item.isLongForm && !item.isMusic;

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

  // Outside .card-body, so it can sit in the tile's bottom-right corner
  // whatever the body happens to contain.
  html += folderButtonMarkup(item);

  card.innerHTML = html;

  wireFolderButton(card, item);
  wireDeleteButton(card, item);
  attachCardDrag(card, item);
  return card;
}

// --- Deleting an item ---

// The X asks first rather than deleting on the spot: it sits inches from a
// card that opens a link on any plain click, and the row it removes doesn't
// come back. Confirming swaps the header's name and the X for Delete? No Yes.
function wireDeleteButton(card, item) {
  const button = card.querySelector("[data-delete-btn]");
  const confirm = card.querySelector(".card-delete-confirm");
  if (!button || !confirm) return;

  // Same guard as the folder button: without it the card's own pointerup reads
  // any of these clicks as a tap and opens the link.
  for (const el of [button, confirm]) {
    for (const type of ["pointerdown", "pointermove", "pointerup", "click"]) {
      el.addEventListener(type, (e) => e.stopPropagation());
    }
  }

  button.addEventListener("click", () => {
    cancelDeleteConfirms(); // only ever one tile mid-decision
    card.classList.add("card--confirming");
  });
  confirm.querySelector("[data-delete-no]").addEventListener("click", () => {
    card.classList.remove("card--confirming");
  });
  confirm.querySelector("[data-delete-yes]").addEventListener("click", () => deleteItem(item));
}

// Backs every tile out of its confirm state, except the one the click landed
// in. Wired to the same outside-click and Escape handlers as the folder menu.
function cancelDeleteConfirms(target = null) {
  for (const card of world.querySelectorAll(".card--confirming")) {
    if (!target || !card.contains(target)) card.classList.remove("card--confirming");
  }
}

async function deleteItem(item) {
  try {
    const res = await fetch(`/api/items/${item.id}`, { method: "DELETE" });
    if (!res.ok) return;
  } catch (error) {
    console.error("Failed to delete item", error);
    return;
  }

  cards.get(item.id)?.el.remove();
  cards.delete(item.id);
  if (cards.size === 0) emptyState.hidden = false;

  // Every chip that counted this item is now off by one, and the board has a
  // hole in it - rebuild the bar and re-lay what's left, without moving the
  // view: removing one tile shouldn't rescale the rest.
  await refreshFolders();
  refresh({ frame: false });
}

// --- Folders: user-made collections, distinct from the model's tags/category ---

// Filed tiles show the folder's name at tag size, in green in the tile's
// bottom-right corner; an unfiled tile shows a plain "+" in a rounded square
// instead - same glyph family as the zoom controls, not an emoji, to match the
// rest of the UI's plain-text conventions.
function folderButtonMarkup(item) {
  return item.folderName
    ? `<button type="button" class="card-folder" data-folder-btn>${escapeHtml(item.folderName)}</button>`
    : `<button type="button" class="card-folder card-folder--empty" data-folder-btn aria-label="Add to folder">+</button>`;
}

function wireFolderButton(card, item) {
  const button = card.querySelector("[data-folder-btn]");
  if (!button) return;
  // Same guard as .card-expand: without it the card's own pointerup treats
  // this click as a tap and opens the link instead of the menu.
  for (const type of ["pointerdown", "pointermove", "pointerup", "click"]) {
    button.addEventListener(type, (e) => e.stopPropagation());
  }
  button.addEventListener("click", () => openFolderMenu(button, item));
}

// Re-renders one card's folder control after a filing change, without
// touching the rest of the card (its expanded/dragging state, etc).
function updateCardFolderControl(item) {
  const entry = cards.get(item.id);
  if (!entry) return;
  const button = entry.el.querySelector("[data-folder-btn]");
  if (!button) return;
  button.outerHTML = folderButtonMarkup(item);
  wireFolderButton(entry.el, item);
}

// A single floating popover, positioned per use rather than one per card - it
// lists existing folders, a field to create a new one, and (when the tile is
// already filed) a way to remove it.
let folderMenuEl = null;
let folderMenuItem = null; // the item the open menu is currently editing

function ensureFolderMenu() {
  if (folderMenuEl) return folderMenuEl;

  folderMenuEl = document.createElement("div");
  folderMenuEl.id = "folder-menu";
  folderMenuEl.hidden = true;

  // Same guard as the folder button itself and .card-expand - without it, a
  // click inside the menu bubbles to the canvas and can start a pan, or reach
  // a card underneath and open its link.
  for (const type of ["pointerdown", "pointermove", "pointerup", "click"]) {
    folderMenuEl.addEventListener(type, (e) => e.stopPropagation());
  }

  document.body.appendChild(folderMenuEl);
  return folderMenuEl;
}

function closeFolderMenu() {
  if (folderMenuEl) folderMenuEl.hidden = true;
  folderMenuItem = null;
}

document.addEventListener("pointerdown", (e) => {
  if (folderMenuEl && !folderMenuEl.hidden && !folderMenuEl.contains(e.target)) closeFolderMenu();
  cancelDeleteConfirms(e.target);
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  closeFolderMenu();
  cancelDeleteConfirms();
});

function openFolderMenu(anchorEl, item) {
  const menu = ensureFolderMenu();
  folderMenuItem = item;

  // Options render as the same chip as a filter-bar folder chip, and the
  // tile's current folder (if any) shows active - the menu previously gave
  // no sign of where a filed tile already sat.
  const optionsHtml = folders.length
    ? folders
        .map((folder) => {
          const active = folder.id === item.folderId;
          const cls = `filter-chip filter-chip--folder folder-menu-option${active ? " is-active" : ""}`;
          return `<button type="button" class="${cls}" data-folder-id="${escapeHtml(folder.id)}">${escapeHtml(folder.name)}</button>`;
        })
        .join("")
    : `<div class="folder-menu-empty">No folders yet</div>`;

  menu.innerHTML = `
    <div class="folder-menu-list">${optionsHtml}</div>
    <form class="folder-menu-new">
      <input type="text" placeholder="New folder…" maxlength="60" />
      <button type="submit">Add</button>
    </form>
    ${item.folderId ? `<button type="button" class="folder-menu-remove">Remove from folder</button>` : ""}
  `;
  menu.hidden = false;

  // Anchored below-left of the button, then clamped to the viewport - without
  // this a badge near the right or bottom edge pushes the menu off screen.
  // Only measurable now that it's visible with real content.
  const anchorRect = anchorEl.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  let left = anchorRect.left;
  let top = anchorRect.bottom + 4;
  if (left + menuRect.width > window.innerWidth - 8) left = window.innerWidth - 8 - menuRect.width;
  if (top + menuRect.height > window.innerHeight - 8) top = anchorRect.top - 4 - menuRect.height;
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, top)}px`;

  for (const optionBtn of menu.querySelectorAll(".folder-menu-option")) {
    optionBtn.addEventListener("click", () => {
      fileItemInFolder(folderMenuItem, optionBtn.dataset.folderId);
      closeFolderMenu();
    });
  }

  const form = menu.querySelector(".folder-menu-new");
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const input = form.querySelector("input");
    const name = input.value.trim();
    if (!name) return;
    createFolderAndFile(folderMenuItem, name);
    closeFolderMenu();
  });

  const removeBtn = menu.querySelector(".folder-menu-remove");
  if (removeBtn) {
    removeBtn.addEventListener("click", () => {
      // No drop point here, so the slot it currently occupies inside the square
      // is the position it keeps - it stops being a member without moving.
      const el = cards.get(folderMenuItem.id)?.el;
      if (el) releaseFromFolder(folderMenuItem, parseFloat(el.style.left), parseFloat(el.style.top));
      else fileItemInFolder(folderMenuItem, null);
      closeFolderMenu();
    });
  }
}

// Files (folderId a string) or unfiles (folderId null) an item, updates the
// same item object referenced by the cards map so the change is visible
// immediately, and keeps the filter bar's folder chips/counts in sync.
async function fileItemInFolder(item, folderId) {
  try {
    const res = await fetch(`/api/items/${item.id}/folder`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folderId }),
    });
    if (!res.ok) return;
  } catch (error) {
    console.error("Failed to update item folder", error);
    return;
  }

  item.folderId = folderId;
  item.folderName = folderId ? (folders.find((f) => f.id === folderId)?.name ?? null) : null;

  updateCardFolderControl(item);
  await refreshFolders();
  // The square this item just joined or left has to re-flow, but the camera
  // stays put - this is an edit to one tile, not a change of view.
  refresh({ frame: false });
}

async function createFolderAndFile(item, name) {
  let folder;
  try {
    const res = await fetch("/api/folders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) return;
    folder = await res.json();
  } catch (error) {
    console.error("Failed to create folder", error);
    return;
  }

  folders = [...folders.filter((f) => f.id !== folder.id), folder];
  // Open it straight away - a new folder that stayed closed would look like
  // nothing had happened but a chip appearing.
  openFolders.add(folder.id);
  await fileItemInFolder(item, folder.id);
}

async function refreshFolders() {
  try {
    folders = await getJson("/api/folders");
    // A folder that just lost its last card has no chip any more, so leaving
    // its square open would strand it on the board with no way to close it.
    for (const folder of folders) {
      if (folder.itemCount === 0) openFolders.delete(folder.id);
    }
    buildFilterBar([...cards.values()].map((entry) => entry.item), folders);
    updateFilterChipStates();
  } catch (error) {
    console.error("Failed to refresh folders", error);
  }
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
    // The card just got taller or shorter, so anything packed under it is now
    // overlapping or floating. Only matters where something is packed - a
    // loose card on the open board is at its own position and pushes nothing.
    if (activeFilter || openFolders.size) refresh({ frame: false });
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
      handleDrop(item, card);
    } else if (item.rawUrl) {
      window.open(item.rawUrl, "_blank", "noopener,noreferrer");
    }
  });
}

// An open folder is a place on the board rather than a mode, so where a card
// lands decides its filing, against every square that's open:
// - dropped inside a square -> filed there, and out of whatever folder it was
//   in, since an item belongs to exactly one.
// - dragged out of the open folder it belonged to -> unfiled, and the spot it
//   was dropped becomes its real position - the natural inverse of dragging
//   one in.
// - dropped back inside its own square -> just resettles onto that grid.
// - anywhere else -> an ordinary move, saved unless this card's position is a
//   layout artefact (a filter grid) rather than somewhere the user put it.
function handleDrop(item, card) {
  const x = parseFloat(card.style.left);
  const y = parseFloat(card.style.top);
  const cx = x + CARD_W / 2;
  const cy = y + (card.offsetHeight || CARD_FALLBACK_H) / 2;

  let target = null;
  for (const [id, zone] of folderZoneRects) {
    if (cx >= zone.left && cx <= zone.right && cy >= zone.top && cy <= zone.bottom) {
      target = id;
      break;
    }
  }

  if (target) {
    if (item.folderId === target) refresh({ frame: false }); // moved within its own square
    else fileItemInFolder(item, target);
    return;
  }

  if (item.folderId && openFolders.has(item.folderId)) {
    releaseFromFolder(item, x, y); // it lives where the hand let go of it
    return;
  }

  if (!reflowed.has(item.id)) commitPosition(item, x, y);
}

// A member's position inside a square is a layout artefact - its real
// canvasX/canvasY still points at wherever it sat before it was ever filed.
// The moment it stops being a member, that artefact becomes the truth, and it
// has to be written *before* the re-lay that unfiling triggers: layoutBoard
// draws every card at its stored position, so committing afterwards left the
// card snapped back to a position from another era, and the stored value and
// the drawn one out of step until the next re-lay moved it a second time.
function releaseFromFolder(item, x, y) {
  commitPosition(item, x, y);
  // If the PATCH fails, fileItemInFolder returns early and this stays a member
  // carrying its new position. Harmless: the next re-lay packs it back into
  // the square, and the spot the user chose beats the stale one regardless.
  return fileItemInFolder(item, null);
}

// Persists a position and updates the in-memory item to match, so the value
// survives the next filter clear. savePosition alone only reaches the DB -
// item.canvasX/canvasY would stay stale until a reload re-fetched it.
function commitPosition(item, x, y) {
  item.canvasX = x;
  item.canvasY = y;
  savePosition(item.id, x, y);
}

// A folder's square sits where it was put, the same way a card does. Fire and
// forget like savePosition - the in-memory folder is already updated, so a
// failed write only costs the placement on the next reload.
async function saveFolderPosition(id, x, y) {
  try {
    await fetch(`/api/folders/${id}/position`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ x, y }),
    });
  } catch (error) {
    console.error("Failed to save folder position", error);
  }
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


// --- Who is looking at this board ---

// The canvas is one person's saved reading. On a shared laptop the only cue
// that you are looking at your own is this line, so it is worth the request.
async function loadIdentity() {
  try {
    const me = await getJson("/api/me");
    toolbarWho.textContent = me.phone;
  } catch {
    // Non-fatal: the board itself is already loading. Better a missing label
    // than a wrong one.
  }
}

logoutBtn.addEventListener("click", async () => {
  logoutBtn.disabled = true;
  try {
    await fetch("/auth/logout", { method: "POST", credentials: "same-origin" });
  } catch {
    // Revoking server-side is the point, but if the request never lands the
    // right move is still to leave - the cookie stops being used either way.
  }
  window.location.replace("/login");
});

loadIdentity();
