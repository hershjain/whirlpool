import { Router } from "express";
import {
  listAllItems,
  updateItemPosition,
  deleteItem,
  listFolders,
  createFolder,
  setItemFolder,
  updateFolderPosition,
} from "./repo.js";
import { prisma } from "./db.js";
import { requireSession, rejectCrossSite } from "./httpAuth.js";
import { maskPhone } from "./phone.js";

export const canvasRouter: Router = Router();

// Every route below is scoped to the phone number on the session cookie.
// Nothing here reads the configured owner any more: this router used to serve
// one hardcoded person's board to anyone who found the URL, DELETE included.
canvasRouter.use(rejectCrossSite);
canvasRouter.use(requireSession);

// Whose board this is, for the toolbar. Masked rather than full: enough for
// someone on a shared machine to recognise, not enough to read off a screen.
canvasRouter.get("/me", (req, res) => {
  res.json({ phone: maskPhone(req.phone!) });
});

canvasRouter.get("/items", async (req, res) => {
  const items = await listAllItems(req.phone!);
  res.json(items);
});

// One row per hostname, not per item - the frontend joins this against each
// item's sourceHostname rather than carrying the color/logo on every card.
canvasRouter.get("/sources", async (_req, res) => {
  const profiles = await prisma.sourceProfile.findMany();
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
});

canvasRouter.get("/sources/:hostname/icon", async (req, res) => {
  const profile = await prisma.sourceProfile.findUnique({ where: { hostname: req.params.hostname } });
  if (!profile?.iconBase64 || !profile.iconMime) {
    res.status(404).end();
    return;
  }
  res.set("Content-Type", profile.iconMime);
  res.set("Cache-Control", "public, max-age=604800");
  res.send(Buffer.from(profile.iconBase64, "base64"));
});

canvasRouter.patch("/items/:id/position", async (req, res) => {
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
});

canvasRouter.delete("/items/:id", async (req, res) => {
  const deleted = await deleteItem(req.phone!, req.params.id);
  if (!deleted) {
    res.status(404).json({ error: "Item not found" });
    return;
  }
  res.status(204).end();
});

// --- Folders: user-made collections ---

canvasRouter.get("/folders", async (req, res) => {
  const folders = await listFolders(req.phone!);
  res.json(folders);
});

canvasRouter.post("/folders", async (req, res) => {
  const { name } = req.body as { name?: unknown };

  if (typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "name must be a non-empty string" });
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
});

canvasRouter.patch("/items/:id/folder", async (req, res) => {
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
});

canvasRouter.patch("/folders/:id/position", async (req, res) => {
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
});
