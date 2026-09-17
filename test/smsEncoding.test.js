// SMS billing is per segment, and the segment size depends on the encoding of
// the whole message. One character outside GSM-7 - an em dash, a curly
// apostrophe, an ellipsis - re-encodes every character as UCS-2 and drops the
// segment from 153 characters to 67. Nothing about the delivered message looks
// any different, so the only thing that catches it is an assertion.
//
// The welcome message is the one message every user receives, and it sat at
// 191 characters with an em dash in it: three billed segments where two would
// do. This file exists so the next typographic dash in that string fails a test
// instead of quietly raising the per-user cost.
import test from "node:test";
import assert from "node:assert/strict";

// Set before config.ts is loaded, and http on purpose: config refuses an https
// origin unless NODE_ENV=production, since that combination would mean a real
// deployment running with the dev-login bypass on. Length barely matters here -
// GSM-7 gives 306 characters across two segments and this message uses 187, so
// a longer production origin does not change the count.
process.env.PUBLIC_BASE_URL = "http://localhost:3000";

const { welcomeMessage } = await import("../dist/notify.js");

// The GSM 03.38 basic alphabet, plus the extension table whose characters are
// legal but bill as two septets each.
const GSM_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡" +
  "ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXTENDED = "^{}\\[~]|€";

function nonGsmCharacters(text) {
  return [...text].filter((ch) => !GSM_BASIC.includes(ch) && !GSM_EXTENDED.includes(ch));
}

function segments(text) {
  if (nonGsmCharacters(text).length > 0) {
    return text.length <= 70 ? 1 : Math.ceil(text.length / 67);
  }
  const septets = [...text].reduce((n, ch) => n + (GSM_EXTENDED.includes(ch) ? 2 : 1), 0);
  return septets <= 160 ? 1 : Math.ceil(septets / 153);
}

test("the welcome message is entirely GSM-7", () => {
  const offenders = nonGsmCharacters(welcomeMessage());
  assert.deepEqual(
    offenders,
    [],
    `these characters force the whole message to UCS-2: ${JSON.stringify(offenders.join(""))}`,
  );
});

test("the welcome message costs two segments, not three", () => {
  const body = welcomeMessage();
  assert.equal(segments(body), 2);
  // The headroom that makes the assertion above robust to a longer origin.
  assert.ok(body.length <= 306, `${body.length} characters leaves no room in two GSM-7 segments`);
});

// Guards the helper itself: without this, a bug that reported everything as
// GSM-7 would make the test above pass for the wrong reason.
test("one non-GSM character is enough to add a segment", () => {
  const plain = welcomeMessage();
  const withEmDash = plain.replace(" - ", " — ");

  assert.deepEqual(nonGsmCharacters(withEmDash), ["—"]);
  assert.equal(segments(withEmDash), segments(plain) + 1);
});
