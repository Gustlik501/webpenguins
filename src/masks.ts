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

/**
 * Caches masks per element and drawn size; retries tainted cross-origin
 * images via a crossOrigin="anonymous" reload (works when the server sends
 * CORS headers, e.g. most CDNs), else falls back to the plain rect.
 */
export class MaskRegistry {
  private cache = new WeakMap<Element, { w: number; h: number; result: MaskResult }>();
  private corsImages = new Map<string, HTMLImageElement | "pending" | "failed">();
  private svgRasters = new WeakMap<Element, HTMLImageElement | "pending" | "failed">();

  constructor(private onUpdate: () => void) {}

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
