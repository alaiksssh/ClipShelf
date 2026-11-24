export const RATIOS = { original: null, '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1 };

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function cropRect(width, height, ratio, position = 0.5) {
  const target = RATIOS[ratio];
  if (!target) return null;
  const even = (value) => Math.floor(value / 2) * 2;
  let w = width;
  let h = height;
  if (width / height > target) w = height * target;
  else h = width / target;
  w = even(w);
  h = even(h);
  const at = clamp(position, 0, 1);
  return { w, h, x: even((width - w) * at), y: even((height - h) * at) };
}
