// Minimal XPM3 parser — enough for the xpenguins/xsnow pixmaps.
// Returns { width, height, rgba: Uint8Array } (RGBA8888, straight alpha).

const NAMED_COLORS = {
  black: [0, 0, 0],
  white: [255, 255, 255],
  red: [255, 0, 0],
  green: [0, 255, 0],
  blue: [0, 0, 255],
  yellow: [255, 255, 0],
  cyan: [0, 255, 255],
  magenta: [255, 0, 255],
  brown: [165, 42, 42],
  orange: [255, 165, 0],
  pink: [255, 192, 203],
  gold: [255, 215, 0],
};

function resolveColor(value, file) {
  const v = value.trim();
  if (/^none$/i.test(v) || /^transparent$/i.test(v)) return [0, 0, 0, 0];
  if (v.startsWith("#")) {
    const hex = v.slice(1);
    const per = hex.length / 3;
    if (![1, 2, 3, 4].includes(per) || hex.length % 3 !== 0) {
      throw new Error(`${file}: bad hex color "${v}"`);
    }
    const chan = (i) => {
      // Take the top 8 bits of each channel group.
      const group = hex.slice(i * per, (i + 1) * per);
      const top2 = per === 1 ? group + group : group.slice(0, 2);
      return parseInt(top2, 16);
    };
    return [chan(0), chan(1), chan(2), 255];
  }
  const gray = /^gr[ae]y(\d+)$/i.exec(v);
  if (gray) {
    const n = Math.round((Number(gray[1]) * 255) / 100);
    return [n, n, n, 255];
  }
  const named = NAMED_COLORS[v.toLowerCase().replace(/\s+/g, "")];
  if (named) return [...named, 255];
  throw new Error(`${file}: unknown color name "${v}"`);
}

// Pull the C string literals out of the file, skipping /* comments */.
function extractStrings(text) {
  const strings = [];
  let i = 0;
  let cur = null;
  while (i < text.length) {
    const ch = text[i];
    if (cur !== null) {
      if (ch === "\\") {
        cur += text[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') {
        strings.push(cur);
        cur = null;
        i++;
        continue;
      }
      cur += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      cur = "";
      i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    i++;
  }
  return strings;
}

export function parseXpm(text, file = "<xpm>") {
  const strings = extractStrings(text);
  const header = strings[0].trim().split(/\s+/).map(Number);
  const [width, height, ncolors, cpp] = header;
  if (!width || !height || !ncolors || !cpp) {
    throw new Error(`${file}: bad XPM header "${strings[0]}"`);
  }

  const colors = new Map();
  for (let c = 0; c < ncolors; c++) {
    const line = strings[1 + c];
    const key = line.slice(0, cpp);
    const tokens = line.slice(cpp).trim().split(/\s+/);
    // Entries look like: c #ABCDEF  |  c None  |  s mask c black  |  g Gray50
    const entries = {};
    let entryKey = null;
    let val = [];
    for (const t of tokens) {
      if (["c", "m", "g", "g4", "s"].includes(t)) {
        if (entryKey) entries[entryKey] = val.join(" ");
        entryKey = t;
        val = [];
      } else {
        val.push(t);
      }
    }
    if (entryKey) entries[entryKey] = val.join(" ");
    const colorVal = entries.c ?? entries.g ?? entries.g4 ?? entries.m;
    if (colorVal === undefined) {
      throw new Error(`${file}: color line without value: "${line}"`);
    }
    colors.set(key, resolveColor(colorVal, file));
  }

  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const row = strings[1 + ncolors + y];
    if (row === undefined || row.length < width * cpp) {
      throw new Error(`${file}: pixel row ${y} missing or too short`);
    }
    for (let x = 0; x < width; x++) {
      const key = row.slice(x * cpp, x * cpp + cpp);
      const col = colors.get(key);
      if (!col) throw new Error(`${file}: unknown pixel key "${key}" at ${x},${y}`);
      const o = (y * width + x) * 4;
      rgba[o] = col[0];
      rgba[o + 1] = col[1];
      rgba[o + 2] = col[2];
      rgba[o + 3] = col[3];
    }
  }
  return { width, height, rgba };
}
