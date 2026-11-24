// The packets of a file, as the demuxer hands them out, each with a hash of its bytes.
//
// The replay buffer of OBS keeps what its encoder gave. Two saves close in time therefore hold the
// very same packets for the time they share, while each file counts its time from zero. Lining up
// two files by their packets finds that shared time exactly, without decoding anything, and tells
// where a file can be cut or joined to another without encoding a single frame again.
const { ffprobe } = require('./ffmpeg');

// Seconds of picture. Below this, a few packets in common are chance, such as a black screen.
const MIN_SHARED = 1;
// Seconds. OBS starts every stream of a save at zero, so the sound of two saves can be a frame apart.
const SOUND_TOLERANCE = 0.1;

function fieldsOf(parts) {
  const fields = {};
  for (const part of parts) {
    const at = part.indexOf('=');
    if (at > 0) fields[part.slice(0, at)] = part.slice(at + 1);
  }
  return fields;
}

const number = (text) => (text === undefined || text === 'N/A' ? NaN : Number(text));

/**
 * { streams: [{ index, type, codec, timeBase, start, extradata, packets }] }, without cover pictures.
 * A packet is { pts, dts, key, hash }, in the order of the file. `timeBase` is in seconds.
 */
function parsePackets(text) {
  const packets = new Map();
  const streams = [];
  for (const line of text.split(/\r?\n/)) {
    const [section, ...parts] = line.split('|');
    if (section === 'packet') {
      const fields = fieldsOf(parts);
      const index = Number(fields.stream_index);
      if (!packets.has(index)) packets.set(index, []);
      const dts = number(fields.dts);
      const pts = number(fields.pts);
      packets.get(index).push({
        pts: Number.isFinite(pts) ? pts : dts,
        dts: Number.isFinite(dts) ? dts : pts,
        key: (fields.flags || '').startsWith('K'),
        hash: `${fields.size}:${fields.data_hash}`,
      });
    } else if (section === 'stream') {
      const fields = fieldsOf(parts);
      const [num, den] = String(fields.time_base).split('/').map(Number);
      streams.push({
        index: Number(fields.index),
        type: fields.codec_type,
        codec: fields.codec_name,
        timeBase: num / den,
        start: Number.isFinite(number(fields.start_time)) ? number(fields.start_time) : 0,
        extradata: fields.extradata_hash || '',
        cover: fields['disposition:attached_pic'] === '1',
      });
    }
  }
  return {
    streams: streams.filter((stream) => !stream.cover && stream.timeBase > 0)
      .map((stream) => ({ ...stream, packets: packets.get(stream.index) || [] })),
  };
}

/** Reading a two-minute 1080p clip takes about half a second: nothing is decoded. */
async function readPackets(file, { signal, low = 'idle' } = {}) {
  const text = await ffprobe([
    '-show_data_hash', 'MD5',
    '-show_entries', 'stream=index,codec_type,codec_name,time_base,start_time,extradata_hash'
      + ':stream_disposition=attached_pic:packet=stream_index,pts,dts,flags,size,data_hash',
    '-of', 'compact', file,
  ], { signal, low });
  return parsePackets(String(text));
}

const timeOf = (stream, i) => stream.packets[i].pts * stream.timeBase;
const videoOf = (file) => file.streams.findIndex((stream) => stream.type === 'video');

/** Same streams, same codecs, same codec settings: what one encoder gives every time. */
function sameLayout(x, y) {
  return x.streams.length === y.streams.length && videoOf(x) >= 0
    && x.streams.every((stream, i) => {
      const other = y.streams[i];
      return stream.type === other.type && stream.codec === other.codec && stream.extradata === other.extradata;
    });
}

/** How many packets b[k] and a[at + k] have in common, or 0 when one of them differs. */
function runFrom(a, b, at) {
  const length = Math.min(a.length - at, b.length);
  for (let k = 0; k < length; k += 1) {
    if (a[at + k].hash !== b[k].hash) return 0;
  }
  return length;
}

/**
 * Where stream `b` starts in stream `a`: the index of `a` from which every packet both still have
 * is the same. Returns { index, shared } or null. `shared` counts the packets in common.
 *
 * Without `near`, a start found twice is a doubt and gives null: a still picture can repeat its
 * packets. With `near`, the time of `a` where b should start, the closest start within `within`
 * seconds wins. This lines up sound by the picture, and silent tracks, all made of one packet.
 */
function findStart(a, b, { near = null, within = SOUND_TOLERANCE } = {}) {
  if (!a.packets.length || !b.packets.length) return null;
  const first = b.packets[0].hash;
  const found = [];
  for (let i = 0; i < a.packets.length; i += 1) {
    if (a.packets[i].hash !== first) continue;
    const distance = near === null ? 0 : Math.abs(timeOf(a, i) - near);
    if (distance > within) continue;
    const shared = runFrom(a.packets, b.packets, i);
    if (shared) found.push({ index: i, shared, distance });
  }
  if (near === null) return found.length === 1 ? found[0] : null;
  return found.sort((p, q) => p.distance - q.distance)[0] || null;
}

/** The time between the first and the last of `count` packets from `index`, in display order. */
function spanOf(stream, index, count) {
  let low = Infinity;
  let high = -Infinity;
  for (let i = index; i < index + count; i += 1) {
    const time = timeOf(stream, i);
    low = Math.min(low, time);
    high = Math.max(high, time);
  }
  return high - low;
}

/**
 * How two files line up: { shift } when they hold the same moments, so that a time t of y is the
 * time t + shift of x, or null. Every stream must agree, sound included: two saves of the same
 * game with another sound setting are not copies of each other.
 */
function align(x, y) {
  if (!sameLayout(x, y)) return null;
  const v = videoOf(x);
  let [first, second, sign] = [x, y, 1];
  let start = findStart(x.streams[v], y.streams[v]);
  if (!start) {
    [first, second, sign] = [y, x, -1];
    start = findStart(y.streams[v], x.streams[v]);
  }
  if (!start || spanOf(first.streams[v], start.index, start.shared) < MIN_SHARED) return null;
  const offset = timeOf(first.streams[v], start.index) - timeOf(second.streams[v], 0);
  for (const [i, stream] of first.streams.entries()) {
    if (i === v) continue;
    const other = second.streams[i];
    if (!stream.packets.length && !other.packets.length) continue;
    if (!other.packets.length || !findStart(stream, other, { near: timeOf(other, 0) + offset })) return null;
  }
  return { shift: sign * offset };
}

/** Whether every packet of y, in every stream, is also in x: y is a copy of a part of x. */
function holds(x, y) {
  if (!sameLayout(x, y)) return false;
  const v = videoOf(x);
  const picture = findStart(x.streams[v], y.streams[v]);
  if (!picture || picture.shared !== y.streams[v].packets.length) return false;
  const offset = timeOf(x.streams[v], picture.index) - timeOf(y.streams[v], 0);
  return x.streams.every((stream, i) => {
    const other = y.streams[i];
    if (i === v || !other.packets.length) return true;
    const start = findStart(stream, other, { near: timeOf(other, 0) + offset });
    return Boolean(start) && start.shared === other.packets.length;
  });
}

/**
 * Where `next` takes over from `prev`, in every stream: `prev` keeps its packets before `index`,
 * and its packet at `index` is the first packet of `next`. Throws when `next` does not start
 * inside `prev` or does not end after it.
 */
function junction(prev, next) {
  if (!sameLayout(prev, next)) throw new Error('Not the same streams.');
  const v = videoOf(prev);
  const picture = findStart(prev.streams[v], next.streams[v]);
  if (!picture || picture.index + picture.shared !== prev.streams[v].packets.length
    || picture.shared >= next.streams[v].packets.length) {
    throw new Error('The files do not follow each other.');
  }
  const offset = timeOf(prev.streams[v], picture.index) - timeOf(next.streams[v], 0);
  return prev.streams.map((stream, i) => {
    if (i === v) return picture;
    const start = findStart(stream, next.streams[i], { near: timeOf(next.streams[i], 0) + offset });
    if (!start || start.index + start.shared !== stream.packets.length) throw new Error('The sound does not follow.');
    return start;
  });
}

/**
 * Where `next` can start so that it no longer repeats `prev`, without encoding: at the last key
 * frame that `prev` still holds, since a cut anywhere else would need the frames before it. Returns
 * { drops, start, left } or null when the shared time is shorter than the gap between key frames.
 * `drops` counts the packets each stream loses, `start` is the time of next where it now begins,
 * and `left` the seconds still in both files.
 */
function trimPlan(prev, next) {
  const starts = junction(prev, next);
  const v = videoOf(next);
  const picture = next.streams[v];
  const { shared } = starts[v];
  let cut = 0;
  for (let i = 0; i <= shared && i < picture.packets.length; i += 1) {
    if (picture.packets[i].key) cut = i;
  }
  if (!cut) return null;
  const start = timeOf(picture, cut);
  const drops = next.streams.map((stream, i) => {
    if (i === v) return cut;
    let drop = 0;
    // Only packets that prev holds, so that not a single sound is lost.
    while (drop < starts[i].shared && timeOf(stream, drop) < start - 1e-6) drop += 1;
    return drop;
  });
  const end = shared < picture.packets.length ? timeOf(picture, shared) : start;
  return { drops, start, left: Math.max(0, end - start) };
}

module.exports = {
  readPackets, parsePackets, findStart, align, holds, junction, trimPlan, sameLayout, videoOf, timeOf, MIN_SHARED,
};
