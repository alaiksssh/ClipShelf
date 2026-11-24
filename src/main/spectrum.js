// Streaming spectrogram: memory use is constant whatever the length of the recording.

const SIZE = 512;
const BANDS = 64;
const FLOOR_DB = -88;
const CEIL_DB = -18;
const MIN_HZ = 70;

const HANN = Float64Array.from({ length: SIZE }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (SIZE - 1)));
const COS = Float64Array.from({ length: SIZE / 2 }, (_, i) => Math.cos((2 * Math.PI * i) / SIZE));
const SIN = Float64Array.from({ length: SIZE / 2 }, (_, i) => -Math.sin((2 * Math.PI * i) / SIZE));
const REVERSED = Uint16Array.from({ length: SIZE }, (_, i) => {
  let result = 0;
  for (let bit = 1; bit < SIZE; bit *= 2) result = result * 2 + (i & bit ? 1 : 0);
  return result;
});

/** In-place radix-2 FFT. `re` and `im` must already be in bit-reversed order. */
function fft(re, im) {
  for (let length = 2; length <= SIZE; length *= 2) {
    const step = SIZE / length;
    const half = length / 2;
    for (let start = 0; start < SIZE; start += length) {
      for (let k = 0; k < half; k += 1) {
        const low = start + k;
        const high = low + half;
        const cos = COS[k * step];
        const sin = SIN[k * step];
        const r = re[high] * cos - im[high] * sin;
        const i = re[high] * sin + im[high] * cos;
        re[high] = re[low] - r;
        im[high] = im[low] - i;
        re[low] += r;
        im[low] += i;
      }
    }
  }
}

class Spectrogram {
  constructor(columns, totalSamples, rate) {
    this.columns = columns;
    this.perColumn = Math.max(1, totalSamples / columns);
    // Windows are averaged: keeping the loudest one turns speech into hard vertical stripes.
    this.hop = Math.max(1, Math.floor(this.perColumn > SIZE ? this.perColumn / 4 : this.perColumn));
    this.sums = new Float32Array(columns * BANDS); // Band by band, lowest frequency first.
    this.hits = new Uint16Array(columns);
    this.ring = new Float32Array(SIZE);
    this.re = new Float64Array(SIZE);
    this.im = new Float64Array(SIZE);
    this.power = new Float64Array(SIZE / 2);
    this.count = 0;

    // Logarithmic bands: voices and footsteps live in the low frequencies.
    const nyquist = rate / 2;
    this.edges = Array.from({ length: BANDS + 1 }, (_, i) =>
      (MIN_HZ * (nyquist / MIN_HZ) ** (i / BANDS) / nyquist) * (SIZE / 2 - 1));
  }

  push(sample) {
    this.ring[this.count % SIZE] = sample / 32768;
    this.count += 1;
    if (this.count % this.hop === 0) this.measure(this.count);
  }

  measure(end) {
    const column = Math.floor((end - SIZE / 2) / this.perColumn);
    if (column < 0 || column >= this.columns) return;

    const { re, im, ring, edges, power, sums } = this;
    for (let i = 0; i < SIZE; i += 1) re[REVERSED[i]] = ring[(end + i) % SIZE] * HANN[i];
    im.fill(0);
    fft(re, im);
    for (let k = 0; k < SIZE / 2; k += 1) power[k] = re[k] * re[k] + im[k] * im[k];

    for (let band = 0; band < BANDS; band += 1) {
      const from = edges[band];
      const to = edges[band + 1];
      let value = 0;
      if (to - from < 1) {
        // Narrower than a bin: interpolate, or low frequencies would show as blocks.
        const middle = (from + to) / 2;
        const k = Math.min(SIZE / 2 - 2, Math.floor(middle));
        value = power[k] + (power[k + 1] - power[k]) * (middle - k);
      } else {
        for (let k = Math.floor(from); k < to; k += 1) value = Math.max(value, power[k]);
      }
      sums[band * this.columns + column] += value;
    }
    this.hits[column] += 1;
  }

  /** One byte per band and column. */
  levels() {
    for (let i = 0; i < SIZE / 2; i += 1) this.push(0); // Flush the last half window.
    const reference = (SIZE / 4) ** 2;
    return Buffer.from(Uint8Array.from(this.sums, (sum, i) => {
      const db = 10 * Math.log10(sum / Math.max(1, this.hits[i % this.columns]) / reference + 1e-12);
      return 255 * Math.min(1, Math.max(0, (db - FLOOR_DB) / (CEIL_DB - FLOOR_DB)));
    }));
  }
}

module.exports = { Spectrogram, BANDS };
