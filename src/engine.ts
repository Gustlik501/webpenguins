// Wires everything together: fixed-timestep toon ticks (the original 60ms
// cadence — that retro shuffle is part of the look), per-frame snow physics,
// and one full redraw per animation frame.
import { PenguinManager, ZapPoint } from "./penguins";
import { Renderer } from "./render";
import { SnowSystem } from "./snow";
import { buildGenera, loadAllImages, THEME_DELAY } from "./sprites";
import { Surfaces } from "./surfaces";
import { WebPenguinsOptions } from "./types";
import { World } from "./world";

const MAX_CATCHUP_TICKS = 3;

function resolveScale(scale: number | "auto" | undefined): number {
  // Default 1: the original sprite sizes.
  if (typeof scale === "number" && scale > 0) return Math.min(4, scale);
  return 1;
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
  // debug instrumentation (exposed via the `debug` option)
  loopCount = 0;
  tickCount = 0;
  lastError: string | null = null;
  private onExitDone: (() => void) | undefined;
  private cleanups: Array<() => void> = [];

  constructor(private opts: WebPenguinsOptions) {
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    await loadAllImages();
    if (this.destroyed) return;
    const opts = this.opts;
    const scale = resolveScale(opts.scale);

    const renderer = new Renderer(opts.zIndex ?? 2147483641);
    this.renderer = renderer;
    this.world.width = docWidth();
    this.world.height = docHeight();
    this.world.viewTop = window.scrollY;

    const genera = buildGenera(scale);
    const manager = new PenguinManager(this.world, genera, scale);
    this.manager = manager;
    manager.blood = opts.blood ?? true;
    manager.angels = opts.angels ?? true;
    manager.setNumber(opts.penguins ?? manager.defaultNumber());

    this.surfaces.start();
    this.world.setRects(this.surfaces.getRects());

    if (opts.snow !== false && opts.snow !== 0) {
      this.snow = new SnowSystem(
        {
          flakes: typeof opts.snow === "number" ? opts.snow : 120,
          santa: opts.santa === false ? false : opts.santa === true ? "medium" : (opts.santa ?? "medium"),
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
        if (!this.terminating) {
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
      };
    }
    this.rafId = requestAnimationFrame(this.loop);
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
      while (this.acc >= THEME_DELAY && ticks < MAX_CATCHUP_TICKS) {
        this.acc -= THEME_DELAY;
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
      if (vx + anim.width > 0 && vx < renderer.width && vy + anim.height > 0 && vy < renderer.height) {
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
    this.surfaces.stop();
    for (const c of this.cleanups) c();
    this.cleanups = [];
    this.renderer?.destroy();
    const done = this.onExitDone;
    this.onExitDone = undefined;
    done?.();
  }
}
