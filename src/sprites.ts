// Turns the generated manifest + data URIs into runtime GenusData with
// decoded images, applying the global sprite scale.
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

/** Wait until every referenced image has loaded (decode happens lazily). */
export async function loadAllImages(): Promise<void> {
  await Promise.all(
    Object.keys(IMAGES).map((key) => {
      const img = getImage(key);
      if (img.complete) return undefined;
      return new Promise<void>((resolve) => {
        img.addEventListener("load", () => resolve(), { once: true });
        img.addEventListener("error", () => resolve(), { once: true });
      });
    })
  );
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

export function buildGenera(scale: number): GenusData[] {
  return MANIFEST.genera.map((genus) => {
    const anims: Partial<Record<ToonType, AnimData>> = {};
    for (const [name, raw0] of Object.entries(genus.anims)) {
      const raw = raw0 as RawAnim;
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
  });
}

export const THEME_DELAY: number = MANIFEST.delay;
export const SNOW_ASSETS = MANIFEST.snow;
