import sharp from "sharp";
import { fetchWithTimeout, OSM_HEADERS } from "./httpFetch.js";

// The card's hero band, which is the only place a map thumbnail is ever drawn.
// Kept in step with `.card-hero` in public/app.css and CARD_W in canvas.js.
export const MAP_WIDTH = 240;
export const MAP_HEIGHT = 132;

export const MIN_MAP_ZOOM = 1;
export const MAX_MAP_ZOOM = 19;

const TILE_SIZE = 256;
const TILE_TIMEOUT_MS = 6_000;
// A 256px map tile is 10-40KB; anything past this is not one.
const MAX_TILE_BYTES = 512 * 1024;

// One fetch of four-to-six tiles per *distinct place*, cached in process below
// and then cached by the browser for a year, sits well inside OSM's policy.
const TILE_HEADERS: Record<string, string> = {
  ...OSM_HEADERS,
  Accept: "image/png,image/*;q=0.8",
};

// The empty-map grey OSM itself renders over, so a tile that fails to load
// leaves something map-coloured behind rather than a black hole.
const BACKGROUND = { r: 242, g: 239, b: 233, alpha: 1 };

// Keyed by the exact (lat, lng, zoom) the route was asked for, which is already
// quantised to five decimals - about a metre, far below what a 240px thumbnail
// can show - so two saves of the same place share one entry.
const CACHE_LIMIT = 200;
const cache = new Map<string, Buffer>();

function cacheGet(key: string): Buffer | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  // Re-insert so the most recently used entry is last, and the eviction below
  // always takes the coldest one.
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

function cacheSet(key: string, value: Buffer): void {
  cache.set(key, value);
  if (cache.size > CACHE_LIMIT) {
    const coldest = cache.keys().next();
    if (!coldest.done) cache.delete(coldest.value);
  }
}

// Web Mercator, the projection every slippy map uses: longitude is linear, and
// latitude is stretched by the inverse Gudermannian so that a constant compass
// bearing is a straight line. Both come back in pixels at this zoom, where the
// whole world is 256 * 2^zoom across.
function lngToPixelX(lng: number, zoom: number): number {
  return ((lng + 180) / 360) * TILE_SIZE * 2 ** zoom;
}

// Web Mercator is undefined at the poles - it stretches them to infinity - so
// every slippy map stops at this latitude, and so does OSM's tile pyramid.
// Clamping here means a pin further north than any map goes still renders the
// northernmost real tiles instead of failing with nothing to show.
const MERCATOR_LIMIT = 85.05112878;

function latToPixelY(lat: number, zoom: number): number {
  const clamped = Math.min(MERCATOR_LIMIT, Math.max(-MERCATOR_LIMIT, lat));
  const radians = (clamped * Math.PI) / 180;
  const mercator = Math.log(Math.tan(radians) + 1 / Math.cos(radians));
  return ((1 - mercator / Math.PI) / 2) * TILE_SIZE * 2 ** zoom;
}

async function fetchTile(zoom: number, x: number, y: number): Promise<Buffer | null> {
  try {
    const res = await fetchWithTimeout(`https://tile.openstreetmap.org/${zoom}/${x}/${y}.png`, {
      headers: TILE_HEADERS,
      timeoutMs: TILE_TIMEOUT_MS,
      maxBytes: MAX_TILE_BYTES,
    });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

// A teardrop pin whose *tip* marks the spot, so it is composited with its point
// at the centre of the image rather than its body.
const PIN_WIDTH = 22;
const PIN_HEIGHT = 28;

function pinSvg(): Buffer {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PIN_WIDTH}" height="${PIN_HEIGHT}" viewBox="0 0 22 28">` +
      `<path d="M11 27.5C11 27.5 21 16.8 21 11A10 10 0 1 0 1 11c0 5.8 10 16.5 10 16.5z" ` +
      `fill="#EA4335" stroke="#ffffff" stroke-width="1.6"/>` +
      `<circle cx="11" cy="11" r="3.6" fill="#ffffff"/>` +
      `</svg>`,
  );
}

/**
 * Composites an OpenStreetMap thumbnail centred on a point, with a pin on it.
 *
 * Returns null when every tile failed, so the caller can answer with a status
 * rather than a convincing-looking blank square.
 */
export async function renderMapThumbnail(lat: number, lng: number, zoom: number): Promise<Buffer | null> {
  const key = `${lat},${lng},${zoom}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const worldTiles = 2 ** zoom;
  // Top-left corner of the window we want, in world pixels.
  const left = lngToPixelX(lng, zoom) - MAP_WIDTH / 2;
  const top = latToPixelY(lat, zoom) - MAP_HEIGHT / 2;

  const firstTileX = Math.floor(left / TILE_SIZE);
  const lastTileX = Math.floor((left + MAP_WIDTH - 1) / TILE_SIZE);
  const firstTileY = Math.floor(top / TILE_SIZE);
  const lastTileY = Math.floor((top + MAP_HEIGHT - 1) / TILE_SIZE);

  const wanted: { x: number; y: number; left: number; top: number }[] = [];
  for (let tileY = firstTileY; tileY <= lastTileY; tileY++) {
    // There is no tile above the north pole or below the south one; the
    // background shows through instead. Longitude, by contrast, wraps.
    if (tileY < 0 || tileY >= worldTiles) continue;
    for (let tileX = firstTileX; tileX <= lastTileX; tileX++) {
      wanted.push({
        x: ((tileX % worldTiles) + worldTiles) % worldTiles,
        y: tileY,
        // Offsets within the tile grid, never within the final window, so they
        // are always positive - sharp rejects a negative composite offset.
        left: (tileX - firstTileX) * TILE_SIZE,
        top: (tileY - firstTileY) * TILE_SIZE,
      });
    }
  }

  const fetched = await Promise.all(wanted.map((tile) => fetchTile(zoom, tile.x, tile.y)));
  const composites = wanted
    .map((tile, index) => ({ input: fetched[index], left: tile.left, top: tile.top }))
    .filter((layer): layer is { input: Buffer; left: number; top: number } => layer.input !== null);

  if (composites.length === 0) return null;

  const gridWidth = (lastTileX - firstTileX + 1) * TILE_SIZE;
  const gridHeight = (lastTileY - firstTileY + 1) * TILE_SIZE;

  // Build the whole tile grid, then cut the window out of it. Compositing
  // straight into a 240x132 canvas would need negative offsets for the tiles
  // that hang off the left and top edges, which sharp will not take.
  const grid = await sharp({
    create: { width: gridWidth, height: gridHeight, channels: 4, background: BACKGROUND },
  })
    .composite(composites)
    .png()
    .toBuffer();

  const window = await sharp(grid)
    .extract({
      left: Math.round(left - firstTileX * TILE_SIZE),
      top: Math.round(top - firstTileY * TILE_SIZE),
      width: MAP_WIDTH,
      height: MAP_HEIGHT,
    })
    .png()
    .toBuffer();

  const withPin = await sharp(window)
    .composite([
      {
        input: pinSvg(),
        left: Math.round((MAP_WIDTH - PIN_WIDTH) / 2),
        top: Math.round(MAP_HEIGHT / 2 - PIN_HEIGHT),
      },
    ])
    .png()
    .toBuffer();

  cacheSet(key, withPin);
  return withPin;
}
