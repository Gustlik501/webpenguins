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
const MAX_COLLECTED = 320;
const MAX_EXAMINED = 6000;
const MIN_WIDTH = 44;
const MIN_HEIGHT = 10;

interface Surface {
  id: number;
  el: Element;
  // document coords
  x: number;
  y: number;
  w: number;
  h: number;
  mask?: PixelMask;
  maskDX?: number;
  maskDY?: number;
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
  private generation = 0;
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
  private pageCanvas = "rgb(255, 255, 255)";
  // pixel masks (rescan shortly after a cross-origin retry succeeds)
  private masks = new MaskRegistry(() => this.scheduleRescan(50));
  // user overrides (dev mode / options): CSS selectors, joined for matches()
  private solidJoined = "";
  private ignoreJoined = "";
  private pixelJoined = "";

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

  /** The accepted surface element that is (or contains) `el`, if any. */
  surfaceContaining(el: Element): Element | null {
    for (const s of this.surfaces) {
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
    // Scrolling doesn't move document-space rects, but the surface window
    // (we keep the ~160 boxes nearest the viewport) should follow the user.
    const onScroll = () => schedule(300);
    window.addEventListener("resize", onResize);
    window.addEventListener("load", onLoad, true);
    window.addEventListener("scroll", onScroll, { passive: true });
    this.listeners.push(
      () => window.removeEventListener("resize", onResize),
      () => window.removeEventListener("load", onLoad, true),
      () => window.removeEventListener("scroll", onScroll)
    );

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

  /** The effective background color behind an element (or "complex"). */
  private backdropOf(el: Element): string {
    let cur = el.parentElement;
    while (cur) {
      const cached = this.backdropCache.get(cur);
      if (cached !== undefined) return cached;
      const st = getComputedStyle(cur);
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
    const html = getComputedStyle(document.documentElement);
    if (alphaOf(html.backgroundColor) >= 0.9) return html.backgroundColor;
    if (document.body) {
      const body = getComputedStyle(document.body);
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
        const st = getComputedStyle(hit);
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
    if (hasVisibleBorder(st)) return true;
    if (shadowVisible(st.boxShadow)) return true;
    if (st.backgroundImage !== "none") return true;
    if (alphaOf(st.backgroundColor) >= 0.15) {
      const backdrop = this.backdropOf(el);
      // A background identical to what's behind it is invisible.
      return backdrop === "complex" || colorsDiffer(st.backgroundColor, backdrop);
    }
    return false;
  }

  /** Is the element (or an ancestor) glued to the viewport? */
  private viewportGlued(el: Element): boolean {
    let cur: Element | null = el;
    while (cur && cur !== document.documentElement) {
      let glued = this.gluedCache.get(cur);
      if (glued === undefined) {
        const pos = getComputedStyle(cur).position;
        glued = pos === "fixed" || pos === "sticky";
        this.gluedCache.set(cur, glued);
      }
      if (glued) return true;
      cur = cur.parentElement;
    }
    return false;
  }

  /** Clip a (viewport-coords) box by every overflow-hiding ancestor. */
  private clipByAncestors(el: Element, box: Box): Box | null {
    let cur = el.parentElement;
    let clipped = box;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      const st = getComputedStyle(cur);
      if (/(hidden|clip|auto|scroll)/.test(st.overflow + st.overflowX + st.overflowY)) {
        const cr = cur.getBoundingClientRect();
        const x1 = Math.max(clipped.x, cr.left);
        const y1 = Math.max(clipped.y, cr.top);
        const x2 = Math.min(clipped.x + clipped.w, cr.right);
        const y2 = Math.min(clipped.y + clipped.h, cr.bottom);
        if (x2 - x1 < MIN_WIDTH || y2 - y1 < 4) return null;
        clipped = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
      }
      cur = cur.parentElement;
    }
    return clipped;
  }

  /** Is the top edge (the walking surface) hidden behind something else? */
  private occluded(el: Element, box: Box): boolean {
    const y = box.y + 2;
    if (y < 0 || y > window.innerHeight) return false; // off screen: trust it
    let samples = 0;
    let covered = 0;
    for (const fx of [0.2, 0.5, 0.8]) {
      const x = box.x + box.w * fx;
      if (x < 0 || x > window.innerWidth) continue;
      samples++;
      // Walk the hit-test stack top-down. Invisible layers (transparent
      // event scrims, positioning wrappers) hide nothing — only an element
      // that actually paints can cover us.
      for (const hit of document.elementsFromPoint(x, y)) {
        if (hit === el || el.contains(hit) || hit.contains(el)) break; // reached our own layer
        if (this.paints(hit, getComputedStyle(hit))) {
          covered++;
          break;
        }
      }
    }
    return samples > 0 && covered === samples;
  }

  scan(): void {
    if (!document.body) return;
    this.scanCount++;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const sx = window.scrollX;
    const sy = window.scrollY;
    this.backdropCache.clear();
    this.gluedCache.clear();
    this.pageCanvas = this.resolvePageCanvas();

    const found: Surface[] = [];
    const accepted: Element[] = [];

    const candidates = document.body.querySelectorAll<HTMLElement>("*");
    const limit = Math.min(candidates.length, MAX_EXAMINED);
    for (let i = 0; i < limit && found.length < MAX_COLLECTED; i++) {
      const el = candidates[i];
      const tag = el.tagName.toUpperCase();
      if (NEVER_SOLID.has(tag)) continue;
      const hint = this.hintFor(el);
      if (hint === "ignore") continue;

      const rect = el.getBoundingClientRect();
      const forced = hint === "solid" || hint === "pixel";
      if (forced) {
        // The user explicitly forced this element: only reject degenerates.
        if (rect.width < 4 || rect.height < 4) continue;
      } else {
        if (rect.width < MIN_WIDTH || rect.height < (tag === "HR" ? 1 : MIN_HEIGHT)) continue;
        // Skip page-wrapper sized boxes; penguins should walk on things,
        // not be walled in by the layout.
        if (rect.width > vw * 0.98 && rect.height > vh * 0.85) continue;
        if (rect.height > vh * 1.5) continue;
      }

      // Subtree ignores wipe whole regions — but an explicit force on a
      // descendant is more specific and wins (ignore the hero, keep its
      // logo solid).
      if (!forced && el.closest('[data-webpenguins="ignore"]')) continue;
      if (!forced && this.ignoreJoined && el.closest(this.ignoreJoined)) continue;
      // Windows don't nest: skip descendants of accepted surfaces — unless
      // the user forced this one (a pixel-perfect headline inside a card).
      if (!forced && accepted.some((a) => a.contains(el))) continue;

      // Visibility, including ancestor display/visibility/opacity.
      const cv = (
        el as HTMLElement & { checkVisibility?: (o: object) => boolean }
      ).checkVisibility;
      if (cv) {
        if (!cv.call(el, { checkOpacity: true, checkVisibilityCSS: true })) continue;
      }
      const st = getComputedStyle(el);
      if (!cv) {
        if (st.visibility === "hidden" || st.display === "none") continue;
        if (parseFloat(st.opacity) < 0.15) continue;
      }

      let box: Box = { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
      let solid = forced || this.paints(el, st);

      // Bare headings: collide with the text's ink box, not the layout box.
      if (!solid && HEADINGS.has(tag)) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const ink = range.getBoundingClientRect();
        if (ink.width >= MIN_WIDTH && ink.height >= 8) {
          box = { x: ink.left, y: ink.top, w: ink.width, h: ink.height };
          solid = true;
        }
      }
      if (!solid) continue;

      // Fixed/sticky elements (or children of them) are glued to the
      // viewport, not the page — they would bulldoze toons on every scroll.
      if (this.viewportGlued(el)) continue;

      const clipped = this.clipByAncestors(el, box);
      if (!clipped) continue;
      box = clipped;

      // Pixel-shaped collision for images/canvases: the alpha channel is
      // the collision shape (the web's X11 SHAPE extension). "pixel"-forced
      // elements get rasterized whatever they are (text, gradients, bg
      // images) and collide with their drawn pixels.
      let mask: PixelMask | undefined;
      let maskDX = 0;
      let maskDY = 0;
      if (hint === "pixel" || (MASKABLE.has(tag) && hint !== "solid")) {
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
      // (Content masks already carry the true shape when we have one.)
      if (!mask) {
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

      if (this.occluded(el, box)) continue;

      accepted.push(el);
      found.push({
        id: idFor(el),
        el,
        x: box.x + sx,
        y: box.y + sy,
        w: box.w,
        h: box.h,
        mask,
        maskDX,
        maskDY,
      });
    }

    // Keep the surfaces nearest the viewport (long feeds have hundreds).
    if (found.length > MAX_SURFACES) {
      const center = sy + vh / 2;
      found.sort(
        (a, b) => Math.abs(a.y + a.h / 2 - center) - Math.abs(b.y + b.h / 2 - center)
      );
      found.length = MAX_SURFACES;
    }

    this.surfaces = found;
    this.generation++;
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
    if (hint !== "solid" && hint !== "pixel") {
      if (rect.width < MIN_WIDTH || rect.height < (tag === "HR" ? 1 : MIN_HEIGHT)) {
        return fail(`too small (needs ${MIN_WIDTH}x${MIN_HEIGHT})`);
      }
      if (rect.width > vw * 0.98 && rect.height > vh * 0.85) return fail("page-wrapper sized");
      if (rect.height > vh * 1.5) return fail("taller than 1.5 viewports");
    }
    const forcedHint = hint === "solid" || hint === "pixel";
    if (!forcedHint && el.closest('[data-webpenguins="ignore"]')) {
      return fail("inside an ignored subtree");
    }
    if (!forcedHint && this.ignoreJoined && el.closest(this.ignoreJoined)) {
      return fail("inside an ignored subtree (override selector)");
    }
    const parent = this.surfaces.find((s) => s.el !== el && s.el.contains(el));
    if (parent && hint !== "solid" && hint !== "pixel") {
      return fail("nested inside an accepted surface: " + describe(parent.el));
    }

    const st = getComputedStyle(el);
    if (st.visibility === "hidden" || st.display === "none" || parseFloat(st.opacity) < 0.15) {
      return fail("not visible");
    }
    out.pageCanvas = this.pageCanvas;
    out.backdrop = this.backdropOf(el);
    out.background = st.backgroundColor;
    const paints = hint === "solid" || hint === "pixel" || this.paints(el, st);
    out.paints = hint === "solid" || hint === "pixel" ? "forced" : paints;
    if (!paints && HEADINGS.has(tag)) out.note = "heading: would collide via its text ink box";
    else if (!paints) {
      return fail(
        "paints nothing visible (no border/shadow/image, and its background does not differ from the backdrop behind it)"
      );
    }
    if (this.viewportGlued(el)) return fail("fixed/sticky: glued to the viewport, not the page");
    const clipped = this.clipByAncestors(el, {
      x: rect.left,
      y: rect.top,
      w: rect.width,
      h: rect.height,
    });
    if (!clipped) return fail("fully clipped by an overflow ancestor");
    if (hint === "pixel" || (MASKABLE.has(tag) && hint !== "solid")) {
      out.mask =
        hint === "pixel"
          ? this.masks.lookupForced(el, rect.width, rect.height).status
          : this.masks.lookup(el, rect.width, rect.height).status;
      if (out.mask === "empty") return fail("mask: fully transparent content");
    }
    if (this.occluded(el, clipped)) return fail("top edge covered by another painting element");
    out.solid = this.surfaces.some((s) => s.el === el);
    if (!out.solid) {
      out.because =
        "passes every gate — likely scanned before it existed, beyond the examine limit, or lost the nearest-160 windowing; it should appear on the next rescan if visible";
    }
    return out;
  }
}
