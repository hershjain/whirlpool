import { randomUUID } from "crypto";
import readline from "readline";
import { config } from "./config.js";
import { handleInboundMessage } from "./commands.js";

// Default to the real owner number so anything captured here shows up in the
// webview too - they filter on the same identity.
const phone = process.argv[2] ?? config.ownerPhoneNumber;

console.log(`Whirlpool dev chat — texting as ${phone}`);
console.log('Type a message and press enter, just like texting from your phone.');
console.log('Type "exit" (or Ctrl+C) to quit.\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
rl.prompt();

rl.on("line", async (line) => {
  const body = line.trim();
  if (!body) {
    rl.prompt();
    return;
  }
  if (body.toLowerCase() === "exit" || body.toLowerCase() === "quit") {
    rl.close();
    return;
  }

  const messageSid = `TEST_${randomUUID()}`;
  try {
    const reply = await handleInboundMessage(phone, body, messageSid);
    if (reply === null) {
      // What you'd see on your phone: nothing. This line only exists so the
      // CLI confirms it actually finished processing, not that it's stuck.
      console.log("(captured — no reply sent)\n");
    } else {
      console.log(`Whirlpool: ${reply}\n`);
    }
  } catch (error) {
    // On real SMS, this is exactly the case that triggers the fallback
    // error text back to your phone - shown here instead of sent.
    console.log("(error — this would have sent an error reply on real SMS)");
    console.error(error, "\n");
  }

  rl.prompt();
});

rl.on("close", () => {
  console.log("\nBye.");
  process.exit(0);
});
