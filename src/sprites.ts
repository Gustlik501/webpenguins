// Turns the generated manifest + data URIs into runtime GenusData with
// decoded images, applying the global sprite scale. Themes are the original
// xpenguins theme pack: Penguins, Big Penguins, Classic Penguins, Turtles,
// Bill — selectable alone or together, like `xpenguins -t a -t b`.
import { IMAGES, MANIFEST } from "./generated/assets";
import { AnimData, GenusData, INVULNERABLE, NOBLOCK, NOCYCLE, ToonType } from "./types";

const imageCache = new Map<string, HTMLImageElement>();

export function getImage(key: string): HTMLImageElement {
  let img = imageCache.get(key);
  if (!img) {
    const uri = IMAGES[key];
    if (!uri) throw new Error(`webpenguins: missing asset "${key}"`);
    img = new Image();
    img.src = uri;
    imageCache.set(key, img);
  }
  return img;
}

interface RawAnim {
  image: string;
  width: number;
  height: number;
  frames: number;
  directions: number;
  speed: number;
  acceleration?: number;
  terminal_velocity?: number;
  loop?: number;
}

interface RawGenus {
  name: string;
  number: number;
  anims: Record<string, RawAnim>;
}

interface RawTheme {
  delay: number;
  genera: readonly RawGenus[];
}

const THEMES = MANIFEST.themes as unknown as Record<string, RawTheme>;
export const DEFAULT_THEME = "Penguins";

export function themeNames(): string[] {
  return Object.keys(THEMES);
}

/** "big_penguins", "Big Penguins" and "BigPenguins" all resolve. */
function resolveTheme(name: string): string | null {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const target = norm(name);
  for (const key of Object.keys(THEMES)) if (norm(key) === target) return key;
  return null;
}

/** Normalize the `theme` option to a list of valid manifest keys. */
export function resolveThemes(theme: string | string[] | undefined): string[] {
  const wanted = theme === undefined ? [DEFAULT_THEME] : Array.isArray(theme) ? theme : [theme];
  const out: string[] = [];
  for (const w of wanted) {
    const key = resolveTheme(String(w));
    if (key && !out.includes(key)) {
      out.push(key);
    } else if (!key) {
      console.warn(
        `webpenguins: unknown theme "${w}" (available: ${Object.keys(THEMES).join(", ")})`
      );
    }
  }
  return out.length ? out : [DEFAULT_THEME];
}

/** Wait until the snow sprites and the chosen themes' sprites have loaded. */
export async function loadImages(themes: string[]): Promise<void> {
  const keys = Object.keys(IMAGES).filter((k) => k.startsWith("snow/"));
  for (const t of themes) {
    for (const genus of THEMES[t].genera) {
      for (const anim of Object.values(genus.anims)) keys.push(anim.image);
    }
  }
  await Promise.all(
    keys.map((key) => {
      const img = getImage(key);
      if (img.complete) return undefined;
      return new Promise<void>((resolve) => {
        img.addEventListener("load", () => resolve(), { once: true });
        img.addEventListener("error", () => resolve(), { once: true });
      });
    })
  );
}

export function buildGenera(themes: string[], scale: number): GenusData[] {
  return themes.flatMap((t) =>
    THEMES[t].genera.map((genus) => {
      const anims: Partial<Record<ToonType, AnimData>> = {};
      for (const [name, raw] of Object.entries(genus.anims)) {
        const type = name as ToonType;
        anims[type] = {
          image: getImage(raw.image),
          width: raw.width * scale,
          height: raw.height * scale,
          srcWidth: raw.width,
          srcHeight: raw.height,
          frames: raw.frames,
          directions: raw.directions,
          speed: raw.speed * scale,
          acceleration: (raw.acceleration ?? 0) * scale,
          terminalVelocity: (raw.terminal_velocity ?? 0) * scale,
          loop: raw.loop ?? 0,
          nocycle: NOCYCLE.has(type),
          invulnerable: INVULNERABLE.has(type),
          noblock: NOBLOCK.has(type),
        };
      }
      return { name: genus.name, number: genus.number, anims };
    })
  );
}

/** The tick length: the first theme sets the pace (Bill shuffles at 150ms). */
export function themeDelay(themes: string[]): number {
  return THEMES[themes[0]]?.delay ?? 60;
}

export const SNOW_ASSETS = MANIFEST.snow;
