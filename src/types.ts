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
  // frame size in *world* (CSS px, already multiplied by scale)
  width: number;
  height: number;
  // frame size in the source sprite sheet
  srcWidth: number;
  srcHeight: number;
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
   * Theme(s) from the original xpenguins theme pack: "Penguins" (default),
   * "Big Penguins", "Classic Penguins", "Turtles", "Bill". A list runs them
   * together, like `xpenguins -t a -t b`; the first sets the tick pace.
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
}
