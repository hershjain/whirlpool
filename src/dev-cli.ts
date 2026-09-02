import { randomUUID } from "crypto";
import { config } from "./config.js";
import { handleInboundMessage } from "./commands.js";

// The phone number is optional and only needed to simulate a different
// identity - omit it and this uses the real owner number, so captures show
// up in the webview (which filters on that same number).
const args = process.argv.slice(2);
const phone = args[0]?.startsWith("+") ? args.shift()! : config.ownerPhoneNumber;
const body = args.join(" ");

if (!body) {
  console.error('Usage: npm run dev:cli -- "https://example.com/article"');
  console.error('       npm run dev:cli -- "digest"');
  console.error('       npm run dev:cli -- "what have I saved about cooking"');
  console.error('       npm run dev:cli -- "+15551234567" "as a different number"');
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
