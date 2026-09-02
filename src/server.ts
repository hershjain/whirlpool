import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "./config.js";
import { webhookRouter } from "./webhook.js";
import { canvasRouter } from "./canvasApi.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.use("/webhook", webhookRouter);
app.use("/api", canvasRouter);
app.use(express.static(path.join(__dirname, "../public")));

app.listen(config.port, () => {
  console.log(`Whirlpool listening on port ${config.port}`);
});
