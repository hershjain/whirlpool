// The per-provider URL parsing, which is where a quiet mistake shows up as a
// card pinned to the wrong continent or a video that never gets a thumbnail.
// Every function under test is pure - no database, no network - so these run
// anywhere the build does.
import test from "node:test";
import assert from "node:assert/strict";

import {
  youTubeVideoId,
  youTubeThumbnail,
  isMusicUrl,
  isPlaceUrl,
  isMapsShortLink,
  parseGoogleMapsUrl,
  googleMapsPlaceName,
  formatCoords,
  mapThumbnailUrl,
  MAP_DEFAULT_ZOOM,
} from "../dist/linkExtract.js";

const VIDEO = "dQw4w9WgXcQ";

test("youTubeVideoId reads the id out of every URL shape YouTube uses", () => {
  const cases = [
    [`https://www.youtube.com/watch?v=${VIDEO}`, VIDEO],
    [`https://www.youtube.com/watch?v=${VIDEO}&list=PLabc&index=2`, VIDEO],
    [`https://youtube.com/watch?v=${VIDEO}`, VIDEO],
    [`https://m.youtube.com/watch?v=${VIDEO}`, VIDEO],
    [`https://youtu.be/${VIDEO}`, VIDEO],
    [`https://youtu.be/${VIDEO}?t=42`, VIDEO],
    [`https://www.youtube.com/shorts/${VIDEO}`, VIDEO],
    [`https://www.youtube.com/embed/${VIDEO}`, VIDEO],
    [`https://www.youtube.com/live/${VIDEO}`, VIDEO],
    [`https://www.youtube-nocookie.com/embed/${VIDEO}`, VIDEO],
  ];
  for (const [url, expected] of cases) {
    assert.equal(youTubeVideoId(url), expected, url);
  }
});

test("youTubeVideoId refuses anything that is not a video", () => {
  const cases = [
    "https://www.youtube.com/@somechannel",
    "https://www.youtube.com/results?search_query=cats",
    "https://www.youtube.com/watch?v=tooshort",
    `https://example.com/watch?v=${VIDEO}`,
    "not a url at all",
  ];
  for (const url of cases) {
    assert.equal(youTubeVideoId(url), null, url);
  }
});

// music.youtube.com is in MUSIC_HOSTNAMES, and the ladder checks music first
// so a song there keeps the artist-under-the-name card rather than becoming a
// video. isVideo on the card is derived from youTubeVideoId alone, so the
// exclusion has to hold here too and not only in the dispatch order.
test("a music.youtube.com link is a song, never a video", () => {
  const url = `https://music.youtube.com/watch?v=${VIDEO}`;
  assert.equal(isMusicUrl(url), true);
  assert.equal(youTubeVideoId(url), null);
});

test("youTubeThumbnail asks for the 16:9 size, not the letterboxed one", () => {
  // hqdefault is 4:3 with black bars baked in; mqdefault is a true 16:9 frame.
  assert.equal(youTubeThumbnail(VIDEO), `https://i.ytimg.com/vi/${VIDEO}/mqdefault.jpg`);
});

// The place pin in the data blob and the viewport centre in @lat,lng are
// different points - the second one moves whenever the map was panned before
// the link was shared - so a URL carrying both must use the pin.
test("parseGoogleMapsUrl prefers the place pin over the viewport centre", () => {
  const url =
    "https://www.google.com/maps/place/Tartine+Bakery/@37.7614,-122.4241,17z/" +
    "data=!3m1!4b1!4m6!3m5!1s0x808f7e3b:0x0!8m2!3d37.76135!4d-122.42413";
  assert.deepEqual(parseGoogleMapsUrl(url), { lat: 37.76135, lng: -122.42413 });
});

test("parseGoogleMapsUrl falls back to the viewport, then to query params", () => {
  assert.deepEqual(parseGoogleMapsUrl("https://www.google.com/maps/@51.5033,-0.1196,15z"), {
    lat: 51.5033,
    lng: -0.1196,
  });
  assert.deepEqual(parseGoogleMapsUrl("https://maps.google.com/?q=48.8584,2.2945"), {
    lat: 48.8584,
    lng: 2.2945,
  });
  assert.deepEqual(
    parseGoogleMapsUrl("https://www.google.com/maps/search/?api=1&query=35.6586,139.7454"),
    { lat: 35.6586, lng: 139.7454 },
  );
});

test("parseGoogleMapsUrl returns null rather than an impossible coordinate", () => {
  // Out of range, and the kind of thing that must never reach a tile URL.
  assert.equal(parseGoogleMapsUrl("https://maps.google.com/?q=999,-122.4"), null);
  assert.equal(parseGoogleMapsUrl("https://maps.google.com/?q=37.7,-999"), null);
  // Names a place without pinning it - the caller still wants the name.
  assert.equal(parseGoogleMapsUrl("https://www.google.com/maps/search/?api=1&query=Tartine"), null);
  assert.equal(parseGoogleMapsUrl("https://example.com/"), null);
});

test("googleMapsPlaceName decodes the name and ignores a bare pin", () => {
  assert.equal(
    googleMapsPlaceName("https://www.google.com/maps/place/Tartine+Bakery/@37.76,-122.42,17z"),
    "Tartine Bakery",
  );
  assert.equal(
    googleMapsPlaceName("https://www.google.com/maps/place/Caf%C3%A9+de+Flore/@48.85,2.33,17z"),
    "Café de Flore",
  );
  assert.equal(
    googleMapsPlaceName("https://www.google.com/maps/search/?api=1&query=Tartine+Bakery"),
    "Tartine Bakery",
  );
  // "/maps/place/@lat,lng" is a spot with no name attached to it.
  assert.equal(googleMapsPlaceName("https://www.google.com/maps/place/@37.76,-122.42,17z"), null);
  // A coordinate pair is a location, not a name.
  assert.equal(googleMapsPlaceName("https://maps.google.com/?q=37.7614,-122.4241"), null);
});

test("isPlaceUrl matches maps links and nothing else on the same domains", () => {
  for (const url of [
    "https://www.google.com/maps/place/Tartine/@37.76,-122.42,17z",
    "https://google.com/maps",
    "https://maps.google.com/?q=1,2",
    "https://maps.app.goo.gl/AbCdEf123",
    "https://goo.gl/maps/AbCdEf123",
    "https://www.google.co.uk/maps/place/Barbican",
  ]) {
    assert.equal(isPlaceUrl(url), true, url);
  }

  for (const url of [
    "https://www.google.com/search?q=maps",
    "https://mail.google.com/mail/u/0",
    "https://goo.gl/AbCdEf123",
    "https://example.com/maps",
    "https://soundcloud.com/artist/track",
  ]) {
    assert.equal(isPlaceUrl(url), false, url);
  }
});

// The two suppression predicates feed the same branch in toItemView, so an
// overlap would be invisible until a card lost the wrong fields.
test("a place is never also music, and a track is never a place", () => {
  assert.equal(isMusicUrl("https://soundcloud.com/artist/track"), true);
  assert.equal(isPlaceUrl("https://soundcloud.com/artist/track"), false);
  assert.equal(isPlaceUrl("https://www.google.com/maps/place/Tartine"), true);
  assert.equal(isMusicUrl("https://www.google.com/maps/place/Tartine"), false);
});

test("isMapsShortLink picks out only the links that need resolving", () => {
  assert.equal(isMapsShortLink("https://maps.app.goo.gl/AbCdEf123"), true);
  assert.equal(isMapsShortLink("https://goo.gl/maps/AbCdEf123"), true);
  assert.equal(isMapsShortLink("https://www.google.com/maps/place/Tartine"), false);
  assert.equal(isMapsShortLink("https://goo.gl/AbCdEf123"), false);
});

test("mapThumbnailUrl is same-origin and rounded to the metre", () => {
  const url = mapThumbnailUrl({ lat: 37.761351234, lng: -122.424131234 });
  assert.equal(url, `/api/map?lat=37.76135&lng=-122.42413&z=${MAP_DEFAULT_ZOOM}`);
  // Same origin is what keeps this off the CSP and away from a third party.
  assert.ok(url.startsWith("/api/"));
  assert.equal(formatCoords({ lat: 37.7614, lng: -122.4241 }), "37.76140, -122.42410");
});
