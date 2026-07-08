// Pixel collision masks from image alpha channels. The original xpenguins
// walked on *shaped* X11 windows (XShapeGetRectangles); on the web, the
// shape of an <img> is its alpha channel. Penguins standing on the letters
// of a logo — not its bounding box — happens here.
import { PixelMask } from "./types";

const MAX_MASK_DIM = 1200; // bigger images are almost certainly photos
const ALPHA_SOLID = 64; // out of 255
const OPAQUE_RATIO = 0.97; // ≥ this: plain rect is cheaper and identical
const EMPTY_RATIO = 0.02; // ≤ this: nothing visible — not solid at all

export interface MaskResult {
  status: "opaque" | "masked" | "empty" | "pending" | "failed";
  mask?: PixelMask;
}

export function maskRectHit(
  mask: PixelMask,
  mx0: number,
  my0: number,
  mw: number,
  mh: number
): boolean {
  const x0 = Math.max(0, mx0);
  const y0 = Math.max(0, my0);
  const x1 = Math.min(mask.w, mx0 + mw);
  const y1 = Math.min(mask.h, my0 + mh);
  for (let y = y0; y < y1; y++) {
    const row = y * mask.rowWords;
    for (let x = x0; x < x1; x++) {
      if (mask.bits[row + (x >> 5)] & (1 << (x & 31))) return true;
    }
  }
  return false;
}

let scratch: HTMLCanvasElement | undefined;
let scratchCtx: CanvasRenderingContext2D | null = null;

function getScratch(w: number, h: number): CanvasRenderingContext2D | null {
  if (!scratch) {
    scratch = document.createElement("canvas");
    scratchCtx = scratch.getContext("2d", { willReadFrequently: true });
  }
  if (!scratchCtx) return null;
  if (scratch.width < w) scratch.width = w;
  if (scratch.height < h) scratch.height = h;
  scratchCtx.setTransform(1, 0, 0, 1, 0, 0);
  scratchCtx.clearRect(0, 0, w, h);
  return scratchCtx;
}

function bitsFromData(data: Uint8ClampedArray, w: number, h: number): MaskResult {
  const rowWords = Math.ceil(w / 32);
  const bits = new Uint32Array(rowWords * h);
  const topProfile = new Int16Array(w).fill(-1);
  let solidCount = 0;
  for (let y = 0; y < h; y++) {
    const row = y * rowWords;
    const line = y * w * 4;
    for (let x = 0; x < w; x++) {
      if (data[line + x * 4 + 3] > ALPHA_SOLID) {
        bits[row + (x >> 5)] |= 1 << (x & 31);
        solidCount++;
        if (topProfile[x] < 0) topProfile[x] = y;
      }
    }
  }
  const solidity = solidCount / (w * h);
  if (solidity >= OPAQUE_RATIO) return { status: "opaque" };
  if (solidity <= EMPTY_RATIO) return { status: "empty" };
  return { status: "masked", mask: { w, h, rowWords, bits, topProfile } };
}

function buildMask(
  source: HTMLImageElement | HTMLCanvasElement,
  w: number,
  h: number
): MaskResult {
  w = Math.max(1, Math.round(w));
  h = Math.max(1, Math.round(h));
  if (w > MAX_MASK_DIM || h > MAX_MASK_DIM) return { status: "opaque" };
  const ctx = getScratch(w, h);
  if (!ctx) return { status: "opaque" };
  let data: Uint8ClampedArray;
  try {
    ctx.drawImage(source, 0, 0, w, h);
    data = ctx.getImageData(0, 0, w, h).data;
  } catch {
    // Cross-origin image tainted the canvas (or the draw failed).
    scratch = undefined; // the canvas is tainted for good — replace it
    scratchCtx = null;
    return { status: "failed" };
  }
  return bitsFromData(data, w, h);
}

// -------------------------------------------------------- rounded corners
// CSS border-radius as a collision shape. Insetting the box by the radius
// (the v2 approach) ended the platform where the rounding merely *begins*,
// so toons fell off while standing over visibly solid surface. A procedural
// rounded-rect mask lets them walk down the shoulder of the curve — the
// walker's 8px step-down handles the descent, exactly like on the curved
// letterforms of a logo — and tumble off at the visual edge.

export interface RadiusPair {
  x: number;
  y: number;
}

export interface CornerRadii {
  tl: RadiusPair;
  tr: RadiusPair;
  br: RadiusPair;
  bl: RadiusPair;
}

/** The CSS overlap rule: scale all radii down so adjacent corners fit. */
export function normalizeRadii(w: number, h: number, r: CornerRadii): CornerRadii {
  const f = Math.min(
    1,
    w / Math.max(1e-6, r.tl.x + r.tr.x),
    w / Math.max(1e-6, r.bl.x + r.br.x),
    h / Math.max(1e-6, r.tl.y + r.bl.y),
    h / Math.max(1e-6, r.tr.y + r.br.y)
  );
  const s = (p: RadiusPair): RadiusPair => ({
    x: Math.max(0, p.x * f),
    y: Math.max(0, p.y * f),
  });
  return { tl: s(r.tl), tr: s(r.tr), br: s(r.br), bl: s(r.bl) };
}

// Same-sized cards share one mask; the cache is keyed by dims + radii.
const ROUNDED_CACHE_MAX = 48;
const roundedCache = new Map<string, PixelMask>();

/**
 * Procedural mask for a border-radius box (radii pre-normalized). Pure
 * math — no canvas, no styles. Returns null for boxes too big to mask;
 * the caller falls back to insetting.
 */
export function buildRoundedRectMask(w: number, h: number, r: CornerRadii): PixelMask | null {
  w = Math.max(1, Math.round(w));
  h = Math.max(1, Math.round(h));
  if (w > 2600 || h > 1600) return null;
  const key =
    w + "x" + h + ":" + [r.tl, r.tr, r.br, r.bl].map((p) => (p.x | 0) + "," + (p.y | 0)).join(";");
  const hit = roundedCache.get(key);
  if (hit) return hit;

  const rowWords = Math.ceil(w / 32);
  // Solid everywhere except the four quarter-ellipse cutouts.
  const bits = new Uint32Array(rowWords * h).fill(0xffffffff);
  const topProfile = new Int16Array(w); // 0 = the flat top

  const carve = (
    x0: number,
    x1: number,
    y0: number,
    y1: number,
    cx: number,
    cy: number,
    rx: number,
    ry: number
  ) => {
    if (rx < 0.5 || ry < 0.5) return;
    x0 = Math.max(0, Math.floor(x0));
    x1 = Math.min(w, Math.ceil(x1));
    y0 = Math.max(0, Math.floor(y0));
    y1 = Math.min(h, Math.ceil(y1));
    for (let y = y0; y < y1; y++) {
      const row = y * rowWords;
      const dy = (y + 0.5 - cy) / ry;
      for (let x = x0; x < x1; x++) {
        const dx = (x + 0.5 - cx) / rx;
        if (dx * dx + dy * dy > 1) bits[row + (x >> 5)] &= ~(1 << (x & 31));
      }
    }
  };
  carve(0, r.tl.x, 0, r.tl.y, r.tl.x, r.tl.y, r.tl.x, r.tl.y);
  carve(w - r.tr.x, w, 0, r.tr.y, w - r.tr.x, r.tr.y, r.tr.x, r.tr.y);
  carve(w - r.br.x, w, h - r.br.y, h, w - r.br.x, h - r.br.y, r.br.x, r.br.y);
  carve(0, r.bl.x, h - r.bl.y, h, r.bl.x, h - r.bl.y, r.bl.x, r.bl.y);

  // Snow (and landing) follows the curve under the top corners.
  const profile = (x0: number, x1: number) => {
    x0 = Math.max(0, Math.floor(x0));
    x1 = Math.min(w, Math.ceil(x1));
    for (let x = x0; x < x1; x++) {
      let top = -1;
      for (let y = 0; y < h; y++) {
        if (bits[y * rowWords + (x >> 5)] & (1 << (x & 31))) {
          top = y;
          break;
        }
      }
      topProfile[x] = top;
    }
  };
  profile(0, r.tl.x);
  profile(w - r.tr.x, w);

  const mask: PixelMask = { w, h, rowWords, bits, topProfile };
  if (roundedCache.size >= ROUNDED_CACHE_MAX) {
    const oldest = roundedCache.keys().next().value;
    if (oldest !== undefined) roundedCache.delete(oldest);
  }
  roundedCache.set(key, mask);
  return mask;
}

// ------------------------------------------------------------ inline <svg>
// Vector rasterization: convert the SVG's shapes to Path2D and fill them
// with their *computed* styles (so CSS-driven fills, like Google's white
// dark-mode logo, resolve correctly). No image loading → CSP can't object.

function shapeToPath(shape: SVGGraphicsElement): Path2D | null {
  const attr = (n: string) => parseFloat(shape.getAttribute(n) || "0");
  const p = new Path2D();
  switch (shape.tagName.toLowerCase()) {
    case "path": {
      const d = shape.getAttribute("d");
      return d ? new Path2D(d) : null;
    }
    case "rect":
      p.rect(attr("x"), attr("y"), attr("width"), attr("height"));
      return p;
    case "circle":
      p.arc(attr("cx"), attr("cy"), attr("r"), 0, Math.PI * 2);
      return p;
    case "ellipse":
      p.ellipse(attr("cx"), attr("cy"), attr("rx"), attr("ry"), 0, 0, Math.PI * 2);
      return p;
    case "polygon":
    case "polyline": {
      const pts = (shape.getAttribute("points") || "")
        .trim()
        .split(/[\s,]+/)
        .map(parseFloat);
      if (pts.length < 4 || pts.some((n) => Number.isNaN(n))) return null;
      p.moveTo(pts[0], pts[1]);
      for (let i = 2; i + 1 < pts.length; i += 2) p.lineTo(pts[i], pts[i + 1]);
      if (shape.tagName.toLowerCase() === "polygon") p.closePath();
      return p;
    }
    case "line":
      p.moveTo(attr("x1"), attr("y1"));
      p.lineTo(attr("x2"), attr("y2"));
      return p;
  }
  return null;
}

function buildFromSvgVector(svg: SVGSVGElement, w: number, h: number): MaskResult | null {
  // Content we can't draw vectorially → let the caller try rasterizing.
  if (svg.querySelector("use,image,text,foreignObject")) return null;
  const box = svg.getBoundingClientRect();
  if (box.width < 1 || box.height < 1) return null;
  w = Math.max(1, Math.round(w));
  h = Math.max(1, Math.round(h));
  if (w > MAX_MASK_DIM || h > MAX_MASK_DIM) return { status: "opaque" };
  const rootM = svg.getScreenCTM();
  if (!rootM) return null;
  const shapes = svg.querySelectorAll<SVGGraphicsElement>(
    "path,rect,circle,ellipse,polygon,polyline,line"
  );
  if (!shapes.length) return null;
  const ctx = getScratch(w, h);
  if (!ctx) return null;
  const kx = w / box.width;
  const ky = h / box.height;
  const rootInv = rootM.inverse();
  let drew = false;
  for (const shape of shapes) {
    const st = getComputedStyle(shape);
    if (st.display === "none" || st.visibility === "hidden") continue;
    if ((parseFloat(st.opacity) || 1) < 0.2) continue;
    const doFill = st.fill !== "none";
    const doStroke = st.stroke !== "none" && parseFloat(st.strokeWidth) > 0;
    if (!doFill && !doStroke) continue;
    const path = shapeToPath(shape);
    if (!path) continue;
    const screenM = shape.getScreenCTM();
    if (!screenM) continue;
    // shape user units -> svg-local CSS px -> mask px
    const m = rootInv.multiply(screenM);
    ctx.setTransform(m.a * kx, m.b * ky, m.c * kx, m.d * ky, m.e * kx, m.f * ky);
    ctx.fillStyle = "#000";
    ctx.strokeStyle = "#000";
    if (doFill) path && ctx.fill(path, st.fillRule === "evenodd" ? "evenodd" : "nonzero");
    if (doStroke) {
      ctx.lineWidth = parseFloat(st.strokeWidth) || 1;
      ctx.stroke(path);
    }
    drew = true;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (!drew) return null;
  try {
    return bitsFromData(ctx.getImageData(0, 0, w, h).data, w, h);
  } catch {
    return null;
  }
}

// ------------------------------------------------- arbitrary elements
// Forced pixel-perfect collision for ANY element (dev mode's shift-click):
// the element is rasterized via SVG <foreignObject> with its computed
// styles inlined — text glyphs, gradients and (CORS-permitting) background
// images all become collision shape. The html2canvas trick, minus the kilo
// of dependencies.

const URL_RE = /url\((['"]?)([^)'"]+)\1\)/g;

function styleText(cs: CSSStyleDeclaration, inline: (u: string) => string): string {
  let out = "";
  for (let i = 0; i < cs.length; i++) {
    const prop = cs[i];
    let v = cs.getPropertyValue(prop);
    if (v.includes("url(")) {
      v = v.replace(URL_RE, (_m, _q, u: string) => `url("${inline(u)}")`);
    }
    out += `${prop}:${v};`;
  }
  return out;
}

/**
 * Caches masks per element and drawn size; retries tainted cross-origin
 * images via a crossOrigin="anonymous" reload (works when the server sends
 * CORS headers, e.g. most CDNs), else falls back to the plain rect.
 */
export class MaskRegistry {
  private cache = new WeakMap<Element, { w: number; h: number; result: MaskResult }>();
  private corsImages = new Map<string, HTMLImageElement | "pending" | "failed">();
  private svgRasters = new WeakMap<Element, HTMLImageElement | "pending" | "failed">();
  // forced pixel-perfect rasterization
  private rasters = new WeakMap<
    Element,
    { img: HTMLImageElement; w: number; h: number } | "pending" | "failed"
  >();
  private inlined = new Map<string, string | "pending" | "failed">();

  constructor(private onUpdate: () => void) {}

  /**
   * Pixel-perfect collision for an arbitrary element. Replaced content uses
   * its native alpha path; everything else is rasterized (foreignObject).
   */
  lookupForced(el: Element, w: number, h: number): MaskResult {
    const tag = el.tagName.toUpperCase();
    if (tag === "IMG" || tag === "CANVAS" || tag === "SVG") return this.lookup(el, w, h);
    w = Math.round(w);
    h = Math.round(h);
    const cached = this.cache.get(el);
    if (cached && cached.w === w && cached.h === h) return cached.result;
    const raster = this.elementRaster(el, w, h);
    if (raster === "pending") return { status: "pending" }; // uncached: retry next scan
    let result: MaskResult = raster === "failed" ? { status: "opaque" } : buildMask(raster, w, h);
    if (result.status === "failed") result = { status: "opaque" };
    this.cache.set(el, { w, h, result });
    return result;
  }

  private elementRaster(el: Element, w: number, h: number): HTMLImageElement | "pending" | "failed" {
    const got = this.rasters.get(el);
    if (got === "pending" || got === "failed") return got;
    if (got && Math.abs(got.w - w) <= 2 && Math.abs(got.h - h) <= 2) return got.img;
    if (w > 1600 || h > 1600) return "failed";

    const origs: Element[] = [el, ...Array.from(el.querySelectorAll("*"))];
    if (origs.length > 300) {
      this.rasters.set(el, "failed");
      return "failed";
    }
    // Inline every referenced image first (they can't load inside a data:
    // SVG); wait for the fetches before rasterizing.
    const urls = new Set<string>();
    for (const node of origs) {
      if (node.tagName === "IMG") {
        const src = (node as HTMLImageElement).currentSrc || (node as HTMLImageElement).src;
        if (src && !src.startsWith("data:")) urls.add(src);
      }
      const bg = getComputedStyle(node).backgroundImage;
      if (bg && bg !== "none") {
        for (const m of bg.matchAll(URL_RE)) {
          if (!m[2].startsWith("data:")) urls.add(m[2]);
        }
      }
    }
    let pending = false;
    const resolved = new Map<string, string>();
    for (const u of urls) {
      const r = this.inlineFetch(u);
      if (r === "pending") pending = true;
      else if (r !== "failed") resolved.set(u, r);
    }
    if (pending) return "pending"; // not cached — retried when fetches land

    let markup: string;
    try {
      const clone = el.cloneNode(true) as Element;
      const copies: Element[] = [clone, ...Array.from(clone.querySelectorAll("*"))];
      const inline = (u: string) => resolved.get(u) ?? u;
      for (let i = 0; i < origs.length && i < copies.length; i++) {
        let css = styleText(getComputedStyle(origs[i]), inline);
        // The root renders at the foreignObject origin, not where the
        // page put it.
        if (i === 0) css += "margin:0;position:static;inset:auto;transform:none;";
        copies[i].setAttribute("style", css);
        if (copies[i].tagName === "IMG") {
          const src = (origs[i] as HTMLImageElement).currentSrc || (origs[i] as HTMLImageElement).src;
          const data = src.startsWith("data:") ? src : resolved.get(src);
          if (data) copies[i].setAttribute("src", data);
          else copies[i].removeAttribute("src");
          copies[i].removeAttribute("srcset");
        }
      }
      markup =
        `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(w)}" height="${Math.round(h)}">` +
        `<foreignObject width="100%" height="100%">` +
        new XMLSerializer().serializeToString(clone) +
        `</foreignObject></svg>`;
    } catch {
      this.rasters.set(el, "failed");
      return "failed";
    }

    const img = new Image();
    img.onload = () => {
      this.rasters.set(el, { img, w, h });
      this.onUpdate();
    };
    img.onerror = () => {
      this.rasters.set(el, "failed");
      this.onUpdate();
    };
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(markup);
    this.rasters.set(el, "pending");
    return "pending";
  }

  /** Fetch an image and re-encode it as a data URI (CORS permitting). */
  private inlineFetch(url: string): string | "pending" | "failed" {
    const got = this.inlined.get(url);
    if (got) return got;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const c = document.createElement("canvas");
        c.width = Math.min(img.naturalWidth, 2000);
        c.height = Math.min(img.naturalHeight, 2000);
        c.getContext("2d")!.drawImage(img, 0, 0);
        this.inlined.set(url, c.toDataURL());
      } catch {
        this.inlined.set(url, "failed");
      }
      this.onUpdate();
    };
    img.onerror = () => {
      this.inlined.set(url, "failed");
      this.onUpdate();
    };
    img.src = url;
    this.inlined.set(url, "pending");
    return "pending";
  }

  lookup(el: Element, w: number, h: number): MaskResult {
    w = Math.round(w);
    h = Math.round(h);
    const cached = this.cache.get(el);
    if (cached && cached.w === w && cached.h === h) return cached.result;

    let result: MaskResult;
    const tag = el.tagName.toUpperCase();
    if (tag === "CANVAS") {
      result = buildMask(el as HTMLCanvasElement, w, h);
    } else if (tag === "SVG") {
      const vector = buildFromSvgVector(el as SVGSVGElement, w, h);
      if (vector) {
        result = vector;
      } else {
        // exotic content (<use>, <text>, <image>…): rasterize via data URI
        const raster = this.svgRasterFetch(el as SVGSVGElement, w, h);
        if (raster === "pending") return { status: "pending" }; // uncached: retry
        result = raster === "failed" ? { status: "opaque" } : buildMask(raster, w, h);
        if (result.status === "failed") result = { status: "opaque" };
      }
    } else {
      const img = el as HTMLImageElement;
      result = buildMask(img, w, h);
      if (result.status === "failed") {
        const cors = this.corsFetch(img.currentSrc || img.src);
        if (cors === "pending") return { status: "pending" }; // uncached: retry next scan
        result = cors === "failed" ? { status: "opaque" } : buildMask(cors, w, h);
        if (result.status === "failed") result = { status: "opaque" };
      }
    }
    this.cache.set(el, { w, h, result });
    return result;
  }

  private svgRasterFetch(svg: SVGSVGElement, w: number, h: number): HTMLImageElement | "pending" | "failed" {
    const got = this.svgRasters.get(svg);
    if (got) return got;
    let markup: string;
    try {
      const clone = svg.cloneNode(true) as SVGSVGElement;
      clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      clone.setAttribute("width", String(w));
      clone.setAttribute("height", String(h));
      markup = new XMLSerializer().serializeToString(clone);
    } catch {
      this.svgRasters.set(svg, "failed");
      return "failed";
    }
    const img = new Image();
    img.onload = () => {
      this.svgRasters.set(svg, img);
      this.onUpdate();
    };
    img.onerror = () => this.svgRasters.set(svg, "failed");
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(markup);
    this.svgRasters.set(svg, "pending");
    return "pending";
  }

  private corsFetch(src: string): HTMLImageElement | "pending" | "failed" {
    if (!/^https?:/.test(src)) return "failed";
    const got = this.corsImages.get(src);
    if (got) return got;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      this.corsImages.set(src, img);
      this.onUpdate();
    };
    img.onerror = () => this.corsImages.set(src, "failed");
    img.src = src;
    this.corsImages.set(src, "pending");
    return "pending";
  }
}
