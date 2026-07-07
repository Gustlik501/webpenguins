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

function buildMask(
  source: HTMLImageElement | HTMLCanvasElement,
  w: number,
  h: number
): MaskResult {
  w = Math.max(1, Math.round(w));
  h = Math.max(1, Math.round(h));
  if (w > MAX_MASK_DIM || h > MAX_MASK_DIM) return { status: "opaque" };
  if (!scratch) {
    scratch = document.createElement("canvas");
    scratchCtx = scratch.getContext("2d", { willReadFrequently: true });
  }
  if (!scratchCtx) return { status: "opaque" };
  if (scratch.width < w) scratch.width = w;
  if (scratch.height < h) scratch.height = h;
  scratchCtx.clearRect(0, 0, w, h);
  let data: Uint8ClampedArray;
  try {
    scratchCtx.drawImage(source, 0, 0, w, h);
    data = scratchCtx.getImageData(0, 0, w, h).data;
  } catch {
    // Cross-origin image tainted the canvas (or the draw failed).
    scratch = undefined; // the canvas is tainted for good — replace it
    scratchCtx = null;
    return { status: "failed" };
  }

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

/**
 * Caches masks per element and drawn size; retries tainted cross-origin
 * images via a crossOrigin="anonymous" reload (works when the server sends
 * CORS headers, e.g. most CDNs), else falls back to the plain rect.
 */
export class MaskRegistry {
  private cache = new WeakMap<Element, { w: number; h: number; result: MaskResult }>();
  private corsImages = new Map<string, HTMLImageElement | "pending" | "failed">();

  constructor(private onUpdate: () => void) {}

  lookup(el: Element, w: number, h: number): MaskResult {
    w = Math.round(w);
    h = Math.round(h);
    const cached = this.cache.get(el);
    if (cached && cached.w === w && cached.h === h) return cached.result;

    let result: MaskResult;
    if (el.tagName.toUpperCase() === "CANVAS") {
      result = buildMask(el as HTMLCanvasElement, w, h);
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
