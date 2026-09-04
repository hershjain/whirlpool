import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "./config.js";
import { webhookRouter } from "./webhook.js";
import { canvasRouter } from "./canvasApi.js";
import { resolveMissingSourceProfiles } from "./sourceProfile.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.use("/webhook", webhookRouter);
app.use("/api", canvasRouter);
app.use(express.static(path.join(__dirname, "../public")));

app.listen(config.port, () => {
  console.log(`Whirlpool listening on port ${config.port}`);

  // Deliberately not awaited - the server must accept requests immediately.
  // Once profiles are warm this is one local read per hostname and logs
  // nothing; it exists so a card never stays grey because a capture-time
  // resolution failed, or because it predates the branding feature.
  resolveMissingSourceProfiles()
    .then((resolved) => {
      if (resolved > 0) console.log(`Resolved ${resolved} source profile(s) on startup.`);
    })
    .catch((error) => console.error("Startup source-profile sweep failed", error));
});
