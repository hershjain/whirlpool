const viewport = document.getElementById("viewport");
const world = document.getElementById("world");
const emptyState = document.getElementById("empty-state");

let scale = 1;
let panX = 100;
let panY = 100;
const MIN_SCALE = 0.25;
const MAX_SCALE = 2.5;

function applyTransform() {
  world.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
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

// --- Zooming toward the cursor ---
viewport.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const zoomFactor = Math.exp(-e.deltaY * 0.001);
    const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * zoomFactor));

    const rect = viewport.getBoundingClientRect();
    const cursorX = e.clientX - rect.left;
    const cursorY = e.clientY - rect.top;
    const worldX = (cursorX - panX) / scale;
    const worldY = (cursorY - panY) / scale;

    panX = cursorX - worldX * newScale;
    panY = cursorY - worldY * newScale;
    scale = newScale;
    applyTransform();
  },
  { passive: false },
);

// --- Loading and laying out items ---
const GRID_COLS = 4;
const CARD_W = 240;
const CARD_GAP = 32;
const CARD_ROW_HEIGHT = 220;

async function loadItems() {
  const res = await fetch("/api/items");
  const items = await res.json();

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
    world.appendChild(renderCard(item));
  }

  refineAccentColors(items);
}

// Domains that fell back to a hashed colour but do have a favicon: derive the
// real dominant colour from the icon and cache it server-side. Runs once per
// domain, after paint, so it never blocks the initial render.
function refineAccentColors(items) {
  const pending = new Map();
  for (const item of items) {
    if (item.colorSource !== "domain-hash") continue;
    if (!item.faviconDataUri || !item.domain) continue;
    if (!pending.has(item.domain)) pending.set(item.domain, item.faviconDataUri);
  }

  for (const [domain, dataUri] of pending) {
    dominantColor(dataUri)
      .then((hex) => {
        if (!hex) return;
        applyAccentToDomain(domain, hex);
        return fetch(`/api/sites/${encodeURIComponent(domain)}/color`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ color: hex }),
        });
      })
      .catch((error) => console.error("Colour refinement failed for", domain, error));
  }
}

function applyAccentToDomain(domain, hex) {
  for (const card of world.children) {
    if (card.dataset.domain !== domain) continue;
    const bar = card.querySelector(".card-bar");
    if (bar) bar.style.background = hex;
  }
}

// A data: URI is same-origin, so the canvas isn't tainted and getImageData
// works - which is the whole reason favicons are cached as data URIs.
function dominantColor(dataUri) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onerror = () => resolve(null);
    img.onload = () => {
      try {
        const size = 32;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, size, size);
        const { data } = ctx.getImageData(0, 0, size, size);

        const buckets = new Map();
        for (let i = 0; i < data.length; i += 4) {
          const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
          if (a < 128) continue; // transparent padding
          const max = Math.max(r, g, b);
          const min = Math.min(r, g, b);
          if (max > 240 && min > 240) continue; // near-white
          if (max < 24) continue; // near-black
          // Quantise so near-identical shades group together.
          const key = `${r >> 4},${g >> 4},${b >> 4}`;
          const entry = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
          entry.count++;
          entry.r += r;
          entry.g += g;
          entry.b += b;
          buckets.set(key, entry);
        }

        let best = null;
        for (const entry of buckets.values()) {
          if (!best || entry.count > best.count) best = entry;
        }
        if (!best) return resolve(null);

        const toHex = (v) => Math.round(v / best.count).toString(16).padStart(2, "0");
        resolve(`#${toHex(best.r)}${toHex(best.g)}${toHex(best.b)}`);
      } catch (error) {
        resolve(null);
      }
    };
    img.src = dataUri;
  });
}

const FALLBACK_ACCENT = "#c7cede";

function renderCard(item) {
  const card = document.createElement("div");
  card.className = "card";
  card.style.left = `${item.canvasX}px`;
  card.style.top = `${item.canvasY}px`;
  card.dataset.id = item.id;
  if (item.domain) card.dataset.domain = item.domain;

  const accent = item.accentColor || FALLBACK_ACCENT;
  let html = `<div class="card-bar" style="background:${escapeHtml(accent)}"></div>`;
  html += `<div class="card-body">`;

  if (item.imageUrl) {
    // Some hosts block hotlinking; drop the image rather than show a broken one.
    html += `<img class="card-image" src="${escapeHtml(item.imageUrl)}" alt="" onerror="this.remove()" />`;
  }

  html += `<div class="card-heading">`;
  if (item.faviconDataUri) {
    html += `<img class="card-favicon" src="${escapeHtml(item.faviconDataUri)}" alt="" onerror="this.remove()" />`;
  }
  html += `<span class="card-title">${escapeHtml(item.label)}</span></div>`;

  if (item.summary) {
    html += `<div class="card-summary">${escapeHtml(item.summary)}</div>`;
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
      savePosition(item.id, parseFloat(card.style.left), parseFloat(card.style.top));
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
