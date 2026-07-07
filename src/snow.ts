// The xsnow part: falling flakes (the 7 original pixmaps), gusty wind, snow
// settling on top of "windows" (here: DOM surfaces) and along the screen
// bottom, and Santa drifting by at the original xsnow speeds.
import { randInt } from "./rng";
import { getImage, SNOW_ASSETS } from "./sprites";
import { World } from "./world";

export interface SnowOptions {
  flakes: number;
  santa: false | "regular" | "medium" | "big";
  rudolf: boolean;
  trees: number;
  moon: boolean;
  scale: number;
  snowColor: string | "auto";
}

interface Flake {
  x: number;
  y: number;
  vy: number; // px/s
  windFactor: number;
  wobblePhase: number;
  wobbleSpeed: number;
  type: number;
}

interface FallenSnow {
  w: number;
  heights: Float32Array;
}

const MAX_DEPTH_SURFACE = 14;
const MAX_DEPTH_BOTTOM = 38;

/** Approximate page background luminance (0 dark .. 1 light). */
function pageLuminance(): number {
  for (const el of [document.body, document.documentElement]) {
    if (!el) continue;
    const bg = getComputedStyle(el).backgroundColor;
    const m = /rgba?\(([^)]+)\)/.exec(bg || "");
    if (!m) continue;
    const parts = m[1].split(",").map(parseFloat);
    const alpha = parts.length === 4 ? parts[3] : 1;
    if (alpha < 0.5) continue;
    return (0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2]) / 255;
  }
  return 1; // default browser background: white
}

/** Repaint a mask-style sprite in a flat color, preserving alpha. */
function tintSprite(img: HTMLImageElement, color: string): CanvasImageSource {
  const c = document.createElement("canvas");
  c.width = img.naturalWidth || img.width;
  c.height = img.naturalHeight || img.height;
  const x = c.getContext("2d")!;
  x.drawImage(img, 0, 0);
  x.globalCompositeOperation = "source-in";
  x.fillStyle = color;
  x.fillRect(0, 0, c.width, c.height);
  return c;
}

export class SnowSystem {
  private flakes: Flake[] = [];
  private flakeImages: CanvasImageSource[];
  private flakeSizes: { w: number; h: number }[];
  private snowColor: string;
  private fallen = new Map<number, FallenSnow>();
  private bottom: FallenSnow = { w: 0, heights: new Float32Array(0) };
  // wind state machine, xsnow-style: mostly calm, occasionally a gust
  private windVx = 0;
  private windTarget = 0;
  private windTimer = 3;
  // Santa
  private santaFrames: { img: HTMLImageElement; w: number; h: number }[] = [];
  private santaSpeed = 0;
  private santaX = 0;
  private santaBaseY = 0;
  private santaWait = 0;
  private santaAnim = 0;
  private treeImg: HTMLImageElement;
  private treeW: number;
  private treeH: number;
  private treeXs: number[] = [];
  private moonImg: HTMLImageElement;
  private time = 0;

  constructor(
    private opts: SnowOptions,
    private world: World
  ) {
    this.snowColor =
      opts.snowColor !== "auto" && opts.snowColor
        ? opts.snowColor
        : pageLuminance() > 0.7
          ? "#b9c8da" // light pages: soft slate so snow stays visible
          : "#fffafa"; // the classic X11 "snow"
    this.flakeImages = SNOW_ASSETS.flakes.map((f) =>
      this.snowColor === "#fffafa" ? getImage(f.image) : tintSprite(getImage(f.image), this.snowColor)
    );
    this.flakeSizes = SNOW_ASSETS.flakes.map((f) => ({ w: f.width, h: f.height }));
    this.treeImg = getImage(SNOW_ASSETS.tree.image);
    this.treeW = SNOW_ASSETS.tree.width;
    this.treeH = SNOW_ASSETS.tree.height;
    this.moonImg = getImage(SNOW_ASSETS.moon.image);

    if (opts.santa) {
      const santa = SNOW_ASSETS.santas.find((s) => s.name === opts.santa) ?? SNOW_ASSETS.santas[1];
      const frames = opts.rudolf ? santa.rudolf : santa.frames;
      this.santaFrames = frames.map((f) => ({ img: getImage(f.image), w: f.width, h: f.height }));
      this.santaSpeed = santa.speed * opts.scale;
      this.resetSanta(true);
    }

    for (let i = 0; i < opts.flakes; i++) {
      this.flakes.push(this.newFlake(true));
    }
    this.resize();
  }

  resize(): void {
    // xsnow also drops the fallen snow when the screen changes.
    this.bottom = { w: this.world.width, heights: new Float32Array(this.world.width) };
    this.fallen.clear();
    const s = this.opts.scale;
    this.treeXs = [];
    for (let i = 0; i < this.opts.trees; i++) {
      // low-discrepancy positions: stable, evenly spread, no clumping
      const frac = (i * 0.618034 + 0.21) % 1;
      this.treeXs.push(Math.round(frac * Math.max(1, this.world.width - this.treeW * s)));
    }
  }

  private newFlake(anywhere: boolean): Flake {
    const type = randInt(this.flakeImages.length);
    const size = this.flakeSizes[type];
    const bigness = size.w / 15; // largest original flake is ~15px
    return {
      x: Math.random() * this.world.width,
      y: anywhere ? Math.random() * this.world.height : -10 - Math.random() * 30,
      vy: (36 + Math.random() * 65) * (0.6 + 0.5 * bigness) * this.opts.scale,
      windFactor: 0.35 + Math.random() * 0.65,
      wobblePhase: Math.random() * Math.PI * 2,
      wobbleSpeed: 0.8 + Math.random() * 1.6,
      type,
    };
  }

  private resetSanta(initial: boolean): void {
    const f = this.santaFrames[0];
    this.santaX = -f.w * this.opts.scale - (initial ? Math.random() * this.world.width : 0);
    this.santaBaseY = 16 + Math.random() * Math.max(40, this.world.height * 0.25);
    this.santaWait = initial ? 0 : 4 + Math.random() * 18;
  }

  private updateWind(dt: number): void {
    this.windTimer -= dt;
    if (this.windTimer <= 0) {
      if (Math.random() < 0.3) {
        // gust
        this.windTarget = (Math.random() < 0.5 ? -1 : 1) * (90 + Math.random() * 190);
        this.windTimer = 2 + Math.random() * 4;
      } else {
        this.windTarget = (Math.random() - 0.5) * 50;
        this.windTimer = 4 + Math.random() * 10;
      }
    }
    this.windVx += (this.windTarget - this.windVx) * Math.min(1, dt * 1.2);
  }

  private deposit(fallen: FallenSnow, col: number, amount: number, max: number): void {
    const w = fallen.w;
    const c = Math.max(0, Math.min(w - 1, Math.round(col)));
    const h = fallen.heights;
    if (h[c] >= max) return;
    h[c] += amount;
    // let steep piles slump sideways so mounds look natural
    for (let k = 0; k < 3; k++) {
      const l = c - 1 >= 0 ? h[c - 1] : h[c];
      const r = c + 1 < w ? h[c + 1] : h[c];
      if (h[c] > l + 2 && l <= r) {
        h[c] -= 0.5;
        if (c - 1 >= 0) h[c - 1] += 0.5;
      } else if (h[c] > r + 2) {
        h[c] -= 0.5;
        if (c + 1 < w) h[c + 1] += 0.5;
      } else {
        break;
      }
    }
  }

  update(dt: number): void {
    this.time += dt;
    const s = this.opts.scale;
    const world = this.world;
    this.updateWind(dt);

    // prune snow from surfaces that no longer exist / changed size
    const alive = new Map<number, number>();
    for (const r of world.rects) alive.set(r.id, r.w);
    for (const [id, snow] of this.fallen) {
      const w = alive.get(id);
      if (w === undefined || Math.abs(w - snow.w) > 4) this.fallen.delete(id);
    }

    for (let i = 0; i < this.flakes.length; i++) {
      const f = this.flakes[i];
      const size = this.flakeSizes[f.type];
      const fh = size.h * s;
      const fw = size.w * s;
      f.wobblePhase += f.wobbleSpeed * dt;
      const vx = this.windVx * f.windFactor + Math.sin(f.wobblePhase) * 14;
      const prevBottom = f.y + fh;
      f.x += vx * dt;
      f.y += f.vy * dt;
      const newBottom = f.y + fh;

      if (f.x < -20) f.x += world.width + 40;
      else if (f.x > world.width + 20) f.x -= world.width + 40;

      let landed = false;
      const cx = f.x + fw / 2;

      // land on a surface top?
      for (const r of world.rects) {
        if (cx < r.x || cx >= r.x + r.w) continue;
        let snow = this.fallen.get(r.id);
        const col = cx - r.x;
        const depth = snow ? snow.heights[Math.max(0, Math.min(snow.w - 1, Math.round(col)))] : 0;
        const surfaceY = r.y - depth;
        if (surfaceY < 6) break; // top edge off screen — snow can't settle
        if (prevBottom <= surfaceY && newBottom >= surfaceY) {
          if (!snow) {
            snow = { w: Math.round(r.w), heights: new Float32Array(Math.round(r.w)) };
            this.fallen.set(r.id, snow);
          }
          this.deposit(snow, col, 0.9 * s, MAX_DEPTH_SURFACE * s);
          landed = true;
        }
        break; // only the first surface under this flake matters
      }

      // land on the screen bottom?
      if (!landed && this.bottom.w > 0) {
        const col = Math.max(0, Math.min(this.bottom.w - 1, Math.round(cx)));
        const surfaceY = world.height - this.bottom.heights[col];
        if (newBottom >= surfaceY) {
          this.deposit(this.bottom, col, 0.9 * s, MAX_DEPTH_BOTTOM * s);
          landed = true;
        }
      }

      if (landed || f.y > world.height) {
        this.flakes[i] = this.newFlake(false);
      }
    }

    // Santa
    if (this.santaFrames.length) {
      if (this.santaWait > 0) {
        this.santaWait -= dt;
      } else {
        this.santaX += this.santaSpeed * dt;
        this.santaAnim += dt;
        if (this.santaX > world.width + 20) this.resetSanta(false);
      }
    }
  }

  /** Everything that should render behind the penguins. */
  drawUnder(ctx: CanvasRenderingContext2D): void {
    const s = this.opts.scale;
    const world = this.world;
    ctx.imageSmoothingEnabled = false;

    if (this.opts.moon) {
      const mw = SNOW_ASSETS.moon.width * s;
      const mh = SNOW_ASSETS.moon.height * s;
      ctx.drawImage(this.moonImg, world.width - mw - 28, 22, mw, mh);
    }

    if (this.santaFrames.length && this.santaWait <= 0) {
      const frame = this.santaFrames[Math.floor(this.santaAnim / 0.25) % this.santaFrames.length];
      const y = this.santaBaseY + Math.sin(this.santaX / 90) * 6 * s;
      ctx.drawImage(frame.img, Math.round(this.santaX), Math.round(y), frame.w * s, frame.h * s);
    }

    for (const x of this.treeXs) {
      ctx.drawImage(
        this.treeImg,
        x,
        world.height - this.treeH * s + 1,
        this.treeW * s,
        this.treeH * s
      );
    }

    ctx.fillStyle = this.snowColor;

    // snow on surfaces
    for (const r of world.rects) {
      const snow = this.fallen.get(r.id);
      if (!snow) continue;
      ctx.beginPath();
      ctx.moveTo(r.x, r.y);
      const n = snow.w;
      for (let c = 0; c < n; c += 2) {
        ctx.lineTo(r.x + c, r.y - snow.heights[c]);
      }
      ctx.lineTo(r.x + n, r.y - snow.heights[n - 1]);
      ctx.lineTo(r.x + n, r.y);
      ctx.closePath();
      ctx.fill();
    }

    // snow along the bottom of the screen
    if (this.bottom.w > 0) {
      const h = this.bottom.heights;
      ctx.beginPath();
      ctx.moveTo(0, world.height);
      for (let c = 0; c < this.bottom.w; c += 2) {
        ctx.lineTo(c, world.height - h[c]);
      }
      ctx.lineTo(this.bottom.w, world.height - h[this.bottom.w - 1]);
      ctx.lineTo(this.bottom.w, world.height);
      ctx.closePath();
      ctx.fill();
    }
  }

  /** Falling flakes render in front of everything. */
  drawOver(ctx: CanvasRenderingContext2D): void {
    const s = this.opts.scale;
    ctx.imageSmoothingEnabled = false;
    for (const f of this.flakes) {
      const size = this.flakeSizes[f.type];
      ctx.drawImage(
        this.flakeImages[f.type],
        Math.round(f.x),
        Math.round(f.y),
        size.w * s,
        size.h * s
      );
    }
  }
}
