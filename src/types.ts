// Shared types and the original xpenguins constants.

// Original toon types (xpenguins.h). Angels only follow explosions; splatted
// and zapped penguins simply respawn — that's faithful to the original.
export type ToonType =
  | "walker"
  | "faller"
  | "tumbler"
  | "floater"
  | "climber"
  | "exit"
  | "explosion"
  | "runner"
  | "splatted"
  | "squashed"
  | "zapped"
  | "angel"
  | "action0"
  | "action1"
  | "action2"
  | "action3"
  | "action4"
  | "action5";

export const ACTIONS: ToonType[] = ["action0", "action1", "action2", "action3", "action4", "action5"];

// conf flags per type, from xpenguins_theme.c
export const NOCYCLE = new Set<ToonType>(["exit", "explosion", "splatted", "squashed", "zapped"]);
export const INVULNERABLE = new Set<ToonType>([
  "exit",
  "explosion",
  "splatted",
  "squashed",
  "zapped",
  "angel",
]);
export const NOBLOCK = new Set<ToonType>(["explosion", "squashed", "zapped", "angel"]);

export const LEFT = 0;
export const RIGHT = 1;

// Gravity argument of ToonSetType: which edge/corner of the old bounding box
// the new one is anchored to.
export type Gravity =
  | "here"
  | "down"
  | "up"
  | "left"
  | "right"
  | "downleft"
  | "downright"
  | "upright";

// Side of a toon that is glued to a surface ("association"), or null.
export type Association = "down" | "up" | "left" | "right" | null;

export const TOON_OK = 0;
export const TOON_PARTIALMOVE = 1;
export const TOON_BLOCKED = 2;

// PENGUIN_JUMP from xpenguins.h — max step a walker can climb (scaled later).
export const PENGUIN_JUMP = 8;

export interface AnimData {
  image: HTMLImageElement;
  // collision box in *world* px (already scaled): the drawn pixels' bounds,
  // which can be smaller than the frame cell (sheets often centre the art)
  width: number;
  height: number;
  // frame cell size in the source sprite sheet
  srcWidth: number;
  srcHeight: number;
  // full frame cell, scaled, and the collision box's offset inside it —
  // the renderer draws the cell at (x - drawDX, y - drawDY)
  drawW: number;
  drawH: number;
  drawDX: number;
  drawDY: number;
  frames: number;
  directions: number;
  speed: number;
  acceleration: number;
  terminalVelocity: number;
  loop: number;
  nocycle: boolean;
  invulnerable: boolean;
  noblock: boolean;
}

export interface GenusData {
  name: string;
  number: number;
  anims: Partial<Record<ToonType, AnimData>>;
}

/**
 * A collision bitmask built from an image's alpha channel — the web version
 * of the X11 SHAPE extension, which the original xpenguins supported (toons
 * could walk on shaped windows). One bit per CSS pixel at drawn size.
 */
export interface PixelMask {
  w: number;
  h: number;
  rowWords: number; // Uint32 words per row
  bits: Uint32Array;
  /** First solid row per column (-1 = none); snow settles on this profile. */
  topProfile: Int16Array;
}

export interface SolidRect {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** When present, only mask-solid pixels collide (shaped surface). */
  mask?: PixelMask;
  /** Mask-space offset of this rect's origin (nonzero when clipped). */
  maskDX?: number;
  maskDY?: number;
}

export interface WebPenguinsOptions {
  /** Number of penguins, up to 80. 0 disables them. Default 25. */
  penguins?: number;
  /**
   * Theme(s): "Penguins" (default), "Big Penguins", "Classic Penguins",
   * "Turtles", "Bill" — and, when built with the contributed pack from
   * xpenguins.seul.org: "Lemmings", "Sonic the Hedgehog", "The Simpsons",
   * "Winnie the Pooh", "Worms". A list runs them together, like
   * `xpenguins -t a -t b`; the first sets the tick pace.
   */
  theme?: string | string[];
  /** Snow on/off, or a flake count. Default true. */
  snow?: boolean | number;
  /** Santa flyby: false or a sled size. Default "big". */
  santa?: boolean | "regular" | "medium" | "big";
  /** Rudolf leads the sled. Default true. */
  rudolf?: boolean;
  /** Number of trees along the bottom. Default 0. */
  trees?: number;
  /** Draw the moon. Default false. */
  moon?: boolean;
  /** Allow gory death animations (splat/zap). Default true, like the original. */
  blood?: boolean;
  /** Exploded penguins ascend as angels. Default true. */
  angels?: boolean;
  /** Clicking a penguin zaps it. Default true. */
  zapOnClick?: boolean;
  /** Sprite scale factor, or "auto" (2 on wide viewports). Default "auto". */
  scale?: number | "auto";
  /**
   * Snow color. Default "auto": classic snow-white on dark pages, a soft
   * slate tint on light pages so flakes stay visible.
   */
  snowColor?: string | "auto";
  /** z-index of the overlay canvas. */
  zIndex?: number;
  /** Do nothing when the user prefers reduced motion. Default true. */
  respectReducedMotion?: boolean;
  /**
   * Developer mode: overlay every collidable surface (mask shapes included),
   * click elements to cycle auto → solid/ignored, and export a one-line
   * embed snippet with the current settings.
   */
  devMode?: boolean;
  /** CSS selectors forced to be platforms — a list or a ";"-joined string. */
  solid?: string | string[];
  /** CSS selectors never solid — a list or a ";"-joined string. */
  ignore?: string | string[];
  /**
   * CSS selectors whose elements collide with their rasterized *pixels* —
   * text glyphs, gradients, CSS background images. Images/canvases/inline
   * SVGs already do this automatically via their alpha channel.
   */
  pixel?: string | string[];
  /** Dev mode edited the overrides — persist them (e.g. per-site storage). */
  onOverridesChange?: (overrides: { solid: string[]; ignore: string[]; pixel: string[] }) => void;
  /** The user exited dev mode via Esc or the panel button. */
  onDevModeExit?: () => void;
}
