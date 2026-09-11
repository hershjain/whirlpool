import { Router } from "express";
import { config } from "./config.js";
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

export const canvasRouter: Router = Router();

// No real auth yet - single user for now, so every request is scoped to the
// one configured owner. This goes away once magic-link auth exists (Phase 3).

canvasRouter.get("/items", async (_req, res) => {
  const items = await listAllItems(config.ownerPhoneNumber);
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

  const updated = await updateItemPosition(config.ownerPhoneNumber, id, x, y);
  if (!updated) {
    res.status(404).json({ error: "Item not found" });
    return;
  }
  res.status(204).end();
});

canvasRouter.delete("/items/:id", async (req, res) => {
  const deleted = await deleteItem(config.ownerPhoneNumber, req.params.id);
  if (!deleted) {
    res.status(404).json({ error: "Item not found" });
    return;
  }
  res.status(204).end();
});

// --- Folders: user-made collections ---

canvasRouter.get("/folders", async (_req, res) => {
  const folders = await listFolders(config.ownerPhoneNumber);
  res.json(folders);
});

canvasRouter.post("/folders", async (req, res) => {
  const { name } = req.body as { name?: unknown };

  if (typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "name must be a non-empty string" });
    return;
  }

  const folder = await createFolder(config.ownerPhoneNumber, name);
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

  const updated = await setItemFolder(config.ownerPhoneNumber, id, folderId);
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

  const updated = await updateFolderPosition(config.ownerPhoneNumber, req.params.id, x, y);
  if (!updated) {
    res.status(404).json({ error: "Folder not found" });
    return;
  }
  res.status(204).end();
});
