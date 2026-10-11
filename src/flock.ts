// The handle behind WebPenguins.start(): owns the options and overrides,
// applies live settings in place and rebuilds the engine for the ones that
// shape the world (theme, snow, trees…), so `set()` takes any option and
// the developer panel survives every restart.
import { Overrides } from "./devmode";
import { Engine, parseList } from "./engine";
import { Panel } from "./panel";
import { resolveThemes } from "./sprites";
import { WebPenguinsOptions } from "./types";

/** Options baked into the world at init: changing one means a rebuild. */
const REBUILD_KEYS = [
  "theme",
  "snow",
  "santa",
  "rudolf",
  "trees",
  "moon",
  "scale",
  "snowColor",
  "zIndex",
] as const;

/** Settings the panel edits — reported through onSettingsChange. */
export type PanelSettings = Pick<
  WebPenguinsOptions,
  "penguins" | "theme" | "snow" | "santa" | "trees" | "blood" | "zapOnClick"
>;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** A rebuild key's value with defaults applied: {} and { snow: true } match. */
function effective(k: (typeof REBUILD_KEYS)[number], o: WebPenguinsOptions): unknown {
  switch (k) {
    case "theme":
      return resolveThemes(o.theme).join(",");
    case "snow":
      return o.snow === undefined ? true : o.snow;
    case "santa":
      return o.santa === undefined || o.santa === true ? "big" : o.santa;
    case "rudolf":
      return o.rudolf ?? true;
    case "trees":
      return o.trees ?? 0;
    case "moon":
      return o.moon ?? false;
    case "scale":
      return o.scale ?? 1;
    case "snowColor":
      return o.snowColor ?? "auto";
    case "zIndex":
      return o.zIndex;
  }
}

/** The one-line embed for a configuration (the dev panel's export). */
export function buildSnippet(src: string, o: WebPenguinsOptions, ov: Overrides): string {
  const esc = (s: string) => s.replace(/"/g, "'");
  const attrs = [`src="${esc(src)}"`, "data-auto"];
  if (o.penguins !== undefined && o.penguins !== 25) attrs.push(`data-penguins="${o.penguins}"`);
  const themes = resolveThemes(o.theme);
  if (themes.join(",") !== "Penguins") attrs.push(`data-theme="${esc(themes.join(","))}"`);
  if (o.snow === false || typeof o.snow === "number") attrs.push(`data-snow="${o.snow}"`);
  if (o.santa === false) attrs.push('data-santa="false"');
  else if (typeof o.santa === "string" && o.santa !== "big") attrs.push(`data-santa="${o.santa}"`);
  if (o.rudolf === false) attrs.push('data-rudolf="false"');
  if ((o.trees ?? 0) > 0) attrs.push(`data-trees="${o.trees}"`);
  if (o.moon) attrs.push('data-moon="true"');
  if (o.blood === false) attrs.push('data-blood="false"');
  if (o.angels === false) attrs.push('data-angels="false"');
  if (o.zapOnClick === false) attrs.push('data-zap="false"');
  if (typeof o.scale === "number" && o.scale !== 1) attrs.push(`data-scale="${o.scale}"`);
  if (ov.solid.length) attrs.push(`data-solid="${esc(ov.solid.join("; "))}"`);
  if (ov.ignore.length) attrs.push(`data-ignore="${esc(ov.ignore.join("; "))}"`);
  if (ov.pixel.length) attrs.push(`data-pixel="${esc(ov.pixel.join("; "))}"`);
  return `<script ${attrs.join(" ")}></script>`;
}

export class Flock {
  private opts: WebPenguinsOptions;
  private overrides: Overrides;
  private engine: Engine | null = null;
  private panel: Panel | null = null;
  private overlay = false;
  private exiting = false;
  private dead = false;

  constructor(
    opts: WebPenguinsOptions,
    private scriptSrc: string
  ) {
    this.opts = { ...opts };
    this.overrides = {
      solid: parseList(opts.solid),
      ignore: parseList(opts.ignore),
      pixel: parseList(opts.pixel),
    };
    this.boot();
    if (opts.devMode) this.showPanel();
  }

  private boot(): void {
    this.exiting = false;
    this.engine = new Engine({
      ...this.opts,
      solid: this.overrides.solid,
      ignore: this.overrides.ignore,
      pixel: this.overrides.pixel,
      // Dev-mode clicks edit the overrides inside the engine; mirror them.
      onOverridesChange: (o) => {
        this.overrides = o;
        this.opts.onOverridesChange?.({ solid: [...o.solid], ignore: [...o.ignore], pixel: [...o.pixel] });
        this.panel?.sync();
      },
    });
    this.engine.setOverlay(this.overlay);
  }

  private showPanel(): void {
    if (this.panel || this.dead) return;
    this.panel = new Panel({
      options: () => this.opts,
      set: (patch, persist) => {
        this.set(patch);
        if (persist) this.opts.onSettingsChange?.(patch as PanelSettings);
      },
      overrides: () => this.overrides,
      clearOverrides: () => this.set({ solid: [], ignore: [], pixel: [] }, true),
      surfaceCount: () => this.engine?.surfaceCount() ?? 0,
      platformCount: () => this.engine?.platformCount() ?? 0,
      snippet: () => buildSnippet(this.scriptSrc, this.opts, this.overrides),
      flockState: () => (!this.engine ? "gone" : this.exiting ? "exiting" : "running"),
      bomb: () => this.bomb(),
      revive: () => {
        if (!this.engine && !this.dead) this.boot();
        this.panel?.sync();
      },
      setOverlay: (on) => {
        this.overlay = on;
        this.engine?.setOverlay(on);
      },
      exit: () => {
        this.set({ devMode: false });
        this.opts.onDevModeExit?.();
      },
    });
  }

  private hidePanel(): void {
    this.panel?.destroy();
    this.panel = null;
    this.overlay = false;
    this.engine?.setOverlay(false);
  }

  /** "Bomb them all" from the panel: the flock goes, the panel stays. */
  private bomb(): void {
    const engine = this.engine;
    if (!engine || this.exiting) return;
    this.exiting = true;
    engine.stop().then(() => {
      if (this.engine !== engine) return; // rebuilt meanwhile
      this.engine = null;
      this.exiting = false;
      this.panel?.sync();
    });
  }

  set(patch: Partial<WebPenguinsOptions>, persistOverrides = false): void {
    if (this.dead) return;
    const next = { ...this.opts, ...patch };
    const rebuild = REBUILD_KEYS.some((k) => k in patch && !same(effective(k, next), effective(k, this.opts)));
    const live: Partial<WebPenguinsOptions> = {};
    for (const k of ["penguins", "blood", "angels", "zapOnClick"] as const) {
      if (k in patch && patch[k] !== this.opts[k]) (live as Record<string, unknown>)[k] = patch[k];
    }
    const nextOverrides: Overrides = {
      solid: "solid" in patch ? parseList(patch.solid) : this.overrides.solid,
      ignore: "ignore" in patch ? parseList(patch.ignore) : this.overrides.ignore,
      pixel: "pixel" in patch ? parseList(patch.pixel) : this.overrides.pixel,
    };
    const overridesChanged = !same(nextOverrides, this.overrides);
    this.opts = next;
    this.overrides = nextOverrides;

    if (rebuild && this.engine) {
      this.engine.destroy();
      this.boot();
    } else if (this.engine) {
      if (overridesChanged) {
        Object.assign(live, nextOverrides);
      }
      if (Object.keys(live).length) this.engine.set(live);
    }
    if (overridesChanged && persistOverrides) {
      this.opts.onOverridesChange?.({
        solid: [...nextOverrides.solid],
        ignore: [...nextOverrides.ignore],
        pixel: [...nextOverrides.pixel],
      });
    }
    if ("devMode" in patch) {
      if (patch.devMode) this.showPanel();
      else this.hidePanel();
    }
    this.panel?.sync();
  }

  async stop(o?: { explode?: boolean }): Promise<void> {
    if (this.dead) return;
    this.dead = true;
    this.hidePanel();
    await this.engine?.stop(o);
  }

  destroy(): void {
    this.dead = true;
    this.hidePanel();
    this.engine?.destroy();
    this.engine = null;
  }
}
