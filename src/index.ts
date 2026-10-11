// Public API. Also supports zero-code embedding:
//   <script src="webpenguins.js" data-auto data-penguins="10" data-trees="3"></script>
import { Flock } from "./flock";
import { WebPenguinsOptions } from "./types";

export type { WebPenguinsOptions };
export const version = "0.1.0";

export interface WebPenguinsHandle {
  /** Play the exit sequence (bombs!) and remove the overlay. */
  stop(opts?: { explode?: boolean }): Promise<void>;
  /** Remove everything immediately. */
  destroy(): void;
  /**
   * Live-update any option. Penguin count, blood, angels, zapping,
   * overrides and devMode apply in place; theme, snow, Santa, trees, moon
   * and scale rebuild the world (the penguins parachute in again).
   */
  set(opts: Partial<WebPenguinsOptions>): void;
  setPenguins(n: number): void;
}

let current: Flock | null = null;

// The script tag that loaded this bundle, as authored ("/js/webpenguins.js"):
// the dev panel's export snippet points at the same file. Unknown for ES
// module imports and extension content scripts.
const loaderSrc =
  (typeof document !== "undefined" &&
    (document.currentScript as HTMLScriptElement | null)?.getAttribute("src")) ||
  "webpenguins.js";

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
    // A developer adding data-dev deserves to know why nothing appeared.
    if (opts.devMode) {
      console.info("webpenguins: prefers-reduced-motion is on, so nothing runs (respectReducedMotion: false overrides it)");
    }
    return NOOP_HANDLE;
  }
  current?.destroy();
  const flock = new Flock(opts, loaderSrc);
  current = flock;
  return {
    stop: (o) => flock.stop(o),
    destroy: () => flock.destroy(),
    set: (o) => flock.set(o),
    setPenguins: (n) => flock.set({ penguins: n }),
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
