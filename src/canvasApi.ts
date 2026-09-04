import { Router } from "express";
import { config } from "./config.js";
import { listAllItems, updateItemPosition } from "./repo.js";
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
