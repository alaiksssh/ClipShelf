// Reads kills and deaths from the kill feed of a Valorant video.
//
// Only pictures of the saved file are looked at: nothing here talks to the game. There are two cases.
// - While playing, the game draws the entries of the player with a yellow block: on the left for a
//   kill, on the right for a death.
// - In the replay viewer nothing is highlighted. The name of the followed player, shown at the bottom
//   left, is then looked for in the entries: first is the killer, last is the victim.
//
// Rounds are told apart by the score at the top: one of its numbers changes when a round ends.
//
// Positions are those of a 1080p picture. Four parts of it are stacked into one small frame:
// the kill feed, the name plate, the "Show Replay UI" key that only the replay viewer has, and the score.
const WIDTH = 692;
const FEED_TOP = 80;
const FEED_HEIGHT = 324;
const PLATE = { x: 100, y: 816, width: 380, height: 40, at: FEED_HEIGHT };
const KEY = { fromRight: 338, y: 854, width: 44, height: 44, at: FEED_HEIGHT + PLATE.height };
const SCORE = { width: 380, y: 34, height: 30, at: KEY.at + KEY.height };
const HEIGHT = SCORE.at + SCORE.height;
const FRAME_BYTES = WIDTH * HEIGHT * 3;
const FPS = 4;

const part = (x, y, width, height) => `crop=${width}:${height}:${x}:${y},pad=${WIDTH}:${height}:0:0`;

const FILTER = [
  // Scaled first: crops land on even pixels, which would be 3 pixels off in a 720p picture.
  `fps=${FPS},scale=-2:1080,split=4[a][b][c][d]`,
  `[a]${part(`iw-${WIDTH}`, FEED_TOP, WIDTH, FEED_HEIGHT)}[feed]`,
  `[b]${part(PLATE.x, PLATE.y, PLATE.width, PLATE.height)}[plate]`,
  `[c]${part(`iw-${KEY.fromRight}`, KEY.y, KEY.width, KEY.height)}[key]`,
  `[d]${part(`(iw-${SCORE.width})/2`, SCORE.y, SCORE.width, SCORE.height)}[score]`,
  '[feed][plate][key][score]vstack=4',
].join(';');

// An entry settles in one of these places, whatever the map or the mode.
const RIGHT = 673;
const ROW = 34;
const PLACES = [16, 55, 94, 133, 172, 211, 250];
const PLACE_SLACK = 3;
const NAME_RIGHT = 604; // Where the name of a victim ends.
const TEXT = [200, NAME_RIGHT + 2];
const TEXT_STEP = 3;
const COVERED_FROM = 500;
const NAME_SCALE = 0.653; // From the name plate to the kill feed.

const SAME = 0.72;
const LIFETIME = 4.25; // Seconds an entry stays, at least.
const HALVES = 0.4; // Likeness of two halves of one entry.
const HALVES_GAP = 1; // Seconds between two halves.
const FORGET = 2.5; // Seconds an entry may be hidden, by a flash for instance.
const SIGHTINGS = 2;
const HIGHLIGHTED = 0.3; // Of the sightings: yellow scenery passes by, a highlight stays.
const NAME_MATCH = 0.57;
const NAME_TRIES = 6;
const PLATE_MEMORY = 4; // Seconds.

const isYellow = (r, g, b) => r > 180 && g > 185 && g - b > 45 && Math.abs(r - g) < 38;
const isRed = (r, g, b) => r > 120 && r - g > 45 && r - b > 30;
const isGreen = (r, g, b) => g > 100 && g - r > 22 && g - b > -8;
const isSolid = (r, g, b) => isYellow(r, g, b)
  || (r > 165 && r - g > 55 && r - b > 45)
  || (g > 140 && g - r > 28 && g - b > 2 && b > 95);

function test(frame, x, y, check) {
  const i = (y * WIDTH + x) * 3;
  return check(frame[i], frame[i + 1], frame[i + 2]);
}

/** How white a pixel is, from 0 to 255: names and weapons are white, backgrounds rarely are. */
function whiteness(frame, x, y) {
  const i = (y * WIDTH + x) * 3;
  const low = Math.min(frame[i], frame[i + 1], frame[i + 2]);
  const high = Math.max(frame[i], frame[i + 1], frame[i + 2]);
  return high - low > 70 || low < 150 ? 0 : Math.min(255, (low - 150) * 2.6);
}

/** The part of a rectangle that has a colour. */
function share(frame, [left, right], [top, bottom], check, step = 2) {
  let hits = 0;
  let count = 0;
  for (let y = top; y < bottom; y += step) {
    for (let x = left; x < right; x += step) {
      count += 1;
      if (test(frame, x, y, check)) hits += 1;
    }
  }
  return count ? hits / count : 0;
}

const inner = (top) => [top + 4, top + ROW - 3];

/** Whether yellow fills a column over the height of an entry, and not much more. */
function block(frame, x, top) {
  let hits = 0;
  for (let y = top + 2; y < top + ROW - 2; y += 1) {
    if (test(frame, x, y, isYellow)) hits += 1;
  }
  if (hits < 25) return false;
  return !test(frame, x, top - 5, isYellow) || !test(frame, x, top + ROW + 4, isYellow);
}

function ownKind(frame, top) {
  const span = inner(top);
  const died = block(frame, RIGHT - 3, top) && share(frame, [RIGHT - 190, RIGHT - 50], span, isGreen) >= 0.12;
  if (died) {
    // Not a death when the other side is the team too: that is a resurrection.
    const killer = [RIGHT - 420, RIGHT - 170];
    const red = share(frame, killer, span, isRed);
    return red >= 0.08 && red > share(frame, killer, span, isGreen) ? 'death' : null;
  }
  if (share(frame, [RIGHT - 110, RIGHT], span, isRed) < 0.12) return null;
  for (let x = 20; x < RIGHT - 170; x += 2) {
    if (block(frame, x, top) && share(frame, [x + 50, Math.min(RIGHT - 60, x + 260)], span, isGreen) >= 0.14) return 'kill';
  }
  return null;
}

/** Pearson correlation of two grey pictures of one size. */
function correlation(a, b) {
  let sumA = 0;
  let sumB = 0;
  let squareA = 0;
  let squareB = 0;
  let product = 0;
  for (let i = 0; i < a.length; i += 1) {
    sumA += a[i];
    sumB += b[i];
    squareA += a[i] * a[i];
    squareB += b[i] * b[i];
    product += a[i] * b[i];
  }
  const n = a.length;
  const spread = Math.sqrt((n * squareA - sumA * sumA) * (n * squareB - sumB * sumB));
  return spread ? (n * product - sumA * sumB) / spread : 0;
}

function grey(frame, [left, right], [top, bottom], step = 1) {
  const out = new Uint8Array(Math.ceil((right - left) / step) * (bottom - top));
  let at = 0;
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += step) out[at++] = whiteness(frame, x, y);
  }
  return out;
}

/** What tells two entries apart: their names and weapon. */
const textOf = (frame, top) => grey(frame, [...TEXT], [top + 7, top + 28], TEXT_STEP);

/** The text without its end, which the network graph of the game can cover. */
function uncovered(text) {
  const columns = Math.ceil((TEXT[1] - TEXT[0]) / TEXT_STEP);
  const kept = Math.ceil((COVERED_FROM - TEXT[0]) / TEXT_STEP);
  return text.filter((_, i) => i % columns < kept);
}

/** Red on one side and green on the other: no scenery does that over the height of an entry. */
function twoTeams(frame, top) {
  const span = inner(top);
  const victim = [520, 612];
  const killer = [330, 480];
  return (share(frame, victim, span, isRed, 3) >= 0.5 && share(frame, killer, span, isGreen, 3) >= 0.3)
    || (share(frame, victim, span, isGreen, 3) >= 0.5 && share(frame, killer, span, isRed, 3) >= 0.3);
}

/** The entries in one picture: [{ top, own, texts }]. */
function readFeed(frame) {
  const rows = [];
  for (const place of PLACES) {
    let best = null;
    for (let top = place - PLACE_SLACK; top <= place + PLACE_SLACK; top += 1) {
      const span = [top + 1, top + ROW - 1];
      const score = Math.max(share(frame, [606, 611], span, isSolid, 1), share(frame, [668, 673], span, isSolid, 1));
      const closer = best && score === best.score && Math.abs(top - place) < Math.abs(best.top - place);
      if (!best || score > best.score || closer) best = { top, score };
    }
    let { top } = best;
    let own = null;
    if (best.score >= 0.75) own = ownKind(frame, top);
    else if (twoTeams(frame, place)) {
      top = place;
      own = ownKind(frame, top);
    } else {
      // Over a bright picture an entry turns pale, but its yellow stays.
      for (top = place - 2; top <= place + 2 && !own; top += 2) own = ownKind(frame, top);
      if (!own) continue;
      top -= 2;
    }
    const span = inner(top);
    // A name is white. A coloured wall has none.
    if (share(frame, [420, NAME_RIGHT], span, (r, g, b) => r > 200 && g > 200 && b > 200, 1) < 0.015) continue;
    rows.push({ top, own, texts: [-1, 0, 1].map((shift) => textOf(frame, top + shift)) });
  }
  return rows;
}

/** The name on the plate of the followed player, scaled to the size it has in the kill feed. */
function readPlate(frame) {
  const top = PLATE.at;
  const columns = [];
  for (let x = 14; x < PLATE.width; x += 1) {
    let white = 0;
    for (let y = top + 8; y < top + 32; y += 1) if (whiteness(frame, x, y) > 150) white += 1;
    if (white) columns.push(x);
  }
  if (!columns.length || columns[0] < 16 || columns[0] > 26) return null;
  let end = columns[0];
  for (const x of columns) {
    if (x - end > 16) break;
    end = x;
  }
  if (end - columns[0] < 18 || end > PLATE.width - 8) return null;
  // Text has empty space above it. A white background doesn't.
  if (share(frame, [columns[0], end], [top, top + 4], (r, g, b) => r > 220 && g > 220 && b > 220, 1) > 0.15) return null;

  const left = columns[0] - 1;
  const width = Math.round((end + 2 - left) * NAME_SCALE);
  const height = Math.round(26 * NAME_SCALE);
  const pixels = new Uint8Array(width * height);
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      // Average of the pixels this one covers.
      let sum = 0;
      for (const dy of [0.25, 0.75]) {
        for (const dx of [0.25, 0.75]) {
          sum += whiteness(frame, left + Math.floor((column + dx) / NAME_SCALE), top + 7 + Math.floor((row + dy) / NAME_SCALE));
        }
      }
      pixels[row * width + column] = sum / 4;
    }
  }
  return { width, height, pixels };
}

/** Where a name is in an entry: 'kill' when it comes first, 'death' when it comes last. */
function findName(frame, top, name) {
  const best = { kill: 0, death: 0 };
  const { width, height, pixels } = name;
  const at = (x, y) => correlation(pixels, grey(frame, [x, x + width], [y, y + height]));
  const middle = top + Math.round((ROW - height) / 2);

  for (let x = NAME_RIGHT - width - 4; x <= NAME_RIGHT - width + 5; x += 1) {
    for (let y = middle - 2; y <= middle + 2; y += 1) best.death = Math.max(best.death, at(x, y));
  }
  // Coarse, then around the most promising place.
  let near = { x: 0, score: -1 };
  for (let x = 40; x < NAME_RIGHT - width - 60; x += 2) {
    const score = at(x, middle);
    if (score > near.score) near = { x, score };
  }
  if (near.score > 0.3) {
    for (let x = near.x - 2; x <= near.x + 2; x += 1) {
      for (let y = middle - 2; y <= middle + 2; y += 1) best.kill = Math.max(best.kill, at(x, y));
    }
  }
  return best;
}

/** The replay viewer shows a dark "T" in a pale square, next to "Show Replay UI". */
function hasReplayKey(frame) {
  const pale = (r, g, b) => Math.min(r, g, b) > 160 && Math.max(r, g, b) - Math.min(r, g, b) < 45;
  const dark = (r, g, b) => Math.max(r, g, b) < 135;
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      const area = (left, right, top, bottom, check) =>
        share(frame, [left + dx, right + dx], [KEY.at + top + dy, KEY.at + bottom + dy], check, 1);
      if (area(15, 23, 16, 19, dark) < 0.6 || area(18, 21, 20, 28, dark) < 0.6) continue; // The T.
      if (area(5, 12, 9, 35, pale) < 0.85 || area(25, 33, 9, 35, pale) < 0.85) continue; // Either side of it.
      if (area(5, 33, 9, 14, pale) >= 0.85 && area(5, 33, 30, 35, pale) >= 0.85) return true;
    }
  }
  return false;
}

// The two numbers of the score, in the score part: left team, right team.
const SCORE_BOXES = [[25, 81], [298, 356]];
const SCORE_SAME = 0.6; // Overlap of two readings of one number.
const SCORE_STEADY = 6; // Pictures, a second and a half: what blinks or flies by is not a new score.
const SCORE_JOIN = 4; // Seconds: both numbers change together at half time.
const BUSY_ROUNDS = 4; // Changes within ...
const BUSY_SECONDS = 25; // ... this long: a mode without rounds, where the score counts kills.

/** The white pixels of one number, or null when the picture can't be trusted. */
function scoreMask(frame, [left, right]) {
  const top = SCORE.at;
  const width = right - left;
  const mask = new Uint8Array(width * SCORE.height);
  let count = 0;
  let edges = 0;
  for (let y = 0; y < SCORE.height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = ((top + y) * WIDTH + left + x) * 3;
      const low = Math.min(frame[i], frame[i + 1], frame[i + 2]);
      const high = Math.max(frame[i], frame[i + 1], frame[i + 2]);
      if (low <= 200 || high - low >= 50) continue;
      mask[y * width + x] = 1;
      count += 1;
      if (y < 4 || y >= SCORE.height - 3 || x < 3 || x >= width - 3) edges += 1;
    }
  }
  // Digits keep away from the edges of their box. A white wall behind does not.
  return count >= 20 && count <= 420 && edges <= 4 ? mask : null;
}

function overlap(a, b) {
  let both = 0;
  let any = 0;
  for (let i = 0; i < a.length; i += 1) {
    both += a[i] & b[i];
    any += a[i] | b[i];
  }
  return any ? both / any : 1;
}

/** Times at which the score changed, as each new score settles. */
class Rounds {
  constructor() {
    this.sides = SCORE_BOXES.map((box) => ({ box, stable: null, candidate: null, seen: 0, since: 0 }));
    this.changes = [];
  }

  push(frame, time) {
    for (const side of this.sides) {
      const mask = scoreMask(frame, side.box);
      if (!mask) continue;
      if (side.stable && overlap(mask, side.stable) >= SCORE_SAME) {
        side.candidate = null;
        continue;
      }
      if (side.candidate && overlap(mask, side.candidate) >= SCORE_SAME) side.seen += 1;
      else Object.assign(side, { candidate: mask, seen: 1, since: time });
      if (side.seen < SCORE_STEADY) continue;
      if (side.stable) this.changes.push(side.since);
      Object.assign(side, { stable: side.candidate, candidate: null });
    }
  }

  /** Where each round after the first starts, or null in a mode without rounds. */
  result() {
    const starts = [];
    for (const time of [...this.changes].sort((a, b) => a - b)) {
      if (!starts.length || time - starts.at(-1) > SCORE_JOIN) starts.push(time);
    }
    const busy = starts.some((time, i) => i >= BUSY_ROUNDS - 1 && time - starts[i - BUSY_ROUNDS + 1] < BUSY_SECONDS);
    return busy ? null : starts;
  }
}

/** Follows entries from one picture to the next, so that each one counts once. */
class KillFeed {
  constructor() {
    this.entries = [];
    this.active = [];
    this.replay = false;
    this.keys = 0;
    this.name = null;
    this.rounds = new Rounds();
  }

  push(frame, time) {
    // Twice, so that one odd picture cannot change how the whole clip is read.
    if (!this.replay && hasReplayKey(frame)) this.replay = (this.keys += 1) >= 2;
    const plate = readPlate(frame);
    if (plate) this.name = { ...plate, time };
    this.rounds.push(frame, time);

    for (const entry of this.follow(readFeed(frame), time)) {
      if (entry.sightings === 1 && this.name && time - this.name.time <= PLATE_MEMORY) entry.name = this.name;
      if (!entry.name || entry.tries >= NAME_TRIES) continue;
      entry.tries += 1;
      const { kill, death } = findName(frame, entry.top, entry.name);
      entry.named.kill = Math.max(entry.named.kill, kill);
      entry.named.death = Math.max(entry.named.death, death);
    }
  }

  /** Returns the entries seen at this time. */
  follow(rows, time) {
    this.active = this.active.filter((entry) => time - entry.lastTime <= FORGET);
    const pairs = [];
    for (const row of rows) {
      for (const entry of this.active) {
        // Entries only ever slide up.
        if (row.top > entry.top + PLACE_SLACK * 2) continue;
        const score = Math.max(...row.texts.map((text) => correlation(text, entry.text)));
        if (score >= SAME) pairs.push({ row, entry, score: score - (entry.top - row.top) / 5000 });
      }
    }

    const matched = new Set();
    const seen = [];
    for (const { row, entry } of pairs.sort((a, b) => b.score - a.score)) {
      if (matched.has(row) || matched.has(entry)) continue;
      matched.add(row).add(entry);
      Object.assign(entry, { top: row.top, text: row.texts[1], lastTime: time, sightings: entry.sightings + 1 });
      entry.times.add(time);
      if (row.own) entry.own[row.own] += 1;
      seen.push(entry);
    }
    for (const row of rows) {
      if (matched.has(row)) continue;
      const entry = {
        top: row.top,
        text: row.texts[1],
        firstTexts: row.texts,
        firstTime: time,
        lastTime: time,
        sightings: 1,
        times: new Set([time]),
        own: { kill: 0, death: 0 },
        named: { kill: 0, death: 0 },
        tries: 0,
      };
      if (row.own) entry.own[row.own] += 1;
      this.entries.push(entry);
      this.active.push(entry);
      seen.push(entry);
    }
    return seen;
  }

  kindOf({ own, named, sightings }) {
    if (!this.replay) {
      const highlighted = Math.max(own.kill, own.death);
      if (highlighted < SIGHTINGS || highlighted < sightings * HIGHLIGHTED) return null;
      return own.kill >= own.death ? 'kill' : 'death';
    }
    const kill = named.kill >= NAME_MATCH;
    const death = named.death >= NAME_MATCH;
    if (kill === death) return null; // Neither, or a resurrection of oneself.
    return kill ? 'kill' : 'death';
  }

  /**
   * An entry whose text got covered while it slid is seen as a new one. Two entries that started
   * less than a lifetime apart are shown together at some point, two halves of one never are.
   */
  otherHalf(entry, kind, kept) {
    return kept.find((other) => other.kind === kind
      && entry.firstTime - other.firstTime < LIFETIME
      && entry.firstTime - other.lastTime <= HALVES_GAP
      && ![...entry.times].some((time) => other.times.has(time))
      && entry.firstTexts.some((first) => other.sides.some((side) =>
        correlation(uncovered(first), uncovered(side)) >= HALVES)));
  }

  /** What already showed on the first picture happened before the clip. */
  result() {
    const kept = [];
    for (const entry of this.entries) {
      if (entry.sightings < SIGHTINGS) continue;
      const kind = this.kindOf(entry);
      if (!kind) continue;
      const half = this.otherHalf(entry, kind, kept);
      if (half) {
        half.times = new Set([...half.times, ...entry.times]);
        half.lastTime = Math.max(half.lastTime, entry.lastTime);
        half.sides.push(entry.text, entry.firstTexts[1]);
      } else {
        kept.push({ kind, firstTime: entry.firstTime, lastTime: entry.lastTime, times: entry.times, sides: [entry.text, entry.firstTexts[1]] });
      }
    }
    const events = kept
      .filter((entry) => entry.firstTime > 0)
      .map((entry) => ({ kind: entry.kind, time: Math.max(0, entry.firstTime - 0.5 / FPS) }));
    return { replay: this.replay, events, rounds: this.rounds.result() };
  }
}

module.exports = { KillFeed, Rounds, SCORE, SCORE_BOXES, WIDTH, FEED_HEIGHT, HEIGHT, FRAME_BYTES, FPS, FILTER, ROW };
