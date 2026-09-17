import { Router } from "express";
import {
  listAllItems,
  updateItemPosition,
  deleteItem,
  listFolders,
  createFolder,
  setItemFolder,
  updateFolderPosition,
  listSourceProfilesForPhone,
} from "./repo.js";
import { prisma } from "./db.js";
import { requireSession, rejectCrossSite } from "./httpAuth.js";
import { asyncHandler } from "./http.js";
import { maskPhone } from "./phone.js";
import { renderMapThumbnail, MIN_MAP_ZOOM, MAX_MAP_ZOOM } from "./mapThumbnail.js";
import { MAP_DEFAULT_ZOOM } from "./linkExtract.js";

export const canvasRouter: Router = Router();

// Every route below is scoped to the phone number on the session cookie.
// Nothing here reads the configured owner any more: this router used to serve
// one hardcoded person's board to anyone who found the URL, DELETE included.
canvasRouter.use(rejectCrossSite);
canvasRouter.use(requireSession);

// Every handler is wrapped in asyncHandler. Express 4 does not catch a rejected
// promise from an async handler, and Node exits on an unhandled rejection - so
// before this, one Prisma timeout on any route below took the whole server down
// rather than returning a 500.

// Whose board this is, for the toolbar. Masked rather than full: enough for
// someone on a shared machine to recognise, not enough to read off a screen.
canvasRouter.get("/me", (req, res) => {
  res.json({ phone: maskPhone(req.phone!) });
});

canvasRouter.get(
  "/items",
  asyncHandler(async (req, res) => {
    const items = await listAllItems(req.phone!);
    res.json(items);
  }),
);

// One row per hostname, not per item - the frontend joins this against each
// item's sourceHostname rather than carrying the color/logo on every card.
// Scoped to the caller's own saves; see listSourceProfilesForPhone.
canvasRouter.get(
  "/sources",
  asyncHandler(async (req, res) => {
    const profiles = await listSourceProfilesForPhone(req.phone!);
    res.json(
      profiles.map((profile) => ({
        hostname: profile.hostname,
        name: profile.name,
        color: profile.color,
        textColor: profile.textColor,
        // Both fields, matching the icon route's own 404 condition below - a
        // hasIcon that the endpoint then refuses would render a broken image.
        hasIcon: profile.iconBase64 !== null && profile.iconMime !== null,
      })),
    );
  }),
);

// Favicon bytes are third-party: whatever the site we fetched chose to serve.
// Handing those back under our own origin with a Content-Type we also took from
// that site is how a hostile favicon becomes stored XSS - an SVG is a document
// that can run script, and same-origin here means it would run against the
// canvas. The <img> tag the canvas renders it in would not execute it, but a
// direct navigation to this URL would.
//
// So: never serve a type that can execute, and tell the browser not to guess.
const SERVABLE_ICON_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/x-icon",
  "image/vnd.microsoft.icon",
]);

canvasRouter.get(
  "/sources/:hostname/icon",
  asyncHandler(async (req, res) => {
    const profile = await prisma.sourceProfile.findUnique({
      where: { hostname: req.params.hostname },
    });
    if (!profile?.iconBase64 || !profile.iconMime) {
      res.status(404).end();
      return;
    }
    if (!SERVABLE_ICON_TYPES.has(profile.iconMime)) {
      res.status(404).end();
      return;
    }

    res.set("Content-Type", profile.iconMime);
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Cache-Control", "public, max-age=604800");
    res.send(Buffer.from(profile.iconBase64, "base64"));
  }),
);

// A Google Maps save is a place, and a place should look like somewhere rather
// than like a URL. There is no keyless way to get a map picture out of Google -
// their Static Maps API has needed a billed key since 2018 - so the tiles come
// from OpenStreetMap and are composited here, behind our own origin.
//
// Serving it ourselves rather than hotlinking is what keeps this free of a CSP
// change (imgSrc already allows 'self'), keeps the viewer's browser from
// announcing every saved address to a third party, and lets one cached PNG
// answer for every person who saved the same place.
//
// Mounted on canvasRouter, so it inherits requireSession. That is load-bearing
// and not incidental: an unauthenticated image route taking a URL-shaped input
// is an open proxy.
const MAP_COORD = /^-?\d{1,3}(\.\d{1,10})?$/;

// These come from a URL someone texted, so they are checked into real numbers
// in real ranges *before* any of them reaches a tile URL. This route fetches
// third-party images by interpolation; an unvalidated value here is the string
// that would get to choose which ones.
function parseCoord(value: unknown, limit: number): number | null {
  if (typeof value !== "string" || !MAP_COORD.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && Math.abs(parsed) <= limit ? parsed : null;
}

function parseZoom(value: unknown): number | null {
  if (value === undefined) return MAP_DEFAULT_ZOOM;
  if (typeof value !== "string" || !/^\d{1,2}$/.test(value)) return null;
  const parsed = Number(value);
  return parsed >= MIN_MAP_ZOOM && parsed <= MAX_MAP_ZOOM ? parsed : null;
}

canvasRouter.get(
  "/map",
  asyncHandler(async (req, res) => {
    const lat = parseCoord(req.query.lat, 90);
    const lng = parseCoord(req.query.lng, 180);
    const zoom = parseZoom(req.query.z);
    if (lat === null || lng === null || zoom === null) {
      res.status(400).json({ error: "lat, lng and z must be numbers in range" });
      return;
    }

    const png = await renderMapThumbnail(lat, lng, zoom);
    // Every tile failed. Answering with a blank square would cache a grey box
    // for a year; a status lets the card drop the image and try again later.
    if (!png) {
      res.status(502).end();
      return;
    }

    res.set("Content-Type", "image/png");
    res.set("X-Content-Type-Options", "nosniff");
    // (lat, lng, zoom) fully determines these bytes, so this answer can never
    // go stale for a given URL.
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    res.send(png);
  }),
);

canvasRouter.patch(
  "/items/:id/position",
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { x, y } = req.body as { x?: unknown; y?: unknown };

    if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) {
      res.status(400).json({ error: "x and y must be finite numbers" });
      return;
    }

    const updated = await updateItemPosition(req.phone!, id, x, y);
    if (!updated) {
      res.status(404).json({ error: "Item not found" });
      return;
    }
    res.status(204).end();
  }),
);

canvasRouter.delete(
  "/items/:id",
  asyncHandler(async (req, res) => {
    const deleted = await deleteItem(req.phone!, req.params.id);
    if (!deleted) {
      res.status(404).json({ error: "Item not found" });
      return;
    }
    res.status(204).end();
  }),
);

// --- Folders: user-made collections ---

// Folders are created by an authenticated user with no other ceiling, so both
// of these are here to stop one account filling the table: a name long enough
// to be a payload, and an unbounded number of rows.
const MAX_FOLDER_NAME_LENGTH = 60; // matches the maxlength on the canvas input
const MAX_FOLDERS_PER_PHONE = 200;

canvasRouter.get(
  "/folders",
  asyncHandler(async (req, res) => {
    const folders = await listFolders(req.phone!);
    res.json(folders);
  }),
);

canvasRouter.post(
  "/folders",
  asyncHandler(async (req, res) => {
    const { name } = req.body as { name?: unknown };

    if (typeof name !== "string" || !name.trim()) {
      res.status(400).json({ error: "name must be a non-empty string" });
      return;
    }
    if (name.trim().length > MAX_FOLDER_NAME_LENGTH) {
      res.status(400).json({ error: `name must be ${MAX_FOLDER_NAME_LENGTH} characters or fewer` });
      return;
    }

    const existing = await prisma.folder.count({ where: { phone: req.phone! } });
    if (existing >= MAX_FOLDERS_PER_PHONE) {
      res.status(409).json({ error: "You have reached the maximum number of folders." });
      return;
    }

    const folder = await createFolder(req.phone!, name);
    // createFolder only returns null when the trimmed name was empty, which the
    // check above already rules out - but keep the guard rather than assert.
    if (!folder) {
      res.status(400).json({ error: "name must be a non-empty string" });
      return;
    }
    res.json(folder);
  }),
);

canvasRouter.patch(
  "/items/:id/folder",
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { folderId } = req.body as { folderId?: unknown };

    if (folderId !== null && typeof folderId !== "string") {
      res.status(400).json({ error: "folderId must be a string or null" });
      return;
    }

    const updated = await setItemFolder(req.phone!, id, folderId);
    if (!updated) {
      res.status(404).json({ error: "Item or folder not found" });
      return;
    }
    res.status(204).end();
  }),
);

canvasRouter.patch(
  "/folders/:id/position",
  asyncHandler(async (req, res) => {
    const { x, y } = req.body as { x?: unknown; y?: unknown };

    if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) {
      res.status(400).json({ error: "x and y must be finite numbers" });
      return;
    }

    const updated = await updateFolderPosition(req.phone!, req.params.id, x, y);
    if (!updated) {
      res.status(404).json({ error: "Folder not found" });
      return;
    }
    res.status(204).end();
  }),
);
