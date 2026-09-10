const viewport = document.getElementById("viewport");
const world = document.getElementById("world");
const emptyState = document.getElementById("empty-state");
const filterBar = document.getElementById("filter-bar");
const filterToggle = document.getElementById("filter-toggle");

// Every rendered card paired with the item it came from, so filtering can
// reposition and restore without refetching.
const cards = new Map(); // id -> { item, el }
let activeFilter = null; // { kind: "category" | "tag" | "folder", value: string } | null

// Ids whose left/top are a layout artefact rather than where the user put the
// card - a filter grid, or a folder cluster. Saving one would overwrite the
// real position with a temporary one. Rebuilt by applyFilter() every time.
const reflowed = new Set();

// [{id, name, itemCount}] from GET /api/folders - user-made collections, as
// against the model's tags and category. Refreshed whenever a filing changes.
let folders = [];

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

// A folder's cluster is narrower than the full grid - it's meant to read as a
// compact group sitting within the wider board, not another full-width row.
const FOLDER_COLS = 3;
const FOLDER_ZONE_PADDING = 40;

async function loadItems() {
  const [items, sources, folderList] = await Promise.all([
    fetch("/api/items").then((res) => res.json()),
    fetch("/api/sources").then((res) => res.json()),
    fetch("/api/folders").then((res) => res.json()),
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
  // An empty folder in the filter bar would just be a dead click - it stays
  // choosable from a tile's own folder menu, but doesn't clutter the bar.
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
  chip.addEventListener("click", () => toggleFilter(kind, value));
  return chip;
}

function updateFilterChipStates() {
  for (const chip of filterBar?.querySelectorAll(".filter-chip") ?? []) {
    const on =
      activeFilter && chip.dataset.kind === activeFilter.kind && chip.dataset.value === activeFilter.value;
    chip.classList.toggle("is-active", Boolean(on));
  }
}

function matchesFilter(item) {
  if (!activeFilter) return true;
  if (activeFilter.kind === "category") return item.category === activeFilter.value;
  if (activeFilter.kind === "folder") return item.folderId === activeFilter.value;
  return (item.tags ?? []).some((tag) => tag.trim().toLowerCase() === activeFilter.value);
}

function activeFolderName() {
  const folder = folders.find((f) => f.id === activeFilter?.value);
  return folder ? folder.name : "Folder";
}

function toggleFilter(kind, value) {
  const alreadyOn = activeFilter && activeFilter.kind === kind && activeFilter.value === value;
  activeFilter = alreadyOn ? null : { kind, value };
  applyFilter();
}

function applyFilter() {
  reflowed.clear();

  if (!activeFilter) {
    // Nothing filtered - every card goes back to its real, hand-placed spot.
    // This is also what un-clusters a folder's members: applyFolderLayout
    // never touches a non-member's position, and members are only ever moved
    // in memory (style.left/top), never through savePosition - canvasX/
    // canvasY stay the source of truth throughout.
    removeFolderZone();
    for (const entry of cards.values()) {
      entry.el.hidden = false;
      entry.el.classList.remove("card--dimmed", "card--foldered");
      entry.el.style.left = `${entry.item.canvasX}px`;
      entry.el.style.top = `${entry.item.canvasY}px`;
    }
    applyTransform();
    updateFilterChipStates();
    return;
  }

  if (activeFilter.kind === "folder") {
    applyFolderLayout();
    updateFilterChipStates();
    return;
  }

  // Category or tag: hide non-matches, gather matches into a readable grid,
  // oldest first, and reset the view so results are actually on screen.
  removeFolderZone();
  const visible = [];
  for (const entry of cards.values()) {
    entry.el.classList.remove("card--dimmed", "card--foldered");
    const shown = matchesFilter(entry.item);
    entry.el.hidden = !shown;
    if (shown) visible.push(entry);
  }

  visible.sort((a, b) => new Date(a.item.createdAt) - new Date(b.item.createdAt));
  visible.forEach((entry, index) => {
    entry.el.style.left = `${(index % GRID_COLS) * (CARD_W + CARD_GAP)}px`;
    entry.el.style.top = `${Math.floor(index / GRID_COLS) * CARD_ROW_HEIGHT}px`;
    reflowed.add(entry.item.id);
  });
  panX = 100;
  panY = 100;
  scale = 1;

  applyTransform();
  updateFilterChipStates();
}

// A folder never hides anything: members gather into a compact cluster with a
// translucent square behind them; everyone else dims but stays exactly where
// they were, and stays draggable - including into or out of the square.
function applyFolderLayout() {
  const members = [];
  for (const entry of cards.values()) {
    entry.el.hidden = false;
    const isMember = matchesFilter(entry.item);
    entry.el.classList.toggle("card--foldered", isMember);
    entry.el.classList.toggle("card--dimmed", !isMember);
    if (isMember) members.push(entry);
  }
  members.sort((a, b) => new Date(a.item.createdAt) - new Date(b.item.createdAt));

  // Centred on the current viewport in world coordinates, so the cluster
  // appears where the user is already looking - unlike a tag/category filter,
  // the point here is to see the folder in the context of the wider board, so
  // the pan is never reset.
  const rect = viewport.getBoundingClientRect();
  const centreX = (rect.width / 2 - panX) / scale;
  const centreY = (rect.height / 2 - panY) / scale;

  const cols = Math.min(FOLDER_COLS, Math.max(1, members.length));
  const rows = Math.max(1, Math.ceil(members.length / cols));
  const clusterW = cols * CARD_W + (cols - 1) * CARD_GAP;
  const clusterH = rows * CARD_ROW_HEIGHT;
  const originX = centreX - clusterW / 2;
  const originY = centreY - clusterH / 2;

  members.forEach((entry, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    entry.el.style.left = `${originX + col * (CARD_W + CARD_GAP)}px`;
    entry.el.style.top = `${originY + row * CARD_ROW_HEIGHT}px`;
    reflowed.add(entry.item.id);
  });

  renderFolderZone(originX, originY, clusterW, clusterH);
  applyTransform();
}

// The translucent square drawn behind a folder's members. A single element,
// reused across opens rather than recreated - only its position/size/label
// change. pointer-events:none is what lets a dimmed card sitting underneath
// it still be grabbed; drops are hit-tested against folderZoneRect instead.
let folderZoneEl = null;
let folderZoneRect = null; // { left, top, right, bottom } in world px, or null

function renderFolderZone(originX, originY, clusterW, clusterH) {
  const left = originX - FOLDER_ZONE_PADDING;
  const top = originY - FOLDER_ZONE_PADDING;
  const width = clusterW + FOLDER_ZONE_PADDING * 2;
  const height = clusterH + FOLDER_ZONE_PADDING * 2;

  if (!folderZoneEl) {
    folderZoneEl = document.createElement("div");
    folderZoneEl.className = "folder-zone";
    const label = document.createElement("span");
    label.className = "folder-zone-label";
    folderZoneEl.appendChild(label);
  }
  // First child of #world so cards (appended earlier, and re-flowed above it
  // in z-index) always paint over it, whether freshly created or reused.
  world.insertBefore(folderZoneEl, world.firstChild);

  folderZoneEl.style.left = `${left}px`;
  folderZoneEl.style.top = `${top}px`;
  folderZoneEl.style.width = `${width}px`;
  folderZoneEl.style.height = `${height}px`;
  folderZoneEl.querySelector(".folder-zone-label").textContent = activeFolderName();

  folderZoneRect = { left, top, right: left + width, bottom: top + height };
}

function removeFolderZone() {
  if (folderZoneEl) folderZoneEl.remove();
  folderZoneRect = null;
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
      <div class="card-header-right">
        ${folderButtonMarkup(item)}
        ${logo}
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

  wireFolderButton(card, item);
  attachCardDrag(card, item);
  return card;
}

// --- Folders: user-made collections, distinct from the model's tags/category ---

// Filed tiles show the folder's name at tag size, in green; an unfiled tile
// shows a plain "+" instead - same glyph family as the zoom controls, not an
// emoji, to match the rest of the UI's plain-text conventions.
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
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeFolderMenu();
});

function openFolderMenu(anchorEl, item) {
  const menu = ensureFolderMenu();
  folderMenuItem = item;

  const anchorRect = anchorEl.getBoundingClientRect();
  menu.style.left = `${anchorRect.left}px`;
  menu.style.top = `${anchorRect.bottom + 4}px`;

  const optionsHtml = folders.length
    ? folders
        .map(
          (folder) =>
            `<button type="button" class="folder-menu-option" data-folder-id="${escapeHtml(folder.id)}">${escapeHtml(folder.name)}</button>`,
        )
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
      fileItemInFolder(folderMenuItem, null);
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
  if (activeFilter?.kind === "folder") applyFilter();
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
  await fileItemInFolder(item, folder.id);
}

async function refreshFolders() {
  try {
    folders = await fetch("/api/folders").then((res) => res.json());
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
      if (activeFilter?.kind === "folder") {
        handleFolderDrop(item, card);
      } else if (!reflowed.has(item.id)) {
        // Positions are only real when they're not a layout artefact. Under a
        // tag/category filter every visible card is reflowed; under a folder
        // filter only the members are - a dimmed card's position is real and
        // saves normally.
        savePosition(item.id, parseFloat(card.style.left), parseFloat(card.style.top));
      }
    } else if (item.rawUrl) {
      window.open(item.rawUrl, "_blank", "noopener,noreferrer");
    }
  });
}

// While a folder is open, where a card was dropped decides its filing:
// - dropped inside the zone, not yet a member -> files it, and the cluster
//   re-flows to include it (no position saved - it's reflowed into the grid).
// - dropped outside the zone, currently a member -> unfiles it and saves the
//   dropped position, the natural inverse of dragging one in.
// - dropped inside the zone, already a member -> just resettles into the grid.
// - dropped outside, not a member -> an ordinary drag of a dimmed card.
function handleFolderDrop(item, card) {
  const cx = parseFloat(card.style.left) + CARD_W / 2;
  const height = card.offsetHeight || CARD_ROW_HEIGHT;
  const cy = parseFloat(card.style.top) + height / 2;

  const inside =
    folderZoneRect &&
    cx >= folderZoneRect.left &&
    cx <= folderZoneRect.right &&
    cy >= folderZoneRect.top &&
    cy <= folderZoneRect.bottom;
  const isMember = item.folderId === activeFilter.value;

  if (inside && !isMember) {
    fileItemInFolder(item, activeFilter.value);
    return;
  }

  if (!inside && isMember) {
    const droppedX = parseFloat(card.style.left);
    const droppedY = parseFloat(card.style.top);
    fileItemInFolder(item, null).then(() => savePosition(item.id, droppedX, droppedY));
    return;
  }

  if (inside && isMember) {
    applyFilter(); // repositioned within the cluster - just resettle it onto the grid
    return;
  }

  savePosition(item.id, parseFloat(card.style.left), parseFloat(card.style.top));
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
