// The web equivalent of ToonLocateWindows(): find DOM elements that read as
// solid "windows" a toon can walk on, climb, and be squashed by.
//
// v2 is style-aware: a box is only solid if it actually *paints* something a
// person can see — a background that differs from what's behind it, a
// visible border or shadow, real replaced content (a loaded image, a video).
// Bare headings collide with their text's ink box rather than their layout
// box, rects are clipped by overflow-hidden ancestors, rounded corners get
// a rounded-rect pixel mask, and boxes hidden behind overlays are dropped.
//
// Everything lives in *document* coordinates: the page is the desktop and
// scrolling merely moves the camera. Only real layout changes (rescans that
// move a rect) count as "windows moving".
import { MaskRegistry, RadiusPair, buildRoundedRectMask, normalizeRadii } from "./masks";
import { PixelMask, SolidRect } from "./types";

const NEVER_SOLID = new Set([
  "SCRIPT",
  "STYLE",
  "TEMPLATE",
  "NOSCRIPT",
  "HEAD",
  "TITLE",
  "META",
  "LINK",
  "BASE",
  "BR",
  "WBR",
  "AREA",
  "MAP",
  "OPTION",
  "OPTGROUP",
  "DATALIST",
  "SOURCE",
  "TRACK",
  "COL",
  "COLGROUP",
]);

// Replaced/embedded content paints by nature (images must actually be loaded).
const REPLACED = new Set(["IMG", "VIDEO", "IFRAME", "OBJECT", "EMBED", "CANVAS", "SVG"]);
const HEADINGS = new Set(["H1", "H2", "H3", "H4"]);

const MAX_SURFACES = 160; // nearest to the viewport win
const MAX_PLATFORMS = 12;
const MAX_COLLECTED = 320;
const MAX_EXAMINED = 6000;
const MIN_WIDTH = 44;
const MIN_HEIGHT = 10;
const HOT_DURATION = 2000;
const MAX_HOT = 32;

interface Surface {
  id: number;
  el: Element;
  platform: boolean;
  // document coords
  x: number;
  y: number;
  w: number;
  h: number;
  mask?: PixelMask;
  maskDX?: number;
  maskDY?: number;
  // Unclipped piece geometry in element-local coords. Occlusion cuts stay
  // local too; outer ends regrow when an ancestor's clip recedes.
  relX: number;
  relY: number;
  preW: number;
  preH: number;
  rectW: number;
  rectH: number;
  // The unsplit line/box anchors step 2's rounded mask-origin calculation.
  clipRelX: number;
  clipW: number;
  insetX: number; // rounded-mask fallback's post-clip inset
}

// Shaped-collision candidates: their rendered alpha is their shape.
const MASKABLE = new Set(["IMG", "CANVAS", "SVG"]);

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

let nextId = 1;
const elementIds = new WeakMap<Element, number>();

function idFor(el: Element): number {
  let id = elementIds.get(el);
  if (!id) {
    id = nextId++;
    elementIds.set(el, id);
  }
  return id;
}

// ---------------------------------------------------------------- colors

function parseColor(c: string): [number, number, number, number] | null {
  const m = /rgba?\(([^)]+)\)/.exec(c);
  if (!m) return null;
  const p = m[1]
    .split(/[,\s/]+/)
    .filter(Boolean)
    .map(parseFloat);
  if (p.length < 3 || p.some((n) => Number.isNaN(n))) return null;
  return [p[0], p[1], p[2], p.length >= 4 ? p[3] : 1];
}

function alphaOf(c: string): number {
  if (!c || c === "transparent") return 0;
  const parsed = parseColor(c);
  return parsed ? parsed[3] : 1; // named/hex colors: assume opaque
}

/** Would a human notice the difference between these two colors? */
function colorsDiffer(a: string, b: string): boolean {
  const pa = parseColor(a);
  const pb = parseColor(b);
  if (!pa || !pb) return true; // can't tell — be permissive
  return (
    Math.max(Math.abs(pa[0] - pb[0]), Math.abs(pa[1] - pb[1]), Math.abs(pa[2] - pb[2])) > 12 ||
    Math.abs(pa[3] - pb[3]) > 0.2
  );
}

/** One computed border-*-radius value: "10px", "50%", or "10px 20px". */
function radiusPair(v: string, w: number, h: number): RadiusPair {
  // Computed circular radii are usually one token; avoid splitting and
  // parsing it twice on every ordinary card.
  if (!v.includes(" ")) {
    const radius = parseFloat(v) || 0;
    return v.endsWith("%") ? { x: radius / 100 * w, y: radius / 100 * h } : { x: radius, y: radius };
  }
  const parts = v.trim().split(/\s+/);
  const rx = parts[0] || "0";
  const ry = parts[1] || rx;
  const px = parseFloat(rx) || 0;
  const py = parseFloat(ry) || 0;
  return {
    x: rx.endsWith("%") ? (px / 100) * w : px,
    y: ry.endsWith("%") ? (py / 100) * h : py,
  };
}

function shadowVisible(boxShadow: string): boolean {
  if (!boxShadow || boxShadow === "none") return false;
  // If it only uses rgba() colors, at least one must be non-transparent.
  const rgbas = boxShadow.match(/rgba?\([^)]+\)/g);
  if (!rgbas) return true;
  return rgbas.some((c) => alphaOf(c) > 0.05);
}

function hasVisibleBorder(st: CSSStyleDeclaration): boolean {
  // The shorthand is exactly 0px only when all four sides are zero. Bare
  // text and transparent wrappers needn't read each side independently.
  if (st.borderWidth === "0px" && (st.outlineStyle === "none" || parseFloat(st.outlineWidth) === 0)) return false;
  for (const side of ["top", "right", "bottom", "left"]) {
    if (
      parseFloat(st.getPropertyValue(`border-${side}-width`)) > 0 &&
      st.getPropertyValue(`border-${side}-style`) !== "none" &&
      alphaOf(st.getPropertyValue(`border-${side}-color`)) > 0.05
    ) {
      return true;
    }
  }
  if (st.outlineStyle !== "none" && parseFloat(st.outlineWidth) > 0 && alphaOf(st.outlineColor) > 0.05) {
    return true;
  }
  return false;
}

export class Surfaces {
  private surfaces: Surface[] = [];
  private platforms: Surface[] = [];
  private generation = 0;
  private hot = new Map<Element, number>();
  // Tracking may move or remove live pieces; retain the last full-scan
  // positions separately so the next scan still detects their motion.
  private scanPositions = new Map<number, { x: number; y: number }>();
  // debug instrumentation
  scanCount = 0;
  rescheduleCount = 0;
  private lastTickGeneration = -1;
  private rescanTimer: ReturnType<typeof setTimeout> | undefined;
  private rescanDue = Infinity;
  private intervalTimer: ReturnType<typeof setInterval> | undefined;
  private observer: MutationObserver | undefined;
  private listeners: Array<() => void> = [];
  // per-scan memoization
  private backdropCache = new Map<Element, string>();
  private gluedCache = new Map<Element, boolean>();
  private clipCache = new Map<Element, Box | null>();
  private styleCache = new Map<Element, CSSStyleDeclaration>();
  private pageCanvas = "rgb(255, 255, 255)";
  // pixel masks (rescan shortly after a cross-origin retry succeeds)
  private masks = new MaskRegistry(() => this.scheduleRescan(50));
  // user overrides (dev mode / options): CSS selectors, joined for matches()
  private solidJoined = "";
  private ignoreJoined = "";
  private pixelJoined = "";
  private pinnedProvider: (() => Iterable<number>) | undefined;

  /** Supporting surfaces must survive nearest-viewport windowing. */
  setPinnedProvider(fn: () => Iterable<number>): void {
    this.pinnedProvider = fn;
  }

  /** Set the user's solid/ignore/pixel selector overrides and rescan. */
  setOverrides(solid: string[], ignore: string[], pixel: string[]): void {
    const valid = (list: string[]) =>
      list.filter((sel) => {
        try {
          document.querySelector(sel);
          return true;
        } catch {
          console.warn(`webpenguins: invalid override selector "${sel}"`);
          return false;
        }
      });
    this.solidJoined = valid(solid).join(", ");
    this.ignoreJoined = valid(ignore).join(", ");
    this.pixelJoined = valid(pixel).join(", ");
    this.scan();
  }

  /** The effective hint: user overrides beat the page's data attributes. */
  private hintFor(el: Element): string | null {
    if (this.ignoreJoined && el.matches(this.ignoreJoined)) return "ignore";
    if (this.pixelJoined && el.matches(this.pixelJoined)) return "pixel";
    if (this.solidJoined && el.matches(this.solidJoined)) return "solid";
    return el.getAttribute("data-webpenguins");
  }

  /** The accepted surface/platform element that is (or contains) `el`, if any. */
  surfaceContaining(el: Element): Element | null {
    for (const s of [...this.surfaces, ...this.platforms]) {
      if (s.el === el || s.el.contains(el)) return s.el;
    }
    return null;
  }

  /** Does this accepted surface already collide with a pixel mask? */
  surfaceMasked(el: Element): boolean {
    for (const s of this.surfaces) {
      if (s.el === el) return !!s.mask;
    }
    return false;
  }

  start(): void {
    this.scan();

    const schedule = (delay: number) => this.scheduleRescan(delay);

    const onResize = () => schedule(100);
    const onLoad = () => schedule(200);
    // Page scrolling only shifts the nearest-160 window; scrolling an
    // element moves its contents in document space and needs a faster scan.
    const onScroll = (e: Event) => {
      if ((e.target as Element).closest?.("[data-webpenguins-devpanel]")) return;
      const target = e.target;
      if (target instanceof Element) {
        const now = performance.now();
        for (const s of this.surfaces) if (target.contains(s.el)) this.markHot(s.el, now);
      }
      schedule(target === window || target === document ? 300 : 100);
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("load", onLoad, true);
    window.addEventListener("scroll", onScroll, { passive: true, capture: true });
    this.listeners.push(
      () => window.removeEventListener("resize", onResize),
      () => window.removeEventListener("load", onLoad, true),
      () => window.removeEventListener("scroll", onScroll, true)
    );

    const onMotion = (e: Event) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      const now = performance.now();
      for (const s of this.surfaces) {
        if (target === s.el || target.contains(s.el) || s.el.contains(target)) this.markHot(s.el, now);
      }
    };
    for (const event of ["transitionrun", "transitionstart", "animationstart", "animationiteration"]) {
      window.addEventListener(event, onMotion, { capture: true, passive: true });
      this.listeners.push(() => window.removeEventListener(event, onMotion, true));
    }

    this.observer = new MutationObserver(() => schedule(250));
    if (document.body) {
      this.observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["style", "class", "hidden", "open"],
      });
    }
    // Safety net for layout changes nothing else reports (fonts, animations).
    this.intervalTimer = setInterval(() => this.scan(), 4000);
  }

  stop(): void {
    for (const off of this.listeners) off();
    this.listeners = [];
    this.observer?.disconnect();
    clearTimeout(this.rescanTimer);
    clearInterval(this.intervalTimer);
    this.hot.clear();
  }

  /** Refresh recency as well as the deadline; only the newest 32 stay hot. */
  private markHot(el: Element, now = performance.now()): void {
    this.hot.delete(el);
    this.hot.set(el, now + HOT_DURATION);
    if (this.hot.size > MAX_HOT) this.hot.delete(this.hot.keys().next().value!);
  }

  private scheduleRescan(delay: number): void {
    this.rescheduleCount++;
    // Coalesce to the EARLIEST pending deadline. Resetting the timer on
    // every call starves the scan on pages that mutate the DOM every frame
    // (tickers, re-renders): the debounce never fires.
    const due = performance.now() + delay;
    if (this.rescanTimer !== undefined && this.rescanDue <= due) return;
    clearTimeout(this.rescanTimer);
    this.rescanDue = due;
    this.rescanTimer = setTimeout(() => {
      this.rescanTimer = undefined;
      this.rescanDue = Infinity;
      this.scan();
    }, delay);
  }

  /** Ancestor gates can share a style, but tiny candidates never request one. */
  private styleFor(el: Element): CSSStyleDeclaration {
    let st = this.styleCache.get(el);
    if (!st) {
      st = getComputedStyle(el);
      this.styleCache.set(el, st);
    }
    return st;
  }

  /** The effective background color behind an element (or "complex"). */
  private backdropOf(el: Element): string {
    let cur = el.parentElement;
    while (cur) {
      const cached = this.backdropCache.get(cur);
      if (cached !== undefined) return cached;
      const st = this.styleFor(cur);
      let result: string | null = null;
      if (st.backgroundImage !== "none") result = "complex";
      else if (alphaOf(st.backgroundColor) >= 0.15) result = st.backgroundColor;
      if (result !== null) {
        this.backdropCache.set(cur, result);
        return result;
      }
      cur = cur.parentElement;
    }
    return this.pageCanvas;
  }

  /**
   * The color of the page's visible canvas — what shows through where no
   * ancestor paints. Dark-theme sites (google.com among them) often paint
   * the page from an *underlay* div that is nobody's ancestor; assuming a
   * white canvas there made same-colored boxes look like they contrast,
   * turning invisible containers into phantom platforms.
   */
  private resolvePageCanvas(): string {
    const html = this.styleFor(document.documentElement);
    if (alphaOf(html.backgroundColor) >= 0.9) return html.backgroundColor;
    if (document.body) {
      const body = this.styleFor(document.body);
      if (alphaOf(body.backgroundColor) >= 0.9) return body.backgroundColor;
    }
    // Sample what is actually rendered at points that are usually bare
    // background, and take the first viewport-filling opaque layer.
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    for (const [fx, fy] of [
      [0.5, 0.98],
      [0.02, 0.5],
      [0.98, 0.5],
    ]) {
      for (const hit of document.elementsFromPoint(vw * fx, vh * fy)) {
        const st = this.styleFor(hit);
        if (alphaOf(st.backgroundColor) < 0.9) continue;
        const r = hit.getBoundingClientRect();
        if (r.width >= vw * 0.7 && r.height >= vh * 0.7) return st.backgroundColor;
        break; // an opaque but small element: this point is inside content
      }
    }
    return "rgb(255, 255, 255)"; // the browser's default canvas
  }

  /** Does this element paint something a person can actually see? */
  private paints(el: Element, st: CSSStyleDeclaration): boolean {
    const tag = el.tagName.toUpperCase();
    if (tag === "IMG") {
      const img = el as HTMLImageElement;
      return img.complete && img.naturalWidth > 0;
    }
    if (REPLACED.has(tag)) return true;
    // A painting background already answers the question; don't read all
    // four computed borders and the shadow on the common card path.
    if (st.backgroundImage !== "none") return true;
    if (alphaOf(st.backgroundColor) >= 0.15) {
      const backdrop = this.backdropOf(el);
      // A background identical to what's behind it is invisible.
      if (backdrop === "complex" || colorsDiffer(st.backgroundColor, backdrop)) return true;
    }
    return hasVisibleBorder(st) || shadowVisible(st.boxShadow);
  }

  /** Is the element (or an ancestor) glued to the viewport? */
  private viewportGlued(el: Element): boolean {
    let cur: Element | null = el;
    while (cur && cur !== document.documentElement) {
      let glued = this.gluedCache.get(cur);
      if (glued === undefined) {
        const pos = this.styleFor(cur).position;
        glued = pos === "fixed" || pos === "sticky";
        this.gluedCache.set(cur, glued);
      }
      if (glued) return true;
      cur = cur.parentElement;
    }
    return false;
  }

  /** Invalidate viewport-space clips after layout or scrolling changes. */
  clearClipCache(): void {
    this.clipCache.clear();
  }

  private intersectBoxes(a: Box, b: Box): Box {
    const x = Math.max(a.x, b.x);
    const y = Math.max(a.y, b.y);
    return {
      x, y,
      w: Math.min(a.x + a.w, b.x + b.w) - x,
      h: Math.min(a.y + a.h, b.y + b.h) - y,
    };
  }

  /** All clips through this ancestor; null means no clipping at all. */
  private ancestorClip(el: Element | null): Box | null {
    if (!el || el === document.body || el === document.documentElement) return null;
    if (this.clipCache.has(el)) return this.clipCache.get(el)!;
    let clip = this.ancestorClip(el.parentElement);
    const st = this.styleFor(el);
    if (/(hidden|clip|auto|scroll)/.test(st.overflow + st.overflowX + st.overflowY)) {
      const r = el.getBoundingClientRect();
      const box = { x: r.left, y: r.top, w: r.width, h: r.height };
      clip = clip ? this.intersectBoxes(clip, box) : box;
    }
    this.clipCache.set(el, clip);
    return clip;
  }

  /** Clip a (viewport-coords) box by every overflow-hiding ancestor. */
  private clipByAncestors(el: Element, box: Box): Box | null {
    const clip = this.ancestorClip(el.parentElement);
    // Unclipped boxes pass as they are: a 2px <hr> or a forced 30px icon
    // already got through their own size gates.
    if (!clip) return box;
    const clipped = this.intersectBoxes(box, clip);
    return clipped.w < MIN_WIDTH || clipped.h < 4 ? null : clipped;
  }

  /** Text fragments on the same line share ink, not the heading's layout box. */
  private headingLines(el: Element): Box[] {
    const range = document.createRange();
    range.selectNodeContents(el);
    const fragments = range.getClientRects();
    // Single text runs need no grouping/sorting; their box is also exactly
    // the old getBoundingClientRect ink box.
    if (fragments.length === 1) {
      const r = fragments[0];
      return r.width >= MIN_WIDTH && r.height >= 8
        ? [{ x: r.left, y: r.top, w: r.width, h: r.height }] : [];
    }
    const lines: Box[] = [];
    for (const r of fragments) {
      if (r.width <= 0 || r.height <= 0) continue;
      const line = lines.find((b) =>
        Math.min(b.y + b.h, r.bottom) - Math.max(b.y, r.top) > Math.min(b.h, r.height) / 2
      );
      if (line) {
        const right = Math.max(line.x + line.w, r.right);
        const bottom = Math.max(line.y + line.h, r.bottom);
        line.x = Math.min(line.x, r.left);
        line.y = Math.min(line.y, r.top);
        line.w = right - line.x;
        line.h = bottom - line.y;
      } else {
        lines.push({ x: r.left, y: r.top, w: r.width, h: r.height });
      }
    }
    return lines.filter((b) => b.w >= MIN_WIDTH && b.h >= 8)
      .sort((a, b) => a.y - b.y || a.x - b.x).slice(0, 16);
  }

  /** Visible walking spans: painting overlays cut holes in the top edge. */
  private visibleSpans(el: Element, box: Box, vw = window.innerWidth, vh = window.innerHeight): Box[] {
    const y = box.y + 2;
    if (y < 0 || y > vh) return [box]; // off screen: trust it
    let spans: Array<[number, number]> = [[box.x, box.x + box.w]];
    // Refinement often hits the same overlay or transparent scrim again.
    // Resolve each layer's paint and bounds only once for this row.
    const layers = new Map<Element, DOMRect | null>();
    const subtractAt = (x: number): boolean => {
      if (x < 0 || x > vw) return false;
      for (const hit of document.elementsFromPoint(x, y)) {
        if (hit === el || el.contains(hit) || hit.contains(el)) break;
        let cover = layers.get(hit);
        if (cover === undefined) {
          cover = this.paints(hit, this.styleFor(hit)) ? hit.getBoundingClientRect() : null;
          layers.set(hit, cover);
        }
        if (!cover) continue; // invisible event scrims hide nothing
        if (y < cover.top || y >= cover.bottom) return false;
        const next: Array<[number, number]> = [];
        let changed = false;
        for (const [left, right] of spans) {
          if (cover.left >= right || cover.right <= left) {
            next.push([left, right]);
          } else {
            changed = true;
            if (cover.left > left) next.push([left, cover.left]);
            if (cover.right < right) next.push([cover.right, right]);
          }
        }
        spans = next;
        return changed; // the first painting layer is the occluder
      }
      return false;
    };

    const n = Math.max(3, Math.min(9, Math.round(box.w / 96)));
    let covered = false;
    for (let i = 0; i < n; i++) {
      if (subtractAt(box.x + box.w * (i + 0.5) / n)) covered = true;
    }
    // Most windows have no overlay: no refinement work in the common case.
    if (!covered) return [box];
    for (let round = 0; round < 3 && spans.length; round++) {
      spans = spans.filter(([left, right]) => right - left >= MIN_WIDTH);
      let changed = false;
      for (const [left, right] of spans.slice()) {
        for (const x of [(left + right) / 2, left + 2, right - 2]) {
          if (subtractAt(x)) changed = true;
        }
      }
      if (!changed) break;
    }
    return spans.filter(([left, right]) => right - left >= MIN_WIDTH)
      .map(([left, right]) => ({ x: left, y: box.y, w: right - left, h: box.h }));
  }

  /** Evaluate a measured candidate; null prunes an invisible subtree. */
  private piecesFor(el: Element, hint: string | null, rect: DOMRect, view: Box): Surface[] | null {
    const tag = el.tagName.toUpperCase();
    const forced = hint === "solid" || hint === "pixel";
    if (forced) {
      // The user explicitly forced this element: only reject degenerates.
      if (rect.width < 4 || rect.height < 4) return [];
    } else {
      if (rect.width < MIN_WIDTH || rect.height < (tag === "HR" ? 1 : MIN_HEIGHT)) return [];
      // Skip page-wrapper sized boxes; penguins should walk on things,
      // not be walled in by the layout.
      if (rect.width > view.w * 0.98 && rect.height > view.h * 0.85) return [];
      if (rect.height > view.h * 1.5) return [];
    }

    // Most elements fail the cheap size gates. Only pay for style once we
    // need it anyway; descendants of invisible small wrappers are also
    // rejected by checkVisibility, without eagerly styling every wrapper.
    const st = this.styleFor(el);
    if (parseFloat(st.opacity) < 0.15 || st.contentVisibility === "hidden") return null;
    // Visibility:hidden can be undone by a child, unlike display/opacity;
    // rejecting this candidate must not prune its whole subtree.
    const cv = (
      el as HTMLElement & { checkVisibility?: (o: object) => boolean }
    ).checkVisibility;
    if (cv) {
      if (!cv.call(el, { checkOpacity: true, checkVisibilityCSS: true })) return [];
    } else if (st.visibility === "hidden") return [];

    const solid = forced || this.paints(el, st);
    const heading = !solid && HEADINGS.has(tag);
    const boxes: Box[] = heading ? this.headingLines(el) : solid
      ? [{ x: rect.left, y: rect.top, w: rect.width, h: rect.height }] : [];
    if (!boxes.length) return [];

    // Camera-glued boxes must not bulldoze toons as ordinary solids. Keep
    // them as rectangular, top-only platforms, outside the collision region.
    const pos = st.position;
    this.gluedCache.set(el, pos === "fixed" || pos === "sticky");
    const platform = this.viewportGlued(el);

    const pieces: Surface[] = [];
    for (const initial of boxes) {
      const clipped = this.clipByAncestors(el, initial);
      if (!clipped) continue;
      let box = clipped;

      // Pixel-shaped collision for images/canvases: the alpha channel is
      // the collision shape (the web's X11 SHAPE extension). "pixel"-forced
      // elements get rasterized whatever they are (text, gradients, bg
      // images) and collide with their drawn pixels.
      let mask: PixelMask | undefined;
      let maskDX = 0;
      let maskDY = 0;
      if (!platform && (hint === "pixel" || (MASKABLE.has(tag) && hint !== "solid"))) {
        const info =
          hint === "pixel"
            ? this.masks.lookupForced(el, rect.width, rect.height)
            : this.masks.lookup(el, rect.width, rect.height);
        if (info.status === "empty") continue; // fully transparent: not solid
        if (info.status === "masked") {
          mask = info.mask;
          maskDX = Math.round(box.x - rect.left);
          maskDY = Math.round(box.y - rect.top);
        }
      }

      // Rounded corners become part of the collision shape: a procedural
      // rounded-rect mask lets toons walk down the shoulder of the curve
      // and fall off at the *visual* edge, not where the rounding starts.
      // Bare heading lines paint no box, so they have no visible corners.
      if (!platform && !mask && !heading) {
        const radii = normalizeRadii(rect.width, rect.height, {
          tl: radiusPair(st.borderTopLeftRadius, rect.width, rect.height),
          tr: radiusPair(st.borderTopRightRadius, rect.width, rect.height),
          br: radiusPair(st.borderBottomRightRadius, rect.width, rect.height),
          bl: radiusPair(st.borderBottomLeftRadius, rect.width, rect.height),
        });
        const maxR = Math.max(
          radii.tl.x, radii.tl.y, radii.tr.x, radii.tr.y,
          radii.br.x, radii.br.y, radii.bl.x, radii.bl.y
        );
        if (maxR > 8) {
          const rounded = buildRoundedRectMask(rect.width, rect.height, radii);
          if (rounded) {
            mask = rounded;
            maskDX = Math.round(box.x - rect.left);
            maskDY = Math.round(box.y - rect.top);
          } else {
            // Too big to mask: inset so nobody stands on phantom corner air.
            const inset = Math.min(Math.max(radii.tl.x, radii.tr.x), box.w / 4);
            box = { x: box.x + inset, y: box.y, w: box.w - 2 * inset, h: box.h };
            if (box.w < MIN_WIDTH) continue;
          }
        }
      }

      for (const span of this.visibleSpans(el, box, view.w, view.h)) {
        if (platform && span.y < 24) continue; // leave room to draw its riders
        const preLeft = span.x === box.x ? initial.x : span.x;
        const preRight = span.x + span.w === box.x + box.w ? initial.x + initial.w : span.x + span.w;
        pieces.push({
          id: idFor(el) * 16 + pieces.length,
          el,
          platform,
          x: span.x + view.x,
          y: span.y + view.y,
          w: span.w,
          h: span.h,
          mask,
          maskDX: maskDX + span.x - box.x,
          maskDY,
          relX: preLeft - rect.left,
          relY: initial.y - rect.top,
          preW: preRight - preLeft,
          preH: initial.h,
          rectW: rect.width,
          rectH: rect.height,
          clipRelX: initial.x - rect.left,
          clipW: initial.w,
          insetX: box.x - clipped.x,
        });
        if (pieces.length === 16) return pieces;
      }
    }
    return pieces;
  }

  scan(): void {
    if (!document.body) return;
    this.scanCount++;
    // Snapshot browser geometry once, not once per gate, piece or sample.
    const view = { x: window.scrollX, y: window.scrollY, w: window.innerWidth, h: window.innerHeight };
    this.backdropCache.clear();
    this.gluedCache.clear();
    this.styleCache.clear();
    this.clearClipCache();
    this.pageCanvas = this.resolvePageCanvas();

    // Only these paths need visiting inside ignored/accepted subtrees.
    // Filter via hintFor so an ignore override on the same element wins.
    const selectors = ['[data-webpenguins="solid"]', '[data-webpenguins="pixel"]'];
    if (this.solidJoined) selectors.push(this.solidJoined);
    if (this.pixelJoined) selectors.push(this.pixelJoined);
    const forced = new Set<Element>();
    const forcedAncestors = new Set<Element>();
    for (const el of document.body.querySelectorAll(selectors.join(", "))) {
      const hint = this.hintFor(el);
      if (hint !== "solid" && hint !== "pixel") continue;
      forced.add(el);
      let cur = el.parentElement;
      while (cur && cur !== document.body) {
        if (forcedAncestors.has(cur)) break;
        forcedAncestors.add(cur);
        cur = cur.parentElement;
      }
    }

    const found: Surface[] = [];
    const foundPlatforms: Surface[] = [];
    const stack: Array<{ el: Element; onlyForced: boolean }> = [];
    const descend = (el: Element, onlyForced: boolean) => {
      // Reverse push keeps pre-order document order without examining the
      // descendants of a window (or burning their share of the budget).
      for (let child = el.lastElementChild; child; child = child.previousElementSibling) {
        stack.push({ el: child, onlyForced });
      }
    };
    descend(document.body, false);
    let examined = 0;
    while (stack.length && examined < MAX_EXAMINED && found.length + foundPlatforms.length < MAX_COLLECTED) {
      const { el, onlyForced } = stack.pop()!;
      if (NEVER_SOLID.has(el.tagName.toUpperCase())) continue;
      const hint = this.hintFor(el);
      if (hint === "ignore" || (onlyForced && !forced.has(el))) {
        if (forcedAncestors.has(el)) descend(el, true);
        continue;
      }

      examined++;
      const rect = el.getBoundingClientRect();
      // display:none measures 0x0; don't style ordinary tiny descendants
      // just to discover that they're too small to be candidates.
      if (rect.width === 0 && rect.height === 0 && this.styleFor(el).display === "none") continue;
      const pieces = this.piecesFor(el, hint, rect, view);
      if (pieces === null) continue;
      if (pieces.length) {
        const collection = pieces[0].platform ? foundPlatforms : found;
        collection.push(...pieces.slice(0, MAX_COLLECTED - found.length - foundPlatforms.length));
        // Windows/platforms don't nest, but forced descendants still win.
        if (forcedAncestors.has(el)) descend(el, true);
      } else {
        descend(el, onlyForced);
      }
    }

    // Keep the surfaces nearest the viewport (long feeds have hundreds).
    if (found.length > MAX_SURFACES) {
      const center = view.y + view.h / 2;
      const pinnedIds = new Set(this.pinnedProvider?.());
      const pinnedElements = new Set<Element>();
      // IDs describe old pieces; pin their owning elements so a new split
      // doesn't window out another part of the same ridden surface.
      for (const s of this.surfaces) if (pinnedIds.has(s.id)) pinnedElements.add(s.el);
      found.sort(
        (a, b) => Number(pinnedElements.has(b.el)) - Number(pinnedElements.has(a.el)) ||
          Math.abs(a.y + a.h / 2 - center) - Math.abs(b.y + b.h / 2 - center)
      );
      found.length = MAX_SURFACES;
    }

    if (foundPlatforms.length > MAX_PLATFORMS) {
      const center = view.y + view.h / 2;
      foundPlatforms.sort((a, b) => Math.abs(a.y + a.h / 2 - center) - Math.abs(b.y + b.h / 2 - center));
      foundPlatforms.length = MAX_PLATFORMS;
    }

    const now = performance.now();
    for (const s of found) {
      const old = this.scanPositions.get(s.id);
      if (old && (Math.abs(s.x - old.x) > 0.5 || Math.abs(s.y - old.y) > 0.5)) this.markHot(s.el, now);
    }
    this.scanPositions = new Map(found.map((s) => [s.id, { x: s.x, y: s.y }]));
    this.surfaces = found;
    this.platforms = foundPlatforms;
    this.generation++;
  }

  /** Remeasure moving windows between scans, without rebuilding their shapes. */
  track(): void {
    this.clearClipCache();
    const now = performance.now();
    for (const [el, until] of this.hot) {
      if (until <= now) {
        this.hot.delete(el);
        // Reconcile visibility, occlusion and shape once motion has settled.
        this.scheduleRescan(50);
      }
    }
    if (!this.hot.size) return;
    this.styleCache.clear();
    const sx = window.scrollX, sy = window.scrollY;
    const groups = new Map<Element, Surface[]>();
    for (const s of this.surfaces) {
      if (!this.hot.has(s.el)) continue;
      const pieces = groups.get(s.el);
      if (pieces) pieces.push(s);
      else groups.set(s.el, [s]);
    }
    const removed = new Set<Surface>();
    let changed = false;
    for (const [el, pieces] of groups) {
      const r = el.getBoundingClientRect();
      if (Math.abs(r.width - pieces[0].rectW) > 1 || Math.abs(r.height - pieces[0].rectH) > 1) {
        this.scheduleRescan(50); // a resized mask must be rebuilt, not stretched
        continue;
      }
      for (const s of pieces) {
        const clipped = this.clipByAncestors(el, {
          x: r.left + s.relX, y: r.top + s.relY, w: s.preW, h: s.preH,
        });
        if (!clipped) {
          removed.add(s);
          changed = true;
          continue;
        }
        const base = s.mask || s.insetX ? this.clipByAncestors(el, {
          x: r.left + s.clipRelX, y: r.top + s.relY, w: s.clipW, h: s.preH,
        }) : clipped;
        if (!base) {
          removed.add(s);
          changed = true;
          continue;
        }
        const baseX = base.x + s.insetX;
        const left = Math.max(clipped.x, baseX);
        const right = Math.min(clipped.x + clipped.w, base.x + base.w - s.insetX);
        // Too narrow only if clipping made it so (forced pieces can be slim).
        if (right - left <= 0 || (right - left < MIN_WIDTH && right - left < s.preW - 1)) {
          removed.add(s);
          changed = true;
          continue;
        }
        const x = left + sx, y = clipped.y + sy, w = right - left, h = clipped.h;
        // Keep step 2's scheme: round the ancestor clip's mask origin, then
        // add the (possibly fractional) shift to this visible span.
        const maskDX = Math.round(baseX - r.left) + left - baseX;
        const maskDY = Math.round(clipped.y - r.top);
        if (s.x !== x || s.y !== y || s.w !== w || s.h !== h ||
            (s.mask && (s.maskDX !== maskDX || s.maskDY !== maskDY))) {
          s.x = x; s.y = y; s.w = w; s.h = h;
          if (s.mask) { s.maskDX = maskDX; s.maskDY = maskDY; }
          changed = true;
        }
      }
    }
    if (removed.size) this.surfaces = this.surfaces.filter((s) => !removed.has(s));
    if (changed) this.generation++;
  }

  /** Current solid rects in document coordinates. */
  getRects(): SolidRect[] {
    const worldW = document.documentElement.clientWidth;
    const out: SolidRect[] = [];
    for (const s of this.surfaces) {
      // Same exclusions as ToonLocateWindows, applied to the document: a
      // surface touching the top of the page is not solid — otherwise
      // nothing could ever fall in from above.
      if (s.y <= 0) continue;
      if (s.x >= worldW || s.x + s.w < 0) continue;
      out.push({
        id: s.id,
        x: Math.round(s.x),
        y: Math.round(s.y),
        w: Math.round(s.w),
        h: Math.round(s.h),
        mask: s.mask,
        maskDX: s.maskDX,
        maskDY: s.maskDY,
      });
    }
    return out;
  }

  /** Camera-glued pieces move even when no full scan or hot tracking runs. */
  getPlatforms(): SolidRect[] {
    this.clearClipCache();
    this.styleCache.clear();
    const sx = window.scrollX, sy = window.scrollY;
    const measured = new Map<Element, DOMRect | null>();
    const kept: Surface[] = [];
    const out: SolidRect[] = [];
    for (const s of this.platforms) {
      let r = measured.get(s.el);
      if (r === undefined) {
        r = s.el.isConnected ? s.el.getBoundingClientRect() : null;
        if (r && (r.width <= 0 || r.height <= 0)) r = null;
        measured.set(s.el, r);
      }
      if (!r) continue; // a detached/zero-sized element needs a fresh scan
      kept.push(s);
      const clipped = this.clipByAncestors(s.el, {
        x: r.left + s.relX, y: r.top + s.relY, w: s.preW, h: s.preH,
      });
      if (!clipped || clipped.y < 24) continue;
      s.x = clipped.x + sx; s.y = clipped.y + sy; s.w = clipped.w; s.h = clipped.h;
      out.push({ id: s.id, x: Math.round(s.x), y: Math.round(s.y), w: Math.round(s.w), h: Math.round(s.h) });
    }
    this.platforms = kept;
    return out;
  }

  /** Did the layout change since this was last called? (scrolling doesn't) */
  movedSinceLastTick(): boolean {
    const moved = this.generation !== this.lastTickGeneration;
    this.lastTickGeneration = this.generation;
    return moved;
  }

  /**
   * Debug: why is (or isn't) this element a surface? Runs the scan gates on
   * one element and reports each verdict. From devtools, with the engine
   * started with { debug: true }: window.__webpenguins.explain($0)
   */
  explain(el: Element): Record<string, unknown> {
    const describe = (e: Element) =>
      e.tagName + (e.className && typeof e.className === "string" ? "." + e.className.split(/\s+/).join(".").slice(0, 60) : "");
    const out: Record<string, unknown> = { element: describe(el) };
    const fail = (because: string) => {
      out.solid = false;
      out.because = because;
      return out;
    };
    const tag = el.tagName.toUpperCase();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const rect = el.getBoundingClientRect();
    out.rect = `${Math.round(rect.left)},${Math.round(rect.top)} ${Math.round(rect.width)}x${Math.round(rect.height)} (viewport coords)`;

    if (NEVER_SOLID.has(tag)) return fail("this tag is never solid");
    const hint = this.hintFor(el);
    if (hint === "ignore") return fail("ignored (override selector or data-webpenguins)");
    if (hint === "pixel") out.note = "forced pixel-perfect: collides with its rasterized pixels";
    if (hint === "solid" || hint === "pixel") {
      if (rect.width < 4 || rect.height < 4) return fail("too small (forced elements need 4x4)");
    } else {
      if (rect.width < MIN_WIDTH || rect.height < (tag === "HR" ? 1 : MIN_HEIGHT)) {
        return fail(`too small (needs ${MIN_WIDTH}x${MIN_HEIGHT})`);
      }
      if (rect.width > vw * 0.98 && rect.height > vh * 0.85) return fail("page-wrapper sized");
      if (rect.height > vh * 1.5) return fail("taller than 1.5 viewports");
    }
    const forcedHint = hint === "solid" || hint === "pixel";
    const ancestors: Element[] = [];
    for (let cur = el.parentElement; cur && cur !== document.body; cur = cur.parentElement) ancestors.push(cur);
    let onlyForced = false;
    for (const cur of ancestors.reverse()) {
      if (NEVER_SOLID.has(cur.tagName.toUpperCase())) return fail("inside a never-solid subtree");
      const ancestorHint = this.hintFor(cur);
      if (ancestorHint === "ignore") {
        if (!forcedHint) return fail("inside an ignored subtree");
        onlyForced = true;
        continue;
      }
      // The traversal doesn't evaluate non-candidates on forced-only paths.
      if (onlyForced && ancestorHint !== "solid" && ancestorHint !== "pixel") continue;
      const ar = cur.getBoundingClientRect();
      const ancestorForced = ancestorHint === "solid" || ancestorHint === "pixel";
      const sized = ancestorForced ? ar.width >= 4 && ar.height >= 4 :
        ar.width >= MIN_WIDTH && ar.height >= (cur.tagName.toUpperCase() === "HR" ? 1 : MIN_HEIGHT) &&
        !(ar.width > vw * 0.98 && ar.height > vh * 0.85) && ar.height <= vh * 1.5;
      // Match the lazy pruning gates: undersized wrappers aren't styled,
      // except a 0x0 box which may hide its entire subtree via display:none.
      if (sized || (ar.width === 0 && ar.height === 0)) {
        const ast = getComputedStyle(cur);
        if ((ar.width === 0 && ar.height === 0 && ast.display === "none") ||
            (sized && (parseFloat(ast.opacity) < 0.15 || ast.contentVisibility === "hidden"))) {
          return fail("inside an invisible subtree");
        }
      }
      if ([...this.surfaces, ...this.platforms].some((s) => s.el === cur)) onlyForced = true;
    }
    const parent = [...this.surfaces, ...this.platforms].find((s) => s.el !== el && s.el.contains(el));
    if (parent && hint !== "solid" && hint !== "pixel") {
      return fail("nested inside an accepted surface/platform: " + describe(parent.el));
    }

    const st = getComputedStyle(el);
    const cv = (el as HTMLElement & { checkVisibility?: (o: object) => boolean }).checkVisibility;
    if (st.visibility === "hidden" || st.display === "none" || parseFloat(st.opacity) < 0.15 ||
        st.contentVisibility === "hidden" || (cv && !cv.call(el, { checkOpacity: true, checkVisibilityCSS: true }))) {
      return fail("not visible");
    }
    out.pageCanvas = this.pageCanvas;
    out.backdrop = this.backdropOf(el);
    out.background = st.backgroundColor;
    const paints = hint === "solid" || hint === "pixel" || this.paints(el, st);
    out.paints = hint === "solid" || hint === "pixel" ? "forced" : paints;
    const heading = !paints && HEADINGS.has(tag);
    const boxes = heading ? this.headingLines(el) : [{ x: rect.left, y: rect.top, w: rect.width, h: rect.height }];
    if (heading) {
      out.note = "heading: collides per text ink line (no rounded-corner mask)";
      out.lines = boxes.length;
      if (!boxes.length) return fail("heading has no ink lines large enough to collide");
    } else if (!paints) {
      return fail(
        "paints nothing visible (no border/shadow/image, and its background does not differ from the backdrop behind it)"
      );
    }
    const platform = this.viewportGlued(el);
    if (platform) {
      out.note = "fixed/sticky: one-way rectangular platform (top edge only; no masks)";
      out.platform = false;
    }
    this.clearClipCache();
    const clipped = boxes.map((box) => this.clipByAncestors(el, box)).filter((box): box is Box => box !== null);
    if (!clipped.length) return fail("fully clipped by an overflow ancestor");
    if (!platform && (hint === "pixel" || (MASKABLE.has(tag) && hint !== "solid"))) {
      out.mask =
        hint === "pixel"
          ? this.masks.lookupForced(el, rect.width, rect.height).status
          : this.masks.lookup(el, rect.width, rect.height).status;
      if (out.mask === "empty") return fail("mask: fully transparent content");
    }
    let spans = clipped.flatMap((box) => this.visibleSpans(el, box)).slice(0, 16);
    if (!spans.length) return fail("top edge covered by another painting element");
    if (platform) {
      spans = spans.filter((box) => box.y >= 24);
      if (!spans.length) return fail("platform top is above the 24px viewport margin");
    }
    if (spans.length !== clipped.length || spans.some((span, i) => span.x !== clipped[i].x || span.w !== clipped[i].w)) {
      out.spans = `${spans.length} visible spans: ` + spans.map((span) =>
        `${Math.round(span.x + window.scrollX)}..${Math.round(span.x + span.w + window.scrollX)}`
      ).join(", ");
    }
    if (platform) {
      const ids = new Set(this.platforms.filter((s) => s.el === el).map((s) => s.id));
      out.platform = this.getPlatforms().some((r) => ids.has(r.id));
      out.solid = false; // platforms never join the solid collision region
      if (!out.platform) out.because = "passes the platform gates — not scanned yet or outside the nearest-12 platform window";
      return out;
    }
    out.solid = this.surfaces.some((s) => s.el === el);
    if (!out.solid) {
      out.because =
        "passes every gate — likely scanned before it existed, beyond the examine limit, or lost the nearest-160 windowing; it should appear on the next rescan if visible";
    }
    return out;
  }
}
