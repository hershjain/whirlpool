// The SSRF guard is the one piece of this codebase where a subtle mistake is a
// working read primitive against the private network, so it gets tests even
// though nothing else does yet. Pure enough to run with no database and no
// network: every case below is either an IP literal or a hostname that public
// DNS already answers for.
import test from "node:test";
import assert from "node:assert/strict";

import { assertSafeUrl, BlockedUrlError } from "../dist/safeFetch.js";

async function assertBlocked(url, why) {
  await assert.rejects(
    () => assertSafeUrl(url),
    (error) => {
      assert.ok(error instanceof BlockedUrlError, `${url}: expected BlockedUrlError, got ${error}`);
      return true;
    },
    `${url} should be blocked (${why})`,
  );
}

test("blocks the cloud metadata endpoint", async () => {
  // The one that matters most: on a cloud host this is instance credentials.
  await assertBlocked("http://169.254.169.254/latest/meta-data/", "link-local");
  await assertBlocked("http://169.254.170.2/v2/credentials", "link-local");
});

test("blocks loopback in every spelling", async () => {
  await assertBlocked("http://127.0.0.1/", "loopback");
  await assertBlocked("http://127.1/", "loopback shorthand");
  await assertBlocked("http://[::1]/", "IPv6 loopback");
  // URL parsing rewrites this to [::ffff:7f00:1], so a textual check for a
  // dotted quad inside an IPv6 literal never sees it. Both spellings, plus the
  // deprecated IPv4-compatible form, which is the same trick one prefix over.
  await assertBlocked("http://[::ffff:127.0.0.1]/", "IPv4-mapped loopback");
  await assertBlocked("http://[::ffff:7f00:1]/", "IPv4-mapped loopback, hex form");
  await assertBlocked("http://[::ffff:169.254.169.254]/", "IPv4-mapped metadata endpoint");
  await assertBlocked("http://[::ffff:a00:1]/", "IPv4-mapped private, hex form");
  await assertBlocked("http://[::127.0.0.1]/", "IPv4-compatible loopback");
  await assertBlocked("http://[2002:7f00:1::]/", "6to4 wrapping loopback");
});

test("blocks private and carrier-grade-NAT ranges", async () => {
  await assertBlocked("http://10.0.0.1/", "private /8");
  await assertBlocked("http://172.16.0.1/", "private /12");
  await assertBlocked("http://172.31.255.254/", "private /12 upper bound");
  await assertBlocked("http://192.168.1.1/", "private /16");
  await assertBlocked("http://100.64.0.1/", "CGNAT");
  await assertBlocked("http://[fd00::1]/", "IPv6 unique local");
  await assertBlocked("http://[fe80::1]/", "IPv6 link-local");
});

test("blocks the unspecified address and reserved space", async () => {
  await assertBlocked("http://0.0.0.0/", "unspecified");
  await assertBlocked("http://255.255.255.255/", "broadcast");
  await assertBlocked("http://224.0.0.1/", "multicast");
});

test("blocks non-http schemes", async () => {
  await assertBlocked("file:///etc/passwd", "file scheme");
  await assertBlocked("ftp://example.com/", "ftp scheme");
  await assertBlocked("gopher://example.com/", "gopher scheme");
});

test("blocks non-web ports", async () => {
  // How you reach a service that was never meant to be public.
  await assertBlocked("http://example.com:6379/", "redis");
  await assertBlocked("http://example.com:5432/", "postgres");
  await assertBlocked("http://example.com:22/", "ssh");
});

test("blocks a hostname that resolves into a private range", async () => {
  // localhost is the case that proves the lookup happens rather than a
  // string match on the literal.
  await assertBlocked("http://localhost:80/", "resolves to loopback");
});

test("blocks a malformed URL", async () => {
  await assertBlocked("not-a-url", "unparseable");
  await assertBlocked("http://", "no host");
});

test("allows an ordinary public URL", async (t) => {
  // The only case needing real DNS. Skipped rather than failed when offline,
  // so the suite stays useful on a plane.
  try {
    const url = await assertSafeUrl("https://example.com/some/article");
    assert.equal(url.hostname, "example.com");
  } catch (error) {
    if (error instanceof BlockedUrlError && /Could not resolve/.test(error.message)) {
      t.skip("no DNS available");
      return;
    }
    throw error;
  }
});

test("allows an explicit https port", async (t) => {
  try {
    // URL normalises a scheme-default port away, so this is really asserting
    // that ALLOWED_PORTS treats the empty string as "the default port".
    const url = await assertSafeUrl("https://example.com:443/x");
    assert.equal(url.port, "");
    assert.equal(url.hostname, "example.com");
  } catch (error) {
    if (error instanceof BlockedUrlError && /Could not resolve/.test(error.message)) {
      t.skip("no DNS available");
      return;
    }
    throw error;
  }
});
