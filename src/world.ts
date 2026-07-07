// The collision world: the *document* is the "screen", DOM elements are the
// "windows", and scrolling only moves the camera. Port of the X Region
// queries used by toon_core/toon_query. Edge blocking follows xpenguins'
// TOON_SIDEBOTTOMBLOCK: sides and bottom of the page are solid, the top is
// open (toons drop in from above).
import { SolidRect } from "./types";

export class World {
  width = 0; // document width
  height = 0; // document height
  viewTop = 0; // document Y of the viewport top (where the user is looking)
  /**
   * The "glass floor": the document Y of the viewport's bottom edge. It is a
   * one-way collider — falling toons land on it, so nothing ever drops out of
   * sight on endless pages, but toons already living below it (on surfaces
   * further down the document) are unaffected. Inactive when it coincides
   * with the document bottom.
   */
  glassY = Infinity;
  rects: SolidRect[] = [];
  prevRects: SolidRect[] = [];

  glassActive(): boolean {
    return this.glassY < this.height;
  }

  /** XRectInRegion(...) != RectangleOut */
  intersects(x: number, y: number, w: number, h: number): boolean {
    for (const r of this.rects) {
      if (x < r.x + r.w && x + w > r.x && y < r.y + r.h && y + h > r.y) return true;
    }
    return false;
  }

  /** First rect overlapping the given line/box, used for associations. */
  findRect(x: number, y: number, w: number, h: number, rects: SolidRect[]): SolidRect | null {
    for (const r of rects) {
      if (x < r.x + r.w && x + w > r.x && y < r.y + r.h && y + h > r.y) return r;
    }
    return null;
  }

  rectById(id: number, rects: SolidRect[]): SolidRect | null {
    for (const r of rects) if (r.id === id) return r;
    return null;
  }

  setRects(rects: SolidRect[]): void {
    this.prevRects = this.rects;
    this.rects = rects;
  }
}
