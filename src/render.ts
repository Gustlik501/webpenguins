// Full-viewport overlay canvas. pointer-events: none, so the page stays
// fully interactive; we draw crisp scaled pixels (imageSmoothing off).
import { AnimData } from "./types";

export class Renderer {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  width = 0;
  height = 0;
  private dpr = 1;

  constructor(zIndex: number) {
    this.canvas = document.createElement("canvas");
    const s = this.canvas.style;
    s.position = "fixed";
    s.left = "0";
    s.top = "0";
    s.pointerEvents = "none";
    s.zIndex = String(zIndex);
    s.margin = "0";
    this.canvas.setAttribute("aria-hidden", "true");
    this.canvas.setAttribute("data-webpenguins", "ignore");
    // Attach to <html>, not <body>, so page MutationObservers on body (ours
    // included) don't see it and page CSS is less likely to hit it.
    document.documentElement.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d")!;
    this.resize();
  }

  resize(): void {
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.canvas.style.width = this.width + "px";
    this.canvas.style.height = this.height + "px";
  }

  begin(): void {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.imageSmoothingEnabled = false;
  }

  /** (x, y) is the toon's collision box origin; the cell draws around it. */
  drawSprite(anim: AnimData, frame: number, direction: number, x: number, y: number): void {
    const dir = Math.min(direction, anim.directions - 1);
    this.ctx.drawImage(
      anim.image,
      frame * anim.srcWidth,
      dir * anim.srcHeight,
      anim.srcWidth,
      anim.srcHeight,
      Math.round(x - anim.drawDX),
      Math.round(y - anim.drawDY),
      anim.drawW,
      anim.drawH
    );
  }

  destroy(): void {
    this.canvas.remove();
  }
}
