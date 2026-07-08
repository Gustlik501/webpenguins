// Bundles the engine:
//   dist/webpenguins.js      — IIFE, global `WebPenguins`, assets inlined
//   dist/webpenguins.esm.js  — ES module
// and refreshes the extension's copy + generated icons.
import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { encodePng } from "./png.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const common = {
  entryPoints: [path.join(root, "src", "index.ts")],
  bundle: true,
  minify: true,
  sourcemap: false,
  target: ["es2020"],
  logLevel: "info",
};

await esbuild.build({
  ...common,
  format: "iife",
  globalName: "WebPenguins",
  outfile: path.join(root, "dist", "webpenguins.js"),
  banner: {
    js: "/*! web-penguins — xpenguins+xsnow for the web. GPL-3.0-or-later. Art: Robin Hogan (xpenguins 2.2), Rick Jansen/Willem Vermin (xsnow). */",
  },
});

await esbuild.build({
  ...common,
  format: "esm",
  outfile: path.join(root, "dist", "webpenguins.esm.js"),
});

// ---- extension: copy bundle + generate icons from the walker sprite ----
const extDir = path.join(root, "extension");
if (fs.existsSync(extDir)) {
  fs.copyFileSync(path.join(root, "dist", "webpenguins.js"), path.join(extDir, "webpenguins.js"));

  // Decode the walker PNG (our own encoder output: single IDAT, filter 0)
  // and cut out one frame to scale into extension icons.
  const png = fs.readFileSync(path.join(root, "assets", "penguins", "Penguins", "walker.png"));
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  let off = 8;
  const idats = [];
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString("ascii", off + 4, off + 8);
    if (type === "IDAT") idats.push(png.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idats));
  const stride = width * 4;
  const getPx = (x, y) => {
    const o = y * (stride + 1) + 1 + x * 4;
    return [raw[o], raw[o + 1], raw[o + 2], raw[o + 3]];
  };

  // Frame 0 of direction "right" (row 1), 30x30.
  const FRAME = 30;
  const iconsDir = path.join(extDir, "icons");
  fs.mkdirSync(iconsDir, { recursive: true });
  for (const size of [16, 32, 48, 128]) {
    const rgba = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        // nearest-neighbour scale of the 30x30 frame
        const sx = Math.min(FRAME - 1, Math.floor((x * FRAME) / size));
        const sy = Math.min(FRAME - 1, Math.floor((y * FRAME) / size)) + FRAME; // row 1 = facing right
        const [r, g, b, a] = getPx(sx, sy);
        const o = (y * size + x) * 4;
        rgba[o] = r;
        rgba[o + 1] = g;
        rgba[o + 2] = b;
        rgba[o + 3] = a;
      }
    }
    fs.writeFileSync(path.join(iconsDir, `icon${size}.png`), encodePng(size, size, rgba));
  }
  console.log("extension bundle + icons refreshed");
}
