// Converts the original xpenguins/xsnow XPM assets into PNGs + a manifest.
// Outputs:
//   assets/penguins/*.png, assets/snow/*.png  — sprite sheets, pixel-identical to the originals
//   assets/manifest.json                      — animation/physics metadata
//   src/generated/assets.ts                   — same data inlined (data URIs) for single-file bundles
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseXpm } from "./xpm.mjs";
import { encodePng } from "./png.mjs";
import { parseThemeConfig } from "./theme.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const XPENGUINS = path.join(root, "vendor", "xpenguins-2.2.orig");
const XSNOW_PIX = path.join(root, "vendor", "xsnow-3.9.3", "src", "Pixmaps");
const OUT_PENGUINS = path.join(root, "assets", "penguins");
const OUT_SNOW = path.join(root, "assets", "snow");

fs.rmSync(OUT_PENGUINS, { recursive: true, force: true }); // drop stale layouts
fs.mkdirSync(OUT_PENGUINS, { recursive: true });
fs.mkdirSync(OUT_SNOW, { recursive: true });
fs.mkdirSync(path.join(root, "src", "generated"), { recursive: true });

const images = {}; // key relative to assets/ -> { png: Buffer, width, height }

/**
 * Union content bounds across every frame cell of a sheet, as [top, right,
 * bottom, left] transparent padding — or null when the art fills the cell.
 * Many sheets centre the art in its cell (the Turtles walker leaves 6 empty
 * rows at the bottom); collision must follow the pixels, not the cell.
 */
function contentPad(img, cw, ch, frames, dirs) {
  let top = ch;
  let bottom = -1;
  let left = cw;
  let right = -1;
  for (let d = 0; d < dirs; d++) {
    for (let f = 0; f < frames; f++) {
      for (let y = 0; y < ch; y++) {
        const gy = d * ch + y;
        if (gy >= img.height) continue;
        for (let x = 0; x < cw; x++) {
          const gx = f * cw + x;
          if (gx >= img.width) continue;
          if (img.rgba[(gy * img.width + gx) * 4 + 3] > 0) {
            if (y < top) top = y;
            if (y > bottom) bottom = y;
            if (x < left) left = x;
            if (x > right) right = x;
          }
        }
      }
    }
  }
  if (bottom < 0) return null; // blank sheet?! leave the cell as-is
  const pad = [top, cw - 1 - right, ch - 1 - bottom, left];
  return pad.some((p) => p > 0) ? pad : null;
}

function convert(xpmPath, outDir, outName) {
  const img = parseXpm(fs.readFileSync(xpmPath, "latin1"), path.basename(xpmPath));
  const png = encodePng(img.width, img.height, img.rgba);
  const outPath = path.join(outDir, outName);
  fs.writeFileSync(outPath, png);
  const key = path.relative(path.join(root, "assets"), outPath).split(path.sep).join("/");
  images[key] = { png, width: img.width, height: img.height };
  return img;
}

// ---------------------------------------------------------------- penguins
// Themes from the original tarball (Penguins, Big Penguins, Classic
// Penguins, Turtles, Bill) plus — when present — the contributed pack from
// xpenguins.seul.org (Sonic the Hedgehog, The Simpsons, Lemmings, Winnie
// the Pooh, Worms; see README for the fetch command and the licensing
// caveat). Directory underscores become spaces in the user-facing names,
// as in the original `xpenguins -t "Big Penguins"`.
const THEME_ROOTS = [
  path.join(XPENGUINS, "themes"),
  path.join(root, "vendor", "xpenguins_themes-1.0", "themes"), // optional
];
const themes = {};
const themeDirs = THEME_ROOTS.filter((r) => fs.existsSync(r)).flatMap((themesRoot) =>
  fs
    .readdirSync(themesRoot)
    .filter((d) => fs.existsSync(path.join(themesRoot, d, "config")))
    .map((d) => ({ themesRoot, dirName: d }))
);

for (const { themesRoot, dirName } of themeDirs) {
  const displayName = dirName.replace(/_/g, " ");
  const themeDir = path.join(themesRoot, dirName);
  const theme = parseThemeConfig(fs.readFileSync(path.join(themeDir, "config"), "utf8"));
  const outDir = path.join(OUT_PENGUINS, dirName);
  fs.mkdirSync(outDir, { recursive: true });

  const converted = new Map(); // pngName -> parsed image
  for (const genus of theme.genera) {
    if (genus.name === "toon") genus.name = displayName; // anonymous genus
    for (const [animName, anim] of Object.entries(genus.anims)) {
      const pngName = anim.pixmap.replace(/\.xpm$/, ".png");
      let img = converted.get(pngName);
      if (!img) {
        img = convert(path.join(themeDir, anim.pixmap), outDir, pngName);
        converted.set(pngName, img);
        // Sanity check: sheet must be frames wide x directions tall.
        const expectW = (anim.frames ?? 8) * (anim.width ?? 30);
        const expectH = (anim.directions ?? 1) * (anim.height ?? 30);
        if (img.width !== expectW || img.height !== expectH) {
          console.warn(
            `note: ${dirName}/${anim.pixmap} is ${img.width}x${img.height}, config implies ${expectW}x${expectH} (${genus.name}/${animName})`
          );
        }
      }
      const pad = contentPad(
        img,
        anim.width ?? 30,
        anim.height ?? 30,
        anim.frames ?? 8,
        anim.directions ?? 1
      );
      if (pad) anim.pad = pad;
      anim.image = `penguins/${dirName}/${pngName}`;
      delete anim.pixmap;
    }
  }
  themes[displayName] = { delay: theme.delay, genera: theme.genera };
}

// ---------------------------------------------------------------- xsnow
// The flake XPMs are shape masks; xsnow paints them in SnowColor ("snow",
// #FFFAFA) at runtime. Do the same here.
function snowify(img) {
  for (let i = 0; i < img.rgba.length; i += 4) {
    if (img.rgba[i + 3] > 0) {
      img.rgba[i] = 255;
      img.rgba[i + 1] = 250;
      img.rgba[i + 2] = 250;
    }
  }
  return img;
}

const flakes = [];
for (let i = 0; i <= 6; i++) {
  const xpmPath = path.join(XSNOW_PIX, `flake${i}.xpm`);
  const img = snowify(parseXpm(fs.readFileSync(xpmPath, "latin1"), `flake${i}.xpm`));
  const png = encodePng(img.width, img.height, img.rgba);
  fs.writeFileSync(path.join(OUT_SNOW, `flake${i}.png`), png);
  images[`snow/flake${i}.png`] = { png, width: img.width, height: img.height };
  flakes.push({ image: `snow/flake${i}.png`, width: img.width, height: img.height });
}

const tree = convert(path.join(XSNOW_PIX, "tannenbaum.xpm"), OUT_SNOW, "tannenbaum.png");
const moon = convert(path.join(XSNOW_PIX, "moon1.xpm"), OUT_SNOW, "moon1.png");

// Original xsnow Santa sizes 0..2 = Regular/Medium/Big, speeds from xsnow-constants.h
const santaSizes = [
  { name: "regular", prefix: "RegularSanta", speed: 12 },
  { name: "medium", prefix: "MediumSanta", speed: 25 },
  { name: "big", prefix: "BigSanta", speed: 50 },
];
const santas = [];
for (const size of santaSizes) {
  const entry = { name: size.name, speed: size.speed, frames: [], rudolf: [] };
  for (let f = 1; f <= 4; f++) {
    let img = convert(path.join(XSNOW_PIX, `${size.prefix}${f}.xpm`), OUT_SNOW, `${size.prefix}${f}.png`);
    entry.frames.push({ image: `snow/${size.prefix}${f}.png`, width: img.width, height: img.height });
    img = convert(
      path.join(XSNOW_PIX, `${size.prefix}Rudolf${f}.xpm`),
      OUT_SNOW,
      `${size.prefix}Rudolf${f}.png`
    );
    entry.rudolf.push({ image: `snow/${size.prefix}Rudolf${f}.png`, width: img.width, height: img.height });
  }
  santas.push(entry);
}

// ---------------------------------------------------------------- outputs
const manifest = {
  themes,
  snow: {
    flakes,
    santas,
    tree: { image: "snow/tannenbaum.png", width: tree.width, height: tree.height },
    moon: { image: "snow/moon1.png", width: moon.width, height: moon.height },
  },
};

fs.writeFileSync(path.join(root, "assets", "manifest.json"), JSON.stringify(manifest, null, 2));

const dataUris = Object.fromEntries(
  Object.entries(images).map(([name, { png }]) => [name, `data:image/png;base64,${png.toString("base64")}`])
);
const ts = `// GENERATED by tools/build-assets.mjs — do not edit.
// Pixel art from xpenguins 2.2 (© 1999-2001 Robin Hogan, GPL-2+) and
// xsnow (© Rick Jansen / Willem Vermin, GPL-3). See README for provenance.
export const IMAGES: Record<string, string> = ${JSON.stringify(dataUris, null, 1)};
export const MANIFEST = ${JSON.stringify(manifest, null, 1)} as const;
`;
fs.writeFileSync(path.join(root, "src", "generated", "assets.ts"), ts);

const total = Object.values(images).reduce((s, i) => s + i.png.length, 0);
console.log(
  `converted ${Object.keys(images).length} sprite sheets, ${(total / 1024).toFixed(1)} KiB PNG total`
);
