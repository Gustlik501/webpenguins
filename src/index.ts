// Public API. Also supports zero-code embedding:
//   <script src="webpenguins.js" data-auto data-penguins="10" data-trees="3"></script>
import { Engine } from "./engine";
import { WebPenguinsOptions } from "./types";

export type { WebPenguinsOptions };
export const version = "0.1.0";

export interface WebPenguinsHandle {
  /** Play the exit sequence (bombs!) and remove the overlay. */
  stop(opts?: { explode?: boolean }): Promise<void>;
  /** Remove everything immediately. */
  destroy(): void;
  /** Live-update options (penguin count, blood, angels). */
  set(opts: Partial<WebPenguinsOptions>): void;
  setPenguins(n: number): void;
}

let current: Engine | null = null;

const NOOP_HANDLE: WebPenguinsHandle = {
  stop: async () => undefined,
  destroy: () => undefined,
  set: () => undefined,
  setPenguins: () => undefined,
};

export function start(opts: WebPenguinsOptions = {}): WebPenguinsHandle {
  if (typeof window === "undefined" || typeof document === "undefined") return NOOP_HANDLE;
  if (
    (opts.respectReducedMotion ?? true) &&
    typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    return NOOP_HANDLE;
  }
  current?.destroy();
  const engine = new Engine(opts);
  current = engine;
  return {
    stop: (o) => engine.stop(o),
    destroy: () => engine.destroy(),
    set: (o) => engine.set(o),
    setPenguins: (n) => engine.setPenguins(n),
  };
}

/** Stop the currently running instance, if any. */
export function stop(opts?: { explode?: boolean }): Promise<void> {
  return current ? current.stop(opts) : Promise.resolve();
}

// ---- script-tag autostart ---------------------------------------------
function parseDatasetOptions(d: DOMStringMap): WebPenguinsOptions {
  const opts: WebPenguinsOptions = {};
  const bool = (v: string | undefined) => v !== "false" && v !== "0";
  if (d.penguins !== undefined) opts.penguins = Number(d.penguins);
  if (d.theme !== undefined) {
    const themes = d.theme.split(",").map((t) => t.trim()).filter(Boolean);
    if (themes.length) opts.theme = themes.length === 1 ? themes[0] : themes;
  }
  if (d.snow !== undefined) {
    opts.snow = d.snow === "" || d.snow === "true" ? true : d.snow === "false" ? false : Number(d.snow);
  }
  if (d.santa !== undefined) {
    opts.santa =
      d.santa === "false" ? false : d.santa === "" || d.santa === "true" ? true : (d.santa as "regular" | "medium" | "big");
  }
  if (d.rudolf !== undefined) opts.rudolf = bool(d.rudolf);
  if (d.trees !== undefined) opts.trees = Number(d.trees);
  if (d.moon !== undefined) opts.moon = bool(d.moon);
  if (d.blood !== undefined) opts.blood = bool(d.blood);
  if (d.angels !== undefined) opts.angels = bool(d.angels);
  if (d.zap !== undefined) opts.zapOnClick = bool(d.zap);
  if (d.scale !== undefined) opts.scale = d.scale === "auto" ? "auto" : Number(d.scale);
  if (d.solid !== undefined) opts.solid = d.solid;
  if (d.ignore !== undefined) opts.ignore = d.ignore;
  if (d.pixel !== undefined) opts.pixel = d.pixel;
  if (d.dev !== undefined) opts.devMode = bool(d.dev);
  return opts;
}

if (typeof document !== "undefined") {
  const script = document.currentScript as HTMLScriptElement | null;
  if (script && script.dataset.auto !== undefined) {
    const opts = parseDatasetOptions(script.dataset);
    const go = () => start(opts);
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", go, { once: true });
    } else {
      go();
    }
  }
}
