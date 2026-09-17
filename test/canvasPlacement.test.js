// Where a newly saved item lands. This file exists because the rule is easy to
// get wrong in a way nothing shouts about: a new item's position is dealt in
// the browser, on the load that first sees it, and getting it wrong drops the
// card on top of one that is already there rather than erroring. It used to.
//
// The invariant asserted here is exact and needs no card heights: a new card's
// left edge is at or past every placed card's right edge, which is knowable
// because every card is exactly CARD_W wide. Horizontal separation alone rules
// out an overlap, whatever the cards turn out to measure once rendered.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// Mirrors the constants at the top of public/canvas.js.
const CARD_W = 240;
const CARD_GAP = 32;
const CARD_ROW_HEIGHT = 560;
const COL_PITCH = CARD_W + CARD_GAP;

function item(id, canvasX = null, canvasY = null, createdAt = "2026-01-01T00:00:00.000Z") {
  return {
    id,
    type: "link",
    label: id,
    rawUrl: `https://example.com/${id}`,
    sourceHostname: null,
    tags: [],
    folderId: null,
    folderName: null,
    createdAt,
    canvasX,
    canvasY,
  };
}

// Runs public/canvas.js as a real classic script against public/app.html, with
// the network stubbed. Resolves once the board has placed everything it means
// to place, so the assertions see finished work rather than a race.
async function loadBoard(items, folders = []) {
  const html = fs
    .readFileSync(path.join(root, "public/app.html"), "utf8")
    .replace(/<script src="[^"]+"><\/script>/g, "");
  const dom = new JSDOM(html, {
    url: "http://localhost:3000/app",
    runScripts: "dangerously",
    pretendToBeVisual: true,
  });
  const { window } = dom;

  const patches = [];
  window.fetch = async (url, options = {}) => {
    if (options.method === "PATCH" && url.includes("/position")) {
      patches.push({ id: url.split("/").at(-2), ...JSON.parse(options.body) });
    }
    const body =
      url.includes("/api/items") && !options.method
        ? items
        : url.includes("/api/folders") && !options.method
          ? folders
          : url.includes("/api/me")
            ? { phone: "+1555" }
            : [];
    return { ok: true, status: 200, json: async () => body };
  };

  const script = window.document.createElement("script");
  script.textContent = fs.readFileSync(path.join(root, "public/canvas.js"), "utf8");
  window.document.body.appendChild(script);

  // Wait on the cards being in the document, not just on the position writes:
  // a board with nothing to place sends no writes at all, and returning on that
  // would hand the assertions an empty page.
  const expected = items.filter((i) => i.canvasX === null || i.canvasY === null).length;
  const ready = () =>
    window.document.querySelectorAll(".card").length === items.length && patches.length >= expected;
  for (let tick = 0; tick < 100 && !ready(); tick++) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.equal(window.document.querySelectorAll(".card").length, items.length, "every item should have rendered");
  assert.equal(patches.length, expected, "every unplaced item should have had a position persisted");

  // Where the card is actually drawn, which is the thing that matters - the
  // PATCH only says what was sent to the server.
  const drawn = (id) => {
    const el = window.document.querySelector(`.card[data-id="${id}"]`);
    assert.ok(el, `no card rendered for ${id}`);
    return { x: parseFloat(el.style.left), y: parseFloat(el.style.top) };
  };
  return { patches, drawn, window };
}

// The eight cards actually on the board when this was found, positions and all.
const REAL_BOARD = [
  item("arena-1", 825.306, 20.8727),
  item("arena-2", 1411.14, -86.4185),
  item("diesel", 524.031, 191.949),
  item("flower-shop", 519.101, -1.03104),
  item("guidance", -292.875, -18.9384),
  item("pigeons", 269.432, 576.565),
  item("nada-surf", -23.9786, -13.0368),
  item("weeknd", 272, 0),
];

// Board positions are fractional (dragging writes whatever the pointer maths
// produced), so a pitch measured between two of them carries a float tail.
const closeTo = (actual, expected, why) =>
  assert.ok(Math.abs(actual - expected) < 1e-6, `${why}: expected ~${expected}, got ${actual}`);

const rightmostEdge = (items) =>
  Math.max(...items.filter((i) => i.canvasX !== null).map((i) => i.canvasX + CARD_W));

test("a new item lands clear of every card already on the board", async () => {
  const fresh = item("new-1");
  const { drawn, patches } = await loadBoard([...REAL_BOARD, fresh]);

  const spot = drawn("new-1");
  assert.ok(
    spot.x >= rightmostEdge(REAL_BOARD),
    `new card at x=${spot.x} overlaps the board, which ends at x=${rightmostEdge(REAL_BOARD)}`,
  );
  // Specifically: this is the (0, 0) the old code produced, which sat under
  // "nada-surf" at (-23.98, -13.04).
  assert.notDeepEqual(spot, { x: 0, y: 0 });
  assert.deepEqual(patches, [{ id: "new-1", x: spot.x, y: spot.y }]);
});

test("several new items clear the board and each other", async () => {
  const fresh = ["new-1", "new-2", "new-3"].map((id, i) =>
    item(id, null, null, `2026-02-0${i + 1}T00:00:00.000Z`),
  );
  const { drawn } = await loadBoard([...REAL_BOARD, ...fresh]);

  const spots = fresh.map((i) => drawn(i.id));
  for (const spot of spots) {
    assert.ok(spot.x >= rightmostEdge(REAL_BOARD), `new card at x=${spot.x} overlaps the board`);
  }
  // Oldest first, across the columns, at the grid's own pitch.
  closeTo(spots[1].x - spots[0].x, COL_PITCH, "gap between the first two new cards");
  closeTo(spots[2].x - spots[1].x, COL_PITCH, "gap between the second two new cards");
  closeTo(spots[1].y, spots[0].y, "the first row shares one y");
  closeTo(spots[2].y, spots[0].y, "the first row shares one y");
});

test("the spot follows the rightmost edge, not the number of cards", async () => {
  // One card, far to the left of the origin. A rule that keyed off the count,
  // or off zero, would put the new card on top of it.
  const lonely = item("lonely", -500, 100);
  const { drawn } = await loadBoard([lonely, item("new-1")]);

  assert.deepEqual(drawn("new-1"), { x: -500 + CARD_W + CARD_GAP * 2, y: 100 });
});

test("a first-ever load still lays out from the origin", async () => {
  const fresh = Array.from({ length: 5 }, (_, i) =>
    item(`new-${i}`, null, null, `2026-03-0${i + 1}T00:00:00.000Z`),
  );
  const { drawn } = await loadBoard(fresh);

  assert.deepEqual(drawn("new-0"), { x: 0, y: 0 });
  assert.deepEqual(drawn("new-1"), { x: COL_PITCH, y: 0 });
  assert.deepEqual(drawn("new-4"), { x: 0, y: CARD_ROW_HEIGHT }); // wraps after four
});

// The other caller of firstClearSpot, which reaches it through the defaulted
// parameter rather than a passed list. A folder's square opening on top of the
// cards would be the same bug wearing a different hat.
test("a folder's square still opens clear of the cards", async () => {
  const folder = { id: "f1", name: "Reading", itemCount: 1, canvasX: null, canvasY: null };
  const filed = { ...item("filed", 100, 40), folderId: "f1", folderName: "Reading" };
  const { window } = await loadBoard([...REAL_BOARD, filed], [folder]);

  const chip = window.document.querySelector(".filter-chip--folder");
  assert.ok(chip, "the folder should have a chip in the filter bar");
  chip.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

  const zone = window.document.querySelector(".folder-zone");
  assert.ok(zone, "clicking the chip should open the folder's square");
  assert.ok(
    parseFloat(zone.style.left) >= rightmostEdge([...REAL_BOARD, filed]),
    `square opened at x=${zone.style.left}, over a board ending at x=${rightmostEdge([...REAL_BOARD, filed])}`,
  );
});
