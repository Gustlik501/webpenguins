// Developer mode overlay: shows exactly what the engine considers
// collidable (down to the pixel-mask shapes) and click-to-override
// (auto -> forced solid -> ignored, stored as CSS selectors so a class can
// be overridden site-wide). The controls and the export snippet live in
// the panel (panel.ts), which turns this overlay on and off.
import { PixelMask } from "./types";
import { World } from "./world";

export interface Overrides {
  solid: string[];
  ignore: string[];
  /** Selectors whose elements collide with their rasterized pixels. */
  pixel: string[];
}

export interface DevHost {
  world: World;
  /** The accepted surface element containing `el`, if any. */
  surfaceContaining(el: Element): Element | null;
  /** Does this accepted surface already collide via a pixel mask? */
  surfaceMasked(el: Element): boolean;
  getOverrides(): Overrides;
  /** Apply + persist new overrides (triggers a rescan). */
  setOverrides(o: Overrides): void;
}

/** Is this (retargeted) event target the control panel? */
export function inPanel(t: EventTarget | null): boolean {
  return t instanceof Element && !!t.closest("[data-webpenguins-devpanel]");
}

interface Box {
  x: number; // document coords
  y: number;
  w: number;
  h: number;
}

const COLOR_SOLID = "34, 197, 94"; // green: collidable
const COLOR_FORCED = "56, 189, 248"; // cyan: forced solid
const COLOR_IGNORED = "248, 113, 113"; // red: forced ignore
const COLOR_PIXEL = "192, 132, 252"; // violet: forced pixel-perfect

/** A short, human-readable selector for an element (id > classes > path). */
export function selectorFor(el: Element): string {
  if (el.id) return "#" + CSS.escape(el.id);
  const tag = el.tagName.toLowerCase();
  const classes = Array.from(el.classList).slice(0, 2);
  if (classes.length) return tag + "." + classes.map((c) => CSS.escape(c)).join(".");
  const parent = el.parentElement;
  if (!parent || parent === document.body || parent === document.documentElement) return tag;
  const index = Array.prototype.indexOf.call(parent.children, el) + 1;
  return `${selectorFor(parent)} > ${tag}:nth-child(${index})`;
}

export class DevMode {
  private hovered: Element | null = null;
  private shiftHeld = false;
  private markCache: { t: number; solid: Box[]; ignore: Box[]; pixel: Box[] } = {
    t: 0,
    solid: [],
    ignore: [],
    pixel: [],
  };
  private maskTints = new WeakMap<PixelMask, HTMLCanvasElement>();
  private listeners: Array<() => void> = [];

  constructor(private host: DevHost) {
    const onMove = (e: MouseEvent) => {
      this.shiftHeld = e.shiftKey;
      const t = e.target as Element | null;
      this.hovered =
        !t ||
        t === document.documentElement ||
        t === document.body ||
        (t instanceof Element && t.getAttribute("data-webpenguins") === "ignore")
          ? null
          : t;
    };
    // Capture-phase click: pick the element instead of activating it.
    const onClick = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (!t || inPanel(t)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (t === document.documentElement || t === document.body) return;
      // Shift picks the exact element under the cursor (a headline inside a
      // card); plain clicks toggle the surface that owns what you clicked.
      if (e.shiftKey) this.togglePixel(t);
      else this.cycle(this.host.surfaceContaining(t) ?? t);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Shift") this.shiftHeld = true;
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Shift") this.shiftHeld = false;
    };
    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("click", onClick, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKeyUp, true);
    this.listeners.push(
      () => window.removeEventListener("mousemove", onMove, true),
      () => window.removeEventListener("click", onClick, true),
      () => window.removeEventListener("keydown", onKey, true),
      () => window.removeEventListener("keyup", onKeyUp, true)
    );
  }

  /** auto -> (solid|ignore depending on current state) -> the other -> auto */
  private cycle(el: Element): void {
    const sel = selectorFor(el);
    const o = this.host.getOverrides();
    const inSolid = o.solid.includes(sel);
    const inIgnore = o.ignore.includes(sel);
    const inPixel = o.pixel.includes(sel);
    o.solid = o.solid.filter((x) => x !== sel);
    o.ignore = o.ignore.filter((x) => x !== sel);
    o.pixel = o.pixel.filter((x) => x !== sel);
    if (inPixel || inIgnore) {
      // back to auto
    } else if (inSolid) {
      o.ignore.push(sel);
    } else {
      // from auto: force the opposite of what the scanner decided
      if (this.host.surfaceContaining(el)) o.ignore.push(sel);
      else o.solid.push(sel);
    }
    this.host.setOverrides(o);
  }

  /** Shift+click: toggle pixel-perfect collision for the element. */
  private togglePixel(el: Element): void {
    const sel = selectorFor(el);
    const o = this.host.getOverrides();
    const on = o.pixel.includes(sel);
    o.solid = o.solid.filter((x) => x !== sel);
    o.ignore = o.ignore.filter((x) => x !== sel);
    o.pixel = o.pixel.filter((x) => x !== sel);
    if (!on) o.pixel.push(sel);
    this.host.setOverrides(o);
  }

  /** Call after overrides change: recollect the override outlines. */
  refresh(): void {
    this.markCache.t = 0;
  }

  private collectMarks(): void {
    const now = performance.now();
    if (now - this.markCache.t < 600) return;
    const sx = window.scrollX;
    const sy = window.scrollY;
    const collect = (sels: string[]): Box[] => {
      const out: Box[] = [];
      for (const sel of sels) {
        let list: NodeListOf<Element>;
        try {
          list = document.querySelectorAll(sel);
        } catch {
          continue;
        }
        for (let i = 0; i < list.length && out.length < 80; i++) {
          const r = list[i].getBoundingClientRect();
          if (r.width < 2 || r.height < 2) continue;
          out.push({ x: r.left + sx, y: r.top + sy, w: r.width, h: r.height });
        }
      }
      return out;
    };
    const o = this.host.getOverrides();
    this.markCache = {
      t: now,
      solid: collect(o.solid),
      ignore: collect(o.ignore),
      pixel: collect(o.pixel),
    };
  }

  private maskTint(mask: PixelMask): HTMLCanvasElement {
    let c = this.maskTints.get(mask);
    if (!c) {
      c = document.createElement("canvas");
      c.width = mask.w;
      c.height = mask.h;
      const x = c.getContext("2d")!;
      const img = x.createImageData(mask.w, mask.h);
      for (let y = 0; y < mask.h; y++) {
        const row = y * mask.rowWords;
        for (let px = 0; px < mask.w; px++) {
          if (mask.bits[row + (px >> 5)] & (1 << (px & 31))) {
            const i = (y * mask.w + px) * 4;
            img.data[i] = 34;
            img.data[i + 1] = 197;
            img.data[i + 2] = 94;
            img.data[i + 3] = 120;
          }
        }
      }
      x.putImageData(img, 0, 0);
      this.maskTints.set(mask, c);
    }
    return c;
  }

  /** Called by the engine each frame, after everything else has drawn. */
  draw(ctx: CanvasRenderingContext2D): void {
    const sx = window.scrollX;
    const sy = window.scrollY;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    for (const r of this.host.world.rects) {
      const x = r.x - sx;
      const y = r.y - sy;
      if (x > vw || y > vh || x + r.w < 0 || y + r.h < 0) continue;
      if (r.mask) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, r.w, r.h);
        ctx.clip();
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(this.maskTint(r.mask), x - (r.maskDX ?? 0), y - (r.maskDY ?? 0));
        ctx.restore();
      } else {
        ctx.fillStyle = `rgba(${COLOR_SOLID}, 0.22)`;
        ctx.fillRect(x, y, r.w, r.h);
      }
      // Masked surfaces get a faint dashed bound: the tinted pixels are the
      // real collision shape, the box is only where the element sits.
      ctx.lineWidth = 1;
      if (r.mask) {
        ctx.strokeStyle = `rgba(${COLOR_SOLID}, 0.35)`;
        ctx.setLineDash([3, 4]);
        ctx.strokeRect(x + 0.5, y + 0.5, r.w - 1, r.h - 1);
        ctx.setLineDash([]);
      } else {
        ctx.strokeStyle = `rgba(${COLOR_SOLID}, 0.8)`;
        ctx.strokeRect(x + 0.5, y + 0.5, r.w - 1, r.h - 1);
      }
    }

    // the glass floor line
    const w = this.host.world;
    if (w.glassActive()) {
      const gy = w.glassY - sy;
      ctx.strokeStyle = `rgba(${COLOR_SOLID}, 0.5)`;
      ctx.setLineDash([8, 6]);
      ctx.beginPath();
      ctx.moveTo(0, gy - 0.5);
      ctx.lineTo(vw, gy - 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    this.collectMarks();
    const outline = (boxes: Box[], color: string) => {
      ctx.strokeStyle = `rgba(${color}, 0.9)`;
      ctx.fillStyle = `rgba(${color}, 0.12)`;
      ctx.setLineDash([5, 4]);
      for (const b of boxes) {
        const x = b.x - sx;
        const y = b.y - sy;
        if (x > vw || y > vh || x + b.w < 0 || y + b.h < 0) continue;
        ctx.fillRect(x, y, b.w, b.h);
        ctx.strokeRect(x + 0.5, y + 0.5, b.w - 1, b.h - 1);
      }
      ctx.setLineDash([]);
    };
    outline(this.markCache.solid, COLOR_FORCED);
    outline(this.markCache.ignore, COLOR_IGNORED);
    outline(this.markCache.pixel, COLOR_PIXEL);

    // hover: what a click would toggle, and what it currently is
    const hov = this.hovered;
    if (hov && hov.isConnected) {
      // With shift held the pick is the exact element under the cursor.
      const target = this.shiftHeld ? hov : (this.host.surfaceContaining(hov) ?? hov);
      const r = target.getBoundingClientRect();
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(r.left + 0.5, r.top + 0.5, r.width - 1, r.height - 1);
      ctx.setLineDash([]);
      const sel = selectorFor(target);
      const o = this.host.getOverrides();
      let state: string;
      if (o.pixel.includes(sel)) {
        state = "pixel-perfect (forced)";
      } else if (o.solid.includes(sel)) {
        state = "forced solid";
      } else if (o.ignore.includes(sel)) {
        state = "ignored";
      } else {
        const surf = this.host.surfaceContaining(target);
        if (surf === target) {
          // Images/canvases/SVGs are pixel-shaped out of the box — say so.
          state = this.host.surfaceMasked(target) ? "auto: pixel-shaped" : "auto: solid";
        } else if (surf) {
          state = "inside a solid surface";
        } else {
          state = "auto: not solid";
        }
      }
      const label = `${sel} — ${state}`;
      ctx.font = "11px ui-monospace, SFMono-Regular, monospace";
      const tw = ctx.measureText(label).width;
      const lx = Math.max(2, Math.min(r.left, vw - tw - 12));
      const ly = Math.max(16, r.top - 6);
      ctx.fillStyle = "rgba(10, 16, 28, 0.88)";
      ctx.fillRect(lx - 4, ly - 12, tw + 8, 17);
      ctx.fillStyle = "#e6edf5";
      ctx.fillText(label, lx, ly);
    }
  }

  stop(): void {
    for (const off of this.listeners) off();
    this.listeners = [];
  }
}
