// Port of the Toon library core (toon_core.c, toon_query.c, toon_set.c,
// toon_associate.c) from xpenguins 2.2, © 1999-2001 Robin Hogan, GPL.
// Coordinates are viewport CSS pixels; y grows downward, like X11.
import {
  AnimData,
  Association,
  GenusData,
  Gravity,
  SolidRect,
  TOON_BLOCKED,
  TOON_OK,
  TOON_PARTIALMOVE,
  ToonType,
} from "./types";
import { World } from "./world";

export class Toon {
  x = 0;
  y = 0;
  u = 0; // horizontal velocity, px per tick
  v = 0; // vertical velocity, px per tick
  genus = 0;
  type: ToonType = "faller";
  direction = 0;
  frame = 0;
  cycle = 0;
  prefDirection = -1;
  prefClimb = false;
  active = false;
  terminating = false;
  association: Association = null;
  assocRectId = -1;
  assocXOffset = 0;
  assocYOffset = 0;
  // Last drawn bounding box, for click ("zap") hit testing.
  mapX = 0;
  mapY = 0;
  mapW = 0;
  mapH = 0;
  mapped = false;

  constructor(
    private world: World,
    private genera: GenusData[]
  ) {}

  data(type: ToonType = this.type): AnimData {
    const anim = this.genera[this.genus].anims[type];
    if (!anim) throw new Error(`webpenguins: genus ${this.genus} has no "${type}"`);
    return anim;
  }

  has(type: ToonType): boolean {
    return this.genera[this.genus].anims[type] !== undefined;
  }

  setType(type: ToonType, direction: number, gravity: Gravity): void {
    // ToonSetGenusAndType: anchor the new bounding box to the old one.
    const data = this.data();
    const newdata = this.data(type);
    switch (gravity) {
      case "here":
        this.x += Math.trunc((data.width - newdata.width) / 2);
        this.y += Math.trunc((data.height - newdata.height) / 2);
        break;
      case "down":
        this.x += Math.trunc((data.width - newdata.width) / 2);
        this.y += data.height - newdata.height;
        break;
      case "up":
        this.x += Math.trunc((data.width - newdata.width) / 2);
        break;
      case "left":
        this.y += Math.trunc((data.height - newdata.height) / 2);
        break;
      case "right":
        this.x += data.width - newdata.width;
        this.y += Math.trunc((data.height - newdata.height) / 2);
        break;
      case "downleft":
        this.y += data.height - newdata.height;
        break;
      case "downright":
        this.x += data.width - newdata.width;
        this.y += data.height - newdata.height;
        break;
      case "upright":
        this.x += data.width - newdata.width;
        break;
    }
    this.type = type;
    this.cycle = 0;
    this.direction = direction;
    this.frame = 0;
    this.active = true;
  }

  setVelocity(u: number, v: number): void {
    this.u = u;
    this.v = v;
  }

  setAssociation(association: Association): void {
    this.association = association;
  }

  /** ToonBlocked: is the toon prevented from moving 1px in `direction`? */
  blocked(direction: "here" | "left" | "right" | "up" | "down"): boolean {
    const data = this.data();
    const w = this.world;
    switch (direction) {
      case "left":
        if (this.x <= 0) return true;
        return w.intersects(this.x - 1, this.y, 1, data.height);
      case "right":
        if (this.x + data.width >= w.width) return true;
        return w.intersects(this.x + data.width, this.y, 1, data.height);
      case "up":
        if (this.y <= 0) return true;
        return w.intersects(this.x, this.y - 1, data.width, 1);
      case "down":
        if (this.y + data.height >= w.height) return true;
        // standing exactly on the glass floor counts as support
        if (w.glassActive() && Math.abs(this.y + data.height - w.glassY) < 1) return true;
        for (const r of w.platforms) {
          if (Math.abs(this.y + data.height - r.y) < 1 && this.x < r.x + r.w && this.x + data.width > r.x) return true;
        }
        return w.intersects(this.x, this.y + data.height, data.width, 1);
      case "here":
        return w.intersects(this.x, this.y, data.width, data.height);
    }
  }

  /** ToonOffsetBlocked: would the toon overlap anything at (x+dx, y+dy)? */
  offsetBlocked(dx: number, dy: number): boolean {
    const data = this.data();
    const w = this.world;
    if (
      this.x + dx <= 0 ||
      this.x + data.width + dx >= w.width ||
      // top edge is open (TOON_SIDEBOTTOMBLOCK)
      this.y + data.height + dy >= w.height
    ) {
      return true;
    }
    return w.intersects(this.x + dx, this.y + dy, data.width, data.height);
  }

  /** ToonCheckBlocked: would switching to `type` at this position squash us? */
  checkBlocked(type: ToonType, gravity: Gravity): boolean {
    const data = this.data();
    const newdata = this.data(type);
    let x = this.x;
    let y = this.y;
    switch (gravity) {
      case "here":
        x += Math.trunc((data.width - newdata.width) / 2);
        y += Math.trunc((data.height - newdata.height) / 2);
        break;
      case "down":
        x += Math.trunc((data.width - newdata.width) / 2);
        y += data.height - newdata.height;
        break;
      case "up":
        x += Math.trunc((data.width - newdata.width) / 2);
        break;
      case "downright":
        x += data.width - newdata.width;
        y += data.height - newdata.height;
        break;
      default:
        break;
    }
    return this.world.intersects(x, y, newdata.width, newdata.height);
  }

  move(dx: number, dy: number): void {
    this.x += dx;
    this.y += dy;
  }

  setPosition(x: number, y: number): void {
    this.x = x;
    this.y = y;
  }

  /**
   * ToonAdvance: attempt to move by (u, v). Returns TOON_OK, TOON_BLOCKED or
   * TOON_PARTIALMOVE. `still` tests the move without performing it.
   */
  advance(still = false): number {
    const data = this.data();
    const w = this.world;
    const width = data.width;
    const height = data.height;
    let moveAhead = !still;
    let result = TOON_OK;

    let newx = this.x + this.u;
    let newy = this.y + this.v;
    const stationary = this.u === 0 && this.v === 0;

    if (data.noblock) {
      // Only blocked by the sides of the screen.
      if (newx < 0) {
        newx = 0;
        result = TOON_PARTIALMOVE;
      } else if (newx + width > w.width) {
        newx = w.width - width;
        result = TOON_PARTIALMOVE;
      }
    } else {
      if (newx < 0) {
        newx = 0;
        result = TOON_PARTIALMOVE;
      } else if (newx + width > w.width) {
        newx = w.width - width;
        result = TOON_PARTIALMOVE;
      }
      // top of screen is open; bottom is solid
      if (newy + height > w.height) {
        newy = w.height - height;
        result = TOON_PARTIALMOVE;
      }
      // The glass floor at the bottom of the viewport is one-way: it stops
      // downward crossings from above, but toons already below it are free.
      if (w.glassActive() && this.y + height <= w.glassY && newy + height > w.glassY) {
        newy = w.glassY - height;
        result = TOON_PARTIALMOVE;
      }
      // Camera-glued platforms use the same one-way crossing rule. Each
      // clamp shortens the fall, so the highest crossed top wins in any order.
      for (const r of w.platforms) {
        if (this.y + height <= r.y && newy + height > r.y && newx < r.x + r.w && newx + width > r.x) {
          newy = r.y - height;
          result = TOON_PARTIALMOVE;
        }
      }
      if (newx === this.x && newy === this.y && !stationary) {
        result = TOON_BLOCKED;
      }

      if (!still && result !== TOON_BLOCKED && !stationary && w.intersects(newx, newy, width, height)) {
        // Blocked by a solid: how far along the movement line can we get?
        const u = newx - this.x;
        const v = newy - this.y;
        result = TOON_BLOCKED;
        moveAhead = false;
        if (Math.abs(v) < Math.abs(u)) {
          const step = newx > this.x ? -1 : 1;
          for (let tryx = newx + step; tryx !== this.x; tryx += step) {
            const tryy = this.y + Math.trunc(((tryx - this.x) * v) / u);
            if (!w.intersects(tryx, tryy, width, height)) {
              newx = tryx;
              newy = tryy;
              result = TOON_PARTIALMOVE;
              moveAhead = true;
              break;
            }
          }
        } else {
          const step = newy > this.y ? -1 : 1;
          for (let tryy = newy + step; tryy !== this.y; tryy += step) {
            const tryx = this.x + Math.trunc(((tryy - this.y) * u) / v);
            if (!w.intersects(tryx, tryy, width, height)) {
              newx = tryx;
              newy = tryy;
              result = TOON_PARTIALMOVE;
              moveAhead = true;
              break;
            }
          }
        }
      }
    }

    if (moveAhead) {
      this.x = newx;
      this.y = newy;
      if (++this.frame >= data.frames) {
        this.frame = 0;
        ++this.cycle;
        if (data.nocycle) this.active = false;
      }
    } else if (data.nocycle) {
      if (++this.frame >= data.frames) {
        this.frame = 0;
        this.cycle = 0;
        this.active = false;
      }
    }
    return result;
  }

  /** ToonCalculateAssociations for one toon, against the given rect set. */
  calculateAssociation(rects: SolidRect[]): void {
    if (this.association === null || !this.active) return;
    const data = this.data();
    let x: number, y: number, w: number, h: number;
    switch (this.association) {
      case "down":
        x = this.x;
        y = this.y + data.height;
        w = data.width;
        h = 1;
        break;
      case "up":
        x = this.x;
        y = this.y - 1;
        w = data.width;
        h = 1;
        break;
      case "left":
        x = this.x - 1;
        y = this.y;
        w = 1;
        h = data.height;
        break;
      case "right":
        x = this.x + data.width;
        y = this.y;
        w = 1;
        h = data.height;
        break;
    }
    this.assocRectId = -1;
    const r = this.world.findRect(x, y, w, h, rects);
    if (r) {
      this.assocRectId = r.id;
      this.assocXOffset = this.x - r.x;
      this.assocYOffset = this.y - r.y;
    }
  }

  /** ToonRelocateAssociated for one toon: ride the surface it stands on. */
  relocateAssociated(maxRelocate: number): void {
    if (this.association === null || this.assocRectId < 0 || !this.active) return;
    const r = this.world.rectById(this.assocRectId, this.world.rects);
    if (!r) return;
    const dx = this.assocXOffset + r.x - this.x;
    const dy = this.assocYOffset + r.y - this.y;
    if (
      dx < maxRelocate &&
      -dx < maxRelocate &&
      dy < maxRelocate &&
      -dy < maxRelocate &&
      (dx !== 0 || dy !== 0)
    ) {
      if (!this.offsetBlocked(dx, dy)) {
        this.x += dx;
        this.y += dy;
      }
    }
  }
}
