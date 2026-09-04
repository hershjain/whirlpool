// Colour helpers for card accent bars. No dependencies - the only heavy step
// (decoding a favicon image) happens in the browser, which decodes .ico/.svg/
// .png natively for free. See public/canvas.js.

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

// Accent bars sit on a white card, so very light colours vanish and very dark
// ones all read as black. Keep lightness inside a band that stays legible.
const MIN_LIGHTNESS = 0.22;
const MAX_LIGHTNESS = 0.62;

export function parseHex(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const match = raw.trim().match(HEX_RE);
  if (!match) return null;
  let hex = match[1].toLowerCase();
  if (hex.length === 3) {
    hex = hex
      .split("")
      .map((c) => c + c)
      .join("");
  }
  return `#${hex}`;
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(r: number, g: number, b: number): string {
  const to2 = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0");
  return `#${to2(r)}${to2(g)}${to2(b)}`;
}

export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];

  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return [h, s, l];
}

export function hslToHex(h: number, s: number, l: number): string {
  if (s === 0) {
    const v = l * 255;
    return rgbToHex(v, v, v);
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  return rgbToHex(channel(h + 1 / 3) * 255, channel(h) * 255, channel(h - 1 / 3) * 255);
}

export function clampForLegibility(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  const [h, s, l] = rgbToHsl(r, g, b);
  if (l >= MIN_LIGHTNESS && l <= MAX_LIGHTNESS) return hex;
  const clamped = Math.min(MAX_LIGHTNESS, Math.max(MIN_LIGHTNESS, l));
  // A pure-white favicon has no hue worth keeping; give it a little so the bar
  // doesn't just read as grey.
  return hslToHex(h, s === 0 ? 0 : Math.max(s, 0.25), clamped);
}

// Stable per-domain colour so a site without a theme-color or usable favicon
// still gets a consistent, distinct bar instead of looking broken.
export function domainHashColor(domain: string): string {
  let hash = 0;
  for (let i = 0; i < domain.length; i++) {
    hash = (hash * 31 + domain.charCodeAt(i)) >>> 0;
  }
  const hue = (hash % 360) / 360;
  return hslToHex(hue, 0.5, 0.45);
}
