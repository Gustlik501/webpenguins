// Wires everything together: fixed-timestep toon ticks (the original 60ms
// cadence — that retro shuffle is part of the look), per-frame snow physics,
// and one full redraw per animation frame.
import { DevMode, Overrides } from "./devmode";
import { PenguinManager, ZapPoint } from "./penguins";
import { Renderer } from "./render";
import { SnowSystem } from "./snow";
import { buildGenera, loadImages, resolveThemes, themeDelay } from "./sprites";
import { Surfaces } from "./surfaces";
import { WebPenguinsOptions } from "./types";
import { World } from "./world";

const MAX_CATCHUP_TICKS = 3;
const DEFAULT_PENGUINS = 25;

function resolveScale(scale: number | "auto" | undefined): number {
  // Default 1: the original sprite sizes.
  if (typeof scale === "number" && scale > 0) return Math.min(4, scale);
  return 1;
}

/** Selector lists arrive as arrays or ";"-separated strings (data attrs). */
function parseList(v: string | string[] | undefined): string[] {
  if (!v) return [];
  return (Array.isArray(v) ? v : v.split(";")).map((s) => s.trim()).filter(Boolean);
}

function docWidth(): number {
  return document.documentElement.clientWidth;
}

function docHeight(): number {
  return Math.max(
    document.documentElement.scrollHeight,
    document.body ? document.body.scrollHeight : 0,
    document.documentElement.clientHeight
  );
}

export class Engine {
  readonly ready: Promise<void>;
  private world = new World();
  private surfaces = new Surfaces();
  private renderer: Renderer | undefined;
  private manager: PenguinManager | undefined;
  private snow: SnowSystem | undefined;
  private zaps: ZapPoint[] = [];
  private rafId = 0;
  private lastTime = 0;
  private acc = 0;
  private destroyed = false;
  private terminating = false;
  private scale = 1;
  private delay = 60; // ms per tick, set by the theme (Bill runs at 150)
  private dev: DevMode | undefined;
  private overrides: Overrides = { solid: [], ignore: [] };
  // debug instrumentation (exposed via the `debug` option)
  loopCount = 0;
  tickCount = 0;
  lastError: string | null = null;
  private onExitDone: (() => void) | undefined;
  private cleanups: Array<() => void> = [];

  constructor(private opts: WebPenguinsOptions) {
    this.ready = this.init().catch((err) => {
      // Surface init failures in the debug counters instead of a silent
      // unhandled rejection (stop()/set() await `ready` and must not throw).
      this.lastError = String(err && (err as Error).stack ? (err as Error).stack : err);
    });
  }

  private async init(): Promise<void> {
    const themes = resolveThemes(this.opts.theme);
    this.delay = themeDelay(themes);
    await loadImages(themes);
    if (this.destroyed) return;
    const opts = this.opts;
    const scale = resolveScale(opts.scale);
    this.scale = scale;

    const renderer = new Renderer(opts.zIndex ?? 2147483641);
    this.renderer = renderer;
    this.world.width = docWidth();
    this.world.height = docHeight();
    this.world.viewTop = window.scrollY;

    // Surfaces must exist before anyone spawns — the spawn-safety check
    // needs a populated world or penguins materialise inside cards.
    this.overrides = { solid: parseList(opts.solid), ignore: parseList(opts.ignore) };
    this.surfaces.setOverrides(this.overrides.solid, this.overrides.ignore);
    this.surfaces.start();
    this.world.setRects(this.surfaces.getRects());

    const genera = buildGenera(themes, scale);
    const manager = new PenguinManager(this.world, genera, scale);
    this.manager = manager;
    manager.blood = opts.blood ?? true;
    manager.angels = opts.angels ?? true;
    manager.setNumber(opts.penguins ?? DEFAULT_PENGUINS);

    if (opts.snow !== false && opts.snow !== 0) {
      this.snow = new SnowSystem(
        {
          flakes: typeof opts.snow === "number" ? opts.snow : 120,
          santa: opts.santa === false ? false : opts.santa === true ? "big" : (opts.santa ?? "big"),
          rudolf: opts.rudolf ?? true,
          trees: opts.trees ?? 0,
          moon: opts.moon ?? false,
          scale,
          snowColor: opts.snowColor ?? "auto",
        },
        this.world
      );
    }

    const onResize = () => {
      renderer.resize();
      this.world.width = docWidth();
      this.world.height = docHeight();
      this.snow?.resize();
    };
    window.addEventListener("resize", onResize);
    this.cleanups.push(() => window.removeEventListener("resize", onResize));

    if (opts.zapOnClick ?? true) {
      const onPointerDown = (e: PointerEvent) => {
        // In dev mode clicks pick elements; nobody gets zapped.
        if (!this.terminating && !this.dev) {
          this.zaps.push({ x: e.clientX + window.scrollX, y: e.clientY + window.scrollY });
        }
      };
      window.addEventListener("pointerdown", onPointerDown, true);
      this.cleanups.push(() => window.removeEventListener("pointerdown", onPointerDown, true));
    }

    const onVisibility = () => {
      this.lastTime = performance.now();
      this.acc = 0;
    };
    document.addEventListener("visibilitychange", onVisibility);
    this.cleanups.push(() => document.removeEventListener("visibilitychange", onVisibility));

    this.lastTime = performance.now();
    if ((opts as { debug?: boolean }).debug) {
      (window as unknown as Record<string, unknown>).__webpenguins = {
        engine: this,
        world: this.world,
        manager,
        surfaces: this.surfaces,
        // why is (or isn't) $0 a platform?
        explain: (el: Element) => this.surfaces.explain(el),
      };
    }
    if (opts.devMode) this.setDevMode(true);
    this.rafId = requestAnimationFrame(this.loop);
  }

  private setDevMode(on: boolean): void {
    if (on && !this.dev && !this.destroyed) {
      this.dev = new DevMode({
        world: this.world,
        surfaceContaining: (el) => this.surfaces.surfaceContaining(el),
        getOverrides: () => ({ solid: [...this.overrides.solid], ignore: [...this.overrides.ignore] }),
        setOverrides: (o) => this.applyOverrides(o, true),
        buildSnippet: () => this.buildSnippet(),
        exit: () => {
          this.setDevMode(false);
          this.opts.onDevModeExit?.();
        },
      });
    } else if (!on && this.dev) {
      this.dev.stop();
      this.dev = undefined;
    }
  }

  private applyOverrides(o: Overrides, persist: boolean): void {
    this.overrides = { solid: o.solid, ignore: o.ignore };
    this.surfaces.setOverrides(o.solid, o.ignore);
    if (persist) {
      this.opts.onOverridesChange?.({ solid: [...o.solid], ignore: [...o.ignore] });
    }
    this.dev?.refresh();
  }

  /** The one-line embed for the current configuration (dev mode export). */
  private buildSnippet(): string {
    const o = this.opts;
    const esc = (s: string) => s.replace(/"/g, "'");
    const attrs = ['src="webpenguins.js"', "data-auto"];
    const n = this.manager && !this.terminating ? this.manager.penguinNumber : o.penguins;
    if (n !== undefined && n !== 25) attrs.push(`data-penguins="${n}"`);
    const themes = resolveThemes(o.theme);
    if (themes.join(",") !== "Penguins") attrs.push(`data-theme="${esc(themes.join(","))}"`);
    if (o.snow === false || typeof o.snow === "number") attrs.push(`data-snow="${o.snow}"`);
    if (o.santa === false) attrs.push('data-santa="false"');
    else if (typeof o.santa === "string" && o.santa !== "big") attrs.push(`data-santa="${o.santa}"`);
    if ((o.trees ?? 0) > 0) attrs.push(`data-trees="${o.trees}"`);
    if (o.moon) attrs.push('data-moon="true"');
    if (o.blood === false) attrs.push('data-blood="false"');
    if (typeof o.scale === "number" && o.scale !== 1) attrs.push(`data-scale="${o.scale}"`);
    if (this.overrides.solid.length) attrs.push(`data-solid="${esc(this.overrides.solid.join("; "))}"`);
    if (this.overrides.ignore.length) attrs.push(`data-ignore="${esc(this.overrides.ignore.join("; "))}"`);
    return `<script ${attrs.join(" ")}></script>`;
  }

  private loop = (): void => {
    if (this.destroyed) return;
    this.loopCount++;
    // performance.now() rather than the rAF timestamp: keeps one time base
    // (rAF timestamps can lag after tab switches and under virtual time).
    const now = performance.now();
    const dt = Math.max(0, Math.min(200, now - this.lastTime));
    this.lastTime = now;
    this.acc += dt;

    let remaining = -1;
    try {
      let ticks = 0;
      while (this.acc >= this.delay && ticks < MAX_CATCHUP_TICKS) {
        this.acc -= this.delay;
        remaining = this.tick();
        this.tickCount++;
        ticks++;
      }
      if (ticks === MAX_CATCHUP_TICKS) this.acc = 0;

      this.snow?.update(dt / 1000);
      this.draw();
    } catch (err) {
      this.lastError = String(err && (err as Error).stack ? (err as Error).stack : err);
    }

    if (this.terminating && remaining === 0) {
      this.finishExit();
      return;
    }
    this.rafId = requestAnimationFrame(this.loop);
  };

  /** One 60ms world tick. Only layout changes count as "windows moving". */
  private tick(): number {
    const manager = this.manager!;
    this.world.viewTop = window.scrollY;
    this.updateGlassFloor();
    if (this.surfaces.movedSinceLastTick()) {
      const w = docWidth();
      const h = docHeight();
      if (w !== this.world.width || h !== this.world.height) {
        this.world.width = w;
        this.world.height = h;
        this.snow?.resize();
      }
      manager.calculateAssociations(this.world.rects);
      this.world.setRects(this.surfaces.getRects());
      manager.relocateAssociated();
    }
    const remaining = manager.frame(this.zaps);
    this.zaps.length = 0;
    return remaining;
  }

  /**
   * Move the glass floor to the viewport's bottom edge and carry whoever is
   * standing on it — the same ride-or-fall feel as the original's moving
   * windows: gentle scrolls are an elevator, flicks drop them.
   */
  private updateGlassFloor(): void {
    const manager = this.manager!;
    const world = this.world;
    const oldGlass = world.glassY;
    const newGlass = Math.min(Math.round(window.scrollY + window.innerHeight), world.height);
    if (newGlass === oldGlass) return;
    const dg = newGlass - oldGlass;
    if (Number.isFinite(dg) && dg !== 0) {
      const maxRide = 48 * this.scale;
      for (let i = 0; i < manager.penguinNumber; i++) {
        const t = manager.toons[i];
        if (!t.active || t.association !== "down") continue;
        const data = t.data();
        if (Math.abs(t.y + data.height - oldGlass) >= 1) continue;
        // Standing on real ground that happens to align? Then it's not ours.
        if (world.intersects(t.x, t.y + data.height, data.width, 1)) continue;
        if (Math.abs(dg) <= maxRide && !t.offsetBlocked(0, dg)) {
          t.move(0, dg);
        }
        // Otherwise leave them: physics turns them into tumblers (scroll
        // down) or lets them live below the glass (scroll up).
      }
    }
    world.glassY = newGlass;
  }

  private draw(): void {
    const renderer = this.renderer!;
    const manager = this.manager!;
    // The camera: document coords minus scroll.
    const sx = window.scrollX;
    const sy = window.scrollY;
    renderer.begin();
    this.snow?.drawUnder(renderer.ctx);
    for (let i = 0; i < manager.penguinNumber; i++) {
      const p = manager.toons[i];
      if (!p.active) {
        p.mapped = false;
        continue;
      }
      const anim = p.data();
      const vx = p.x - sx;
      const vy = p.y - sy;
      // Cull on the drawn cell, which extends beyond the collision box.
      const dx = vx - anim.drawDX;
      const dy = vy - anim.drawDY;
      if (dx + anim.drawW > 0 && dx < renderer.width && dy + anim.drawH > 0 && dy < renderer.height) {
        renderer.drawSprite(anim, p.frame, p.direction, vx, vy);
      }
      // Hit box for zapping, in document coords (like the click points).
      p.mapX = p.x;
      p.mapY = p.y;
      p.mapW = anim.width;
      p.mapH = anim.height;
      p.mapped = true;
    }
    this.snow?.drawOver(renderer.ctx);
    this.dev?.draw(renderer.ctx);
  }

  setPenguins(n: number): void {
    this.ready.then(() => {
      if (!this.destroyed && !this.terminating) this.manager?.setNumber(n);
    });
  }

  set(opts: Partial<WebPenguinsOptions>): void {
    this.ready.then(() => {
      if (this.destroyed || !this.manager) return;
      if (opts.penguins !== undefined) this.manager.setNumber(opts.penguins);
      if (opts.blood !== undefined) this.manager.blood = opts.blood;
      if (opts.angels !== undefined) this.manager.angels = opts.angels;
      if (opts.solid !== undefined || opts.ignore !== undefined) {
        this.applyOverrides(
          {
            solid: opts.solid !== undefined ? parseList(opts.solid) : this.overrides.solid,
            ignore: opts.ignore !== undefined ? parseList(opts.ignore) : this.overrides.ignore,
          },
          false
        );
      }
      if (opts.devMode !== undefined) this.setDevMode(opts.devMode);
    });
  }

  /**
   * Graceful exit: every penguin lights its bomb (the classic Ctrl-C
   * sequence), and the overlay is removed once the last one is gone.
   */
  async stop(opts?: { explode?: boolean }): Promise<void> {
    await this.ready;
    if (this.destroyed) return;
    if (opts?.explode === false) {
      this.destroy();
      return;
    }
    if (!this.terminating) {
      this.terminating = true;
      this.manager?.terminate();
    }
    await new Promise<void>((resolve) => {
      const prev = this.onExitDone;
      this.onExitDone = () => {
        prev?.();
        resolve();
      };
    });
  }

  private finishExit(): void {
    const canvas = this.renderer?.canvas;
    if (canvas) {
      canvas.style.transition = "opacity 0.7s";
      canvas.style.opacity = "0";
    }
    setTimeout(() => {
      this.destroy();
    }, 750);
    // Keep drawing snow while it fades? No — the world has ended.
    cancelAnimationFrame(this.rafId);
    const done = this.onExitDone;
    this.onExitDone = undefined;
    done?.();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    cancelAnimationFrame(this.rafId);
    this.dev?.stop();
    this.dev = undefined;
    this.surfaces.stop();
    for (const c of this.cleanups) c();
    this.cleanups = [];
    this.renderer?.destroy();
    const done = this.onExitDone;
    this.onExitDone = undefined;
    done?.();
  }
}
