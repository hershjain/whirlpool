import express from "express";
import { config } from "./config.js";
import { webhookRouter } from "./webhook.js";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use("/webhook", webhookRouter);

app.listen(config.port, () => {
  console.log(`Whirlpool listening on port ${config.port}`);
});
