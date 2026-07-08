// Developer mode: a translucent overlay showing exactly what the engine
// considers collidable (down to the pixel-mask shapes), click-to-override
// (auto -> forced solid -> ignored, stored as CSS selectors so a class can
// be overridden site-wide), and a one-line export snippet for embedding
// webpenguins with the current settings.
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
  getOverrides(): Overrides;
  /** Apply + persist new overrides (triggers a rescan). */
  setOverrides(o: Overrides): void;
  /** The copy-paste embed line for the current configuration. */
  buildSnippet(): string;
  /** The user pressed Esc or the panel's exit button. */
  exit(): void;
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
  private panel: HTMLDivElement;
  private snippetInput: HTMLInputElement;
  private stats: HTMLDivElement;
  private hovered: Element | null = null;
  private markCache: { t: number; solid: Box[]; ignore: Box[]; pixel: Box[] } = {
    t: 0,
    solid: [],
    ignore: [],
    pixel: [],
  };
  private maskTints = new WeakMap<PixelMask, HTMLCanvasElement>();
  private listeners: Array<() => void> = [];

  constructor(private host: DevHost) {
    this.panel = document.createElement("div");
    this.panel.setAttribute("data-webpenguins", "ignore");
    this.panel.setAttribute("data-webpenguins-devpanel", "");
    const s = this.panel.style;
    s.cssText =
      "position:fixed;top:12px;right:12px;z-index:2147483646;width:340px;" +
      "background:rgba(16,24,38,.94);color:#e6edf5;border:1px solid rgba(148,163,184,.4);" +
      "border-radius:10px;padding:12px 14px;font:12px/1.5 system-ui,sans-serif;" +
      "box-shadow:0 8px 28px rgba(0,0,0,.45)";
    this.panel.innerHTML =
      '<div style="font-weight:600;font-size:13px;margin-bottom:2px">🐧 webpenguins developer mode</div>' +
      '<div data-wp-stats style="opacity:.8"></div>' +
      '<div style="opacity:.8;margin:4px 0 8px">Click an element to cycle ' +
      '<span style="color:rgb(52,211,153)">auto</span> → ' +
      '<span style="color:rgb(56,189,248)">solid</span> / ' +
      '<span style="color:rgb(248,113,113)">ignored</span>. ' +
      'Shift+click: <span style="color:rgb(192,132,252)">pixel-perfect</span>. Esc exits.</div>' +
      '<div style="display:flex;gap:6px;margin-bottom:8px">' +
      '<input data-wp-snippet readonly style="flex:1;min-width:0;background:#0b1220;color:#9fc0e8;' +
      'border:1px solid #2b3b52;border-radius:6px;padding:4px 6px;font:11px ui-monospace,monospace">' +
      '<button data-wp-copy style="background:#2563eb;color:#fff;border:0;border-radius:6px;padding:4px 10px;cursor:pointer">Copy</button>' +
      "</div>" +
      '<div style="display:flex;gap:6px">' +
      '<button data-wp-clear style="flex:1;background:#334155;color:#e6edf5;border:0;border-radius:6px;padding:5px 0;cursor:pointer">Clear overrides</button>' +
      '<button data-wp-exit style="flex:1;background:#7f1d1d;color:#fee;border:0;border-radius:6px;padding:5px 0;cursor:pointer">Exit dev mode</button>' +
      "</div>";
    document.documentElement.appendChild(this.panel);
    this.snippetInput = this.panel.querySelector("[data-wp-snippet]")!;
    this.stats = this.panel.querySelector("[data-wp-stats]")!;

    const copyBtn = this.panel.querySelector<HTMLButtonElement>("[data-wp-copy]")!;
    copyBtn.addEventListener("click", () => {
      this.snippetInput.select();
      const done = () => {
        copyBtn.textContent = "Copied!";
        setTimeout(() => (copyBtn.textContent = "Copy"), 1200);
      };
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(this.snippetInput.value).then(done, done);
      } else {
        document.execCommand("copy");
        done();
      }
    });
    this.panel.querySelector("[data-wp-clear]")!.addEventListener("click", () => {
      this.host.setOverrides({ solid: [], ignore: [], pixel: [] });
      this.refresh();
    });
    this.panel.querySelector("[data-wp-exit]")!.addEventListener("click", () => this.host.exit());

    const onMove = (e: MouseEvent) => {
      const t = e.target as Element | null;
      this.hovered =
        !t ||
        this.panel.contains(t) ||
        t === document.documentElement ||
        t === document.body ||
        (t instanceof Element && t.getAttribute("data-webpenguins") === "ignore")
          ? null
          : t;
    };
    // Capture-phase click: pick the element instead of activating it.
    const onClick = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (!t || this.panel.contains(t)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (t === document.documentElement || t === document.body) return;
      const target = this.host.surfaceContaining(t) ?? t;
      if (e.shiftKey) this.togglePixel(target);
      else this.cycle(target);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") this.host.exit();
    };
    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("click", onClick, true);
    window.addEventListener("keydown", onKey, true);
    this.listeners.push(
      () => window.removeEventListener("mousemove", onMove, true),
      () => window.removeEventListener("click", onClick, true),
      () => window.removeEventListener("keydown", onKey, true)
    );
    this.refresh();
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
    this.refresh();
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
    this.refresh();
  }

  /** Update the panel (counts + snippet); call after overrides change. */
  refresh(): void {
    const o = this.host.getOverrides();
    this.stats.textContent =
      `${this.host.world.rects.length} collidable surfaces · ` +
      `${o.solid.length} forced solid · ${o.ignore.length} ignored · ${o.pixel.length} pixel`;
    this.snippetInput.value = this.host.buildSnippet();
    this.markCache.t = 0; // recollect override boxes
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
      ctx.strokeStyle = `rgba(${COLOR_SOLID}, 0.8)`;
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, r.w - 1, r.h - 1);
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
      const target = this.host.surfaceContaining(hov) ?? hov;
      const r = target.getBoundingClientRect();
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(r.left + 0.5, r.top + 0.5, r.width - 1, r.height - 1);
      ctx.setLineDash([]);
      const sel = selectorFor(target);
      const o = this.host.getOverrides();
      const state = o.pixel.includes(sel)
        ? "pixel-perfect"
        : o.solid.includes(sel)
          ? "forced solid"
          : o.ignore.includes(sel)
            ? "ignored"
            : this.host.surfaceContaining(hov)
              ? "auto: solid"
              : "auto: not solid";
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
    this.panel.remove();
  }
}
