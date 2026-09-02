import { Router } from "express";
import { config } from "./config.js";
import { listAllItems, updateItemPosition } from "./repo.js";

export const canvasRouter: Router = Router();

// No real auth yet - single user for now, so every request is scoped to the
// one configured owner. This goes away once magic-link auth exists (Phase 3).

canvasRouter.get("/items", async (_req, res) => {
  const items = await listAllItems(config.ownerPhoneNumber);
  res.json(items);
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
