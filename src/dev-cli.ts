import { randomUUID } from "crypto";
import { handleInboundMessage } from "./commands.js";

const [, , phone, ...bodyParts] = process.argv;
const body = bodyParts.join(" ");

if (!phone || !body) {
  console.error('Usage: npm run dev:cli -- "+15551234567" "https://example.com/article"');
  console.error('       npm run dev:cli -- "+15551234567" "digest"');
  console.error('       npm run dev:cli -- "+15551234567" "what have I saved about cooking"');
  process.exit(1);
}

const messageSid = `TEST_${randomUUID()}`;

handleInboundMessage(phone, body, messageSid)
  .then((reply) => {
    if (reply === null) {
      console.log("\n(captured silently — no reply sent)\n");
      return;
    }
    console.log("\n--- Reply ---\n");
    console.log(reply);
    console.log();
  })
  .catch((error) => {
    console.error("Error:", error);
    process.exit(1);
  });
