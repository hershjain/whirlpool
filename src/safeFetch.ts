import dns from "dns/promises";
import net from "net";

// Whirlpool fetches whatever URL someone texts it. That is the product, and it
// is also a request forgery primitive pointed at everything the server can
// reach but the sender cannot: the cloud metadata endpoint, a database bound to
// localhost, anything else on the private network. The fetched text is stored
// on the item and rendered back on that person's canvas, so the reply channel
// is built in - this is not blind SSRF, it returns the body.
//
// Nothing here restricts what someone may legitimately save. It restricts where
// the *server* will connect on their behalf.

export class BlockedUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedUrlError";
  }
}

// Only the two schemes a saved link can meaningfully have. Everything else -
// file:, gopher:, ftp:, and the redirect targets that try to reach them - is
// refused rather than enumerated as a denylist.
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

// A port is how you reach a service that was never meant to be public: 6379 is
// Redis, 5432 is Postgres, 11211 memcached. Saved links live on the web ports.
const ALLOWED_PORTS = new Set(["", "80", "443"]);

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

function inCidr(ip: string, cidr: string): boolean {
  const [range, bitsRaw] = cidr.split("/");
  const bits = Number(bitsRaw);
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(range) & mask);
}

// Everything that is not a public internet host.
const BLOCKED_V4 = [
  "0.0.0.0/8", // "this network"
  "10.0.0.0/8", // private
  "100.64.0.0/10", // carrier-grade NAT
  "127.0.0.0/8", // loopback
  "169.254.0.0/16", // link-local - this is the cloud metadata range
  "172.16.0.0/12", // private
  "192.0.0.0/24", // IETF protocol assignments
  "192.0.2.0/24", // TEST-NET-1
  "192.168.0.0/16", // private
  "198.18.0.0/15", // benchmarking
  "198.51.100.0/24", // TEST-NET-2
  "203.0.113.0/24", // TEST-NET-3
  "224.0.0.0/4", // multicast
  "240.0.0.0/4", // reserved, includes 255.255.255.255
];

// Expands an IPv6 address to its eight 16-bit groups, or null if it is not one.
//
// Needed because a textual check on IPv6 is a trap: WHATWG URL parsing rewrites
// "::ffff:127.0.0.1" to "::ffff:7f00:1", so a check that looks for a dotted
// quad inside the string sees nothing and waves loopback straight through. The
// only reliable way to ask "what address is this" is to decode it.
function expandIpv6(ip: string): number[] | null {
  let text = ip.toLowerCase();

  // A trailing dotted quad is legal in both mapped and compatible forms.
  // Fold it into two groups before the rest of the parse.
  const dotted = text.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) {
    if (net.isIPv4(dotted[2]) === false) return null;
    const octets = dotted[2].split(".").map(Number);
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    text = `${dotted[1]}${hi}:${lo}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;

  const toGroups = (part: string) =>
    part === "" ? [] : part.split(":").map((group) => parseInt(group, 16));

  const head = toGroups(halves[0]);
  const tail = halves.length === 2 ? toGroups(halves[1]) : [];

  if ([...head, ...tail].some((group) => Number.isNaN(group) || group < 0 || group > 0xffff)) {
    return null;
  }

  if (halves.length === 1) return head.length === 8 ? head : null;

  const gap = 8 - head.length - tail.length;
  if (gap < 0) return null;
  return [...head, ...Array<number>(gap).fill(0), ...tail];
}

function isBlockedAddress(ip: string): boolean {
  const version = net.isIP(ip);

  if (version === 4) {
    return BLOCKED_V4.some((cidr) => inCidr(ip, cidr));
  }

  if (version === 6) {
    const groups = expandIpv6(ip);
    if (!groups) return true; // cannot decode it, so cannot vouch for it

    const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;

    if (groups.every((group) => group === 0)) return true; // ::
    if (groups.slice(0, 7).every((group) => group === 0) && g7 === 1) return true; // ::1

    // IPv4-mapped (::ffff:a.b.c.d) and the deprecated IPv4-compatible (::a.b.c.d).
    // Both carry a v4 address in the last two groups, and both are the obvious
    // way to smuggle 127.0.0.1 past a v4-only check.
    const firstFiveZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
    if (firstFiveZero && (g5 === 0xffff || g5 === 0)) {
      const v4 = [g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff].join(".");
      return isBlockedAddress(v4);
    }

    if ((g0 & 0xfe00) === 0xfc00) return true; // unique local, fc00::/7
    if ((g0 & 0xffc0) === 0xfe80) return true; // link-local, fe80::/10
    if ((g0 & 0xff00) === 0xff00) return true; // multicast, ff00::/8
    if (g0 === 0x2002) return true; // 6to4 - the embedded v4 can be anything
    if (g0 === 0x0064 && g1 === 0xff9b) return true; // NAT64, 64:ff9b::/96

    return false;
  }

  // Not an IP literal at all. Callers resolve first, so reaching here means
  // something upstream is wrong; refuse rather than guess.
  return true;
}

// Resolves the hostname and refuses if *any* address it answers with is
// non-public. Checking every answer rather than the first matters: a host can
// return a public address and a loopback one and let the client pick.
//
// Residual risk, stated rather than papered over: this resolves the name here
// and the connection resolves it again, so a DNS record with a one-second TTL
// can answer publicly for the check and privately for the connection. Closing
// that needs a custom lookup pinned to the validated address, which undici does
// not make reachable through global fetch. The window is small and the ranges
// above are the ones that matter; it is worth knowing it exists.
export async function assertSafeUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BlockedUrlError(`Not a valid URL: ${rawUrl}`);
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new BlockedUrlError(`Refusing to fetch ${url.protocol} URL`);
  }
  if (!ALLOWED_PORTS.has(url.port)) {
    throw new BlockedUrlError(`Refusing to fetch a non-web port: ${url.port}`);
  }

  // Strip the brackets IPv6 literals carry in a URL host.
  const hostname = url.hostname.replace(/^\[|\]$/g, "");

  // An IP literal needs no lookup, and must not get one - dns.lookup would
  // happily hand it straight back and skip the check.
  if (net.isIP(hostname)) {
    if (isBlockedAddress(hostname)) {
      throw new BlockedUrlError(`Refusing to fetch a non-public address: ${hostname}`);
    }
    return url;
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch {
    throw new BlockedUrlError(`Could not resolve ${hostname}`);
  }

  if (addresses.length === 0) {
    throw new BlockedUrlError(`${hostname} resolved to nothing`);
  }

  for (const { address } of addresses) {
    if (isBlockedAddress(address)) {
      throw new BlockedUrlError(`${hostname} resolves to a non-public address (${address})`);
    }
  }

  return url;
}

// Reads at most maxBytes and aborts the moment the limit is passed.
//
// The body used to be read with a bare res.text(), with no ceiling, straight
// into JSDOM. One large page - deliberate or a mis-served file - was enough to
// exhaust the heap on a 512MB machine, and a Content-Length header is a claim
// by the server rather than a fact, so the count has to be real.
async function readCapped(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new BlockedUrlError(`Response exceeded ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks);
}

// The subset of Response the callers actually use. Same member names, so
// linkExtract and sourceProfile read unchanged - but the body is already read
// and capped by the time they see it, and `url` is the final URL after
// redirects, each of which was validated on the way.
export interface SafeResponse {
  ok: boolean;
  status: number;
  url: string;
  headers: Headers;
  text(): Promise<string>;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface SafeFetchOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
}

const MAX_REDIRECTS = 3;

export async function safeFetch(
  rawUrl: string,
  { headers = {}, timeoutMs, maxBytes }: Required<Pick<SafeFetchOptions, "timeoutMs" | "maxBytes">> &
    SafeFetchOptions,
): Promise<SafeResponse> {
  // One deadline for the whole exchange - every redirect hop and the body read
  // together. The previous timer was cleared as soon as fetch() resolved, which
  // is when the *headers* arrive, so a server that dribbled a body out slowly
  // held a background job open indefinitely.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let current = await assertSafeUrl(rawUrl);

    for (let hop = 0; ; hop++) {
      // Manual, not "follow". Validating only the URL someone texted is no
      // guard at all: a public host answering 302 with a Location of
      // http://169.254.169.254/ lands exactly where the check was meant to
      // prevent, and fetch follows up to twenty of those by default.
      const res = await fetch(current, {
        headers,
        signal: controller.signal,
        redirect: "manual",
      });

      const isRedirect = res.status >= 300 && res.status < 400 && res.headers.has("location");
      if (!isRedirect) {
        const bytes = await readCapped(res.body, maxBytes);
        return {
          ok: res.ok,
          status: res.status,
          url: current.toString(),
          headers: res.headers,
          text: async () => bytes.toString("utf-8"),
          json: async () => JSON.parse(bytes.toString("utf-8")) as unknown,
          arrayBuffer: async () =>
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
        };
      }

      if (hop >= MAX_REDIRECTS) {
        throw new BlockedUrlError(`More than ${MAX_REDIRECTS} redirects from ${rawUrl}`);
      }

      // Discard the redirect's own body rather than leaving the socket open.
      await res.body?.cancel();

      const location = res.headers.get("location")!;
      // Relative Locations are legal and common, so resolve against the hop we
      // are on - then validate the result like any other URL.
      current = await assertSafeUrl(new URL(location, current).toString());
    }
  } finally {
    clearTimeout(timer);
  }
}
