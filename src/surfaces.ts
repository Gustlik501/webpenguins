// The web equivalent of ToonLocateWindows(): find DOM elements that read as
// solid "windows" a toon can walk on, climb, and be squashed by.
//
// Everything lives in *document* coordinates: the page is the desktop and
// scrolling merely moves the camera. Toons keep living on their surfaces
// whether they are on screen or not. Only real layout changes (rescans that
// move a rect) count as "windows moving" and go through the association /
// relocation / squash machinery of the original.
import { SolidRect } from "./types";

// Tags that are always window-like when visible and big enough.
const ALWAYS_SOLID = new Set([
  "IMG",
  "VIDEO",
  "CANVAS",
  "IFRAME",
  "OBJECT",
  "EMBED",
  "PRE",
  "TABLE",
  "FIGURE",
  "BLOCKQUOTE",
  "BUTTON",
  "TEXTAREA",
  "SELECT",
  "HR",
  "H1",
  "H2",
  "H3",
  "NAV",
]);

// Tags that count only if they look like a visual "card".
const MAYBE_SOLID = new Set([
  "DIV",
  "SECTION",
  "ARTICLE",
  "ASIDE",
  "HEADER",
  "FOOTER",
  "MAIN",
  "FORM",
  "DETAILS",
  "FIELDSET",
  "DIALOG",
  "A",
  "LI",
  "SVG",
]);

const MAX_SURFACES = 128;
const MIN_WIDTH = 44;
const MIN_HEIGHT = 14;

interface Surface {
  id: number;
  el: Element;
  // document coords
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

function looksLikeCard(style: CSSStyleDeclaration): boolean {
  if (style.boxShadow !== "none") return true;
  if (parseFloat(style.borderTopWidth) > 0 && style.borderTopStyle !== "none") return true;
  const bg = style.backgroundColor;
  if (bg && bg !== "transparent") {
    const m = /rgba?\(([^)]+)\)/.exec(bg);
    if (m) {
      const parts = m[1].split(",");
      const alpha = parts.length === 4 ? parseFloat(parts[3]) : 1;
      if (alpha > 0.1) return true;
    }
  }
  if (style.backgroundImage !== "none") return true;
  return false;
}

export class Surfaces {
  private surfaces: Surface[] = [];
  private generation = 0;
  private lastTickGeneration = -1;
  private rescanTimer: ReturnType<typeof setTimeout> | undefined;
  private intervalTimer: ReturnType<typeof setInterval> | undefined;
  private observer: MutationObserver | undefined;
  private listeners: Array<() => void> = [];

  start(): void {
    this.scan();

    const schedule = (delay: number) => this.scheduleRescan(delay);

    const onResize = () => schedule(100);
    const onLoad = () => schedule(200);
    window.addEventListener("resize", onResize);
    // Image loads (etc.) shift layout without DOM mutations.
    window.addEventListener("load", onLoad, true);
    this.listeners.push(
      () => window.removeEventListener("resize", onResize),
      () => window.removeEventListener("load", onLoad, true)
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
    clearTimeout(this.rescanTimer);
    this.rescanTimer = setTimeout(() => this.scan(), delay);
  }

  scan(): void {
    if (!document.body) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const found: Surface[] = [];
    const accepted: Element[] = [];

    const candidates = document.body.querySelectorAll<HTMLElement>("*");
    for (const el of candidates) {
      if (found.length >= MAX_SURFACES) break;
      const tag = el.tagName;
      const hint = el.getAttribute("data-webpenguins");
      if (hint === "ignore") continue;
      const always = hint === "solid" || ALWAYS_SOLID.has(tag);
      if (!always && !MAYBE_SOLID.has(tag)) continue;
      if (el.closest('[data-webpenguins="ignore"]')) continue;

      // Windows don't nest: skip descendants of accepted surfaces.
      if (accepted.some((a) => a.contains(el))) continue;

      const rect = el.getBoundingClientRect();
      if (rect.width < MIN_WIDTH || rect.height < MIN_HEIGHT) continue;
      // Skip page-wrapper sized boxes; penguins should walk on things,
      // not be walled in by the layout.
      if (rect.width > vw * 0.98 && rect.height > vh * 0.85) continue;
      if (rect.height > vh * 1.5) continue;

      const style = getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none") continue;
      if (parseFloat(style.opacity) < 0.15) continue;
      // Fixed/sticky elements are glued to the viewport, not the page — in a
      // document-space world they would bulldoze toons on every scroll.
      if (style.position === "fixed" || style.position === "sticky") continue;
      if (!always && !looksLikeCard(style)) continue;

      accepted.push(el);
      found.push({
        id: idFor(el),
        el,
        x: rect.left + window.scrollX,
        y: rect.top + window.scrollY,
        w: rect.width,
        h: rect.height,
      });
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
      out.push({ id: s.id, x: Math.round(s.x), y: Math.round(s.y), w: Math.round(s.w), h: Math.round(s.h) });
    }
    return out;
  }

  /** Did the layout change since this was last called? (scrolling doesn't) */
  movedSinceLastTick(): boolean {
    const moved = this.generation !== this.lastTickGeneration;
    this.lastTickGeneration = this.generation;
    return moved;
  }
}
