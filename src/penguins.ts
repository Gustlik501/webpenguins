// Port of xpenguins_core.c (© 1999-2001 Robin Hogan, GPL) — the behavior
// "genius": what a penguin decides to do each tick. Kept deliberately close
// to the original, including all its probabilities.
import { randInt } from "./rng";
import { Toon } from "./toon";
import {
  ACTIONS,
  GenusData,
  PENGUIN_JUMP,
  SolidRect,
  TOON_BLOCKED,
  TOON_OK,
  ToonType,
} from "./types";
import { World } from "./world";

const PENGUIN_MAX = 80;

export interface ZapPoint {
  x: number;
  y: number;
}

const UNZAPPABLE: Set<ToonType> = new Set([
  "explosion",
  "zapped",
  "squashed",
  "angel",
  "splatted",
  "exit",
]);

export class PenguinManager {
  toons: Toon[] = [];
  penguinNumber = 0;
  blood = true;
  angels = true;
  private jump: number;

  constructor(
    private world: World,
    private genera: GenusData[],
    private scale: number
  ) {
    this.jump = PENGUIN_JUMP * scale;
    // Assign a genus to every slot, in the theme's recommended proportions.
    let index = 0;
    for (; index < genera.length && index < PENGUIN_MAX; index++) {
      this.toons.push(this.newToon(index));
    }
    let imod = 1;
    while (index < PENGUIN_MAX) {
      let progressed = false;
      for (let i = 0; i < genera.length; i++) {
        for (let j = 0; j < genera[i].number - imod && index < PENGUIN_MAX; j++) {
          this.toons.push(this.newToon(i));
          index++;
          progressed = true;
        }
      }
      imod = 0;
      if (!progressed) break;
    }
  }

  private newToon(genus: number): Toon {
    const t = new Toon(this.world, this.genera);
    t.genus = genus;
    t.active = false;
    t.terminating = true; // don't spawn until asked for
    return t;
  }

  private initPenguin(p: Toon): void {
    const data = p.data("faller");
    p.type = "faller";
    p.frame = 0;
    p.cycle = 0;
    p.active = true;
    p.terminating = false;
    p.prefDirection = -1;
    p.prefClimb = false;
    p.direction = randInt(2);
    p.setAssociation(null);
    p.setVelocity((p.direction * 2 - 1) * this.scale, data.speed);
    // Drop in just above wherever the user is looking, so arrivals are seen.
    // If every spot up there is inside a solid, fall back to the document
    // top, which the y <= 0 surface rule keeps clear (like the original).
    const y = Math.max(1 - data.height, this.world.viewTop + 1 - data.height);
    for (let attempt = 0; attempt < 30; attempt++) {
      p.setPosition(randInt(Math.max(1, this.world.width - data.width)), y);
      if (!p.blocked("here")) return;
    }
    p.setPosition(randInt(Math.max(1, this.world.width - data.width)), 1 - data.height);
  }

  private makeClimber(p: Toon): void {
    p.setType("climber", p.direction, p.direction ? "downright" : "downleft");
    p.setAssociation(p.direction ? "right" : "left");
    p.setVelocity(0, -p.data("climber").speed);
  }

  private makeWalker(p: Toon, shiftforward: boolean): void {
    let newtype: ToonType = "walker";
    const gravity = shiftforward ? (p.direction ? "downright" : "downleft") : "down";
    if (p.has("runner") && !randInt(4)) {
      newtype = "runner";
      // Sometimes runners are larger than walkers - check for immediate squash.
      if (p.checkBlocked(newtype, gravity)) newtype = "walker";
    }
    p.setType(newtype, p.direction, gravity);
    p.setAssociation("down");
    p.setVelocity(p.data(newtype).speed * (2 * p.direction - 1), 0);
  }

  private makeFaller(p: Toon): void {
    p.setVelocity((p.direction * 2 - 1) * this.scale, p.data("faller").speed);
    p.setType("faller", p.direction, "up");
    p.setAssociation(null);
  }

  /** Grow or shrink the flock; excess penguins bomb themselves (with blood). */
  setNumber(n: number): void {
    n = Math.max(0, Math.min(PENGUIN_MAX, Math.round(n)));
    if (n > this.penguinNumber) {
      for (let i = this.penguinNumber; i < n; i++) {
        this.initPenguin(this.toons[i]);
      }
      this.penguinNumber = n;
    } else if (n < this.penguinNumber) {
      for (let i = n; i < this.penguinNumber; i++) {
        const p = this.toons[i];
        if (p.active) {
          if (this.blood && p.has("exit")) {
            p.setType("exit", p.direction, "down");
          } else if (p.has("explosion")) {
            p.setType("explosion", p.direction, "here");
          } else {
            p.active = false;
          }
        }
        p.terminating = true;
      }
    }
  }

  /** Begin the exit sequence for everyone (Ctrl-C in the original). */
  terminate(): void {
    this.setNumber(0);
  }

  /**
   * One 60ms tick for every penguin — the xpenguins_frame() port.
   * Returns the number of penguins still active or respawnable.
   */
  frame(zapPoints: ZapPoint[]): number {
    let lastActive = -1;

    for (let i = 0; i < this.penguinNumber; i++) {
      const p = this.toons[i];
      const type = p.type;

      if (!p.active) {
        if (!p.terminating) {
          this.initPenguin(p);
          lastActive = i;
        }
        continue;
      }

      const zap = zapPoints.find(
        (z) =>
          !UNZAPPABLE.has(type) &&
          !p.terminating &&
          p.mapped &&
          z.x > p.mapX &&
          z.y > p.mapY &&
          z.x < p.mapX + p.mapW &&
          z.y < p.mapY + p.mapH
      );
      if (zap) {
        if (this.blood && p.has("zapped")) {
          p.setType("zapped", p.direction, "down");
        } else if (p.has("explosion")) {
          p.setType("explosion", p.direction, "here");
        } else {
          p.active = false;
        }
        p.setAssociation(null);
        lastActive = i;
        continue;
      }

      const data = p.data();
      lastActive = i;

      // Caught inside a solid (a "window" moved onto us): squash.
      if (!(data.noblock || data.invulnerable) && p.blocked("here")) {
        if (this.blood && p.has("squashed")) {
          p.setType("squashed", p.direction, "here");
        } else if (p.has("explosion")) {
          p.setType("explosion", p.direction, "here");
        } else {
          p.active = false;
        }
        p.setVelocity(0, 0);
        p.setAssociation(null);
        continue;
      }

      let status = p.advance();

      switch (type) {
        case "faller":
          if (status !== TOON_OK) {
            if (p.blocked("down")) {
              p.direction = p.prefDirection > -1 ? p.prefDirection : randInt(2);
              this.makeWalker(p, false);
              p.prefDirection = -1;
            } else if (!p.has("climber") || randInt(2)) {
              p.setVelocity(-p.u, p.data("faller").speed);
            } else {
              p.direction = p.u > 0 ? 1 : 0;
              this.makeClimber(p);
            }
          } else if (p.v < data.terminalVelocity) {
            p.v += data.acceleration;
          }
          break;

        case "tumbler":
          if (status !== TOON_OK) {
            if (
              this.blood &&
              p.has("splatted") &&
              p.v >= data.terminalVelocity &&
              !randInt(3)
            ) {
              p.setType("splatted", 0, "down");
              p.setAssociation("down");
              p.setVelocity(0, 0);
            } else {
              p.direction = p.prefDirection > -1 ? p.prefDirection : randInt(2);
              this.makeWalker(p, false);
              p.prefDirection = -1;
            }
          } else if (p.v < data.terminalVelocity) {
            p.v += data.acceleration;
          }
          break;

        case "walker":
        case "runner":
          if (status !== TOON_OK) {
            if (status === TOON_BLOCKED) {
              // Try to step up...
              const u = p.u;
              if (!p.offsetBlocked(u, -this.jump)) {
                p.move(u, -this.jump);
                p.setVelocity(0, this.jump - 1);
                p.advance();
                p.setVelocity(u, 0);
                // Don't forget to accelerate!
                if (Math.abs(u) < data.terminalVelocity) {
                  if (p.direction) p.u += data.acceleration;
                  else p.u -= data.acceleration;
                }
              } else {
                // Blocked! We can turn round, fly or climb...
                const n = p.prefClimb ? 0 : randInt(8);
                if (n < 2) {
                  const floaterExists = p.has("floater");
                  const climberExists = p.has("climber");
                  if ((n === 0 || !floaterExists) && climberExists) {
                    this.makeClimber(p);
                    break;
                  } else if (floaterExists) {
                    const newdir = p.direction ? 0 : 1;
                    p.setType("floater", newdir, "down");
                    p.setAssociation(null);
                    p.setVelocity(
                      (randInt(5) + 1) * (newdir * 2 - 1) * this.scale,
                      -p.data("floater").speed
                    );
                    break;
                  }
                } else {
                  // Change direction *after* creating toon to make sure
                  // that a runner doesn't get instantly squashed...
                  this.makeWalker(p, false);
                  p.direction = p.direction ? 0 : 1;
                  p.u = -p.u;
                }
              }
            }
          } else if (!p.blocked("down")) {
            // Try to step down...
            const u = p.u;
            p.setVelocity(0, this.jump);
            status = p.advance();
            if (status === TOON_OK) {
              p.prefDirection = p.direction;
              if (p.has("tumbler")) {
                p.setType("tumbler", p.direction, "down");
                p.setAssociation(null);
                p.setVelocity(0, p.data("tumbler").speed);
              } else {
                this.makeFaller(p);
                p.u = 0;
              }
              p.prefClimb = false;
            } else {
              p.setVelocity(u, 0);
            }
          } else if (p.has("action0") && !randInt(100)) {
            // Sit down and read a book (or dig, or...)
            let action = 1;
            while (action < ACTIONS.length && p.has(ACTIONS[action])) ++action;
            const chosen = ACTIONS[randInt(action)];
            if (!p.checkBlocked(chosen, "down")) {
              p.setType(chosen, p.direction, "down");
              p.setVelocity(p.data(chosen).speed * (2 * p.direction - 1), 0);
            }
          } else if (Math.abs(p.u) < data.terminalVelocity) {
            if (p.direction) p.u += data.acceleration;
            else p.u -= data.acceleration;
          }
          break;

        case "action0":
        case "action1":
        case "action2":
        case "action3":
        case "action4":
        case "action5":
          if (status !== TOON_OK) {
            // Try to drift up...
            const u = p.u;
            if (!p.offsetBlocked(u, -this.jump)) {
              p.move(u, -this.jump);
              p.setVelocity(0, this.jump - 1);
              p.advance();
              p.setVelocity(u, 0);
            } else {
              this.makeWalker(p, false);
            }
          } else if (!p.blocked("down")) {
            // Try to drift down...
            p.setVelocity(0, this.jump);
            status = p.advance();
            if (status === TOON_OK) {
              if (p.has("tumbler")) {
                p.setType("tumbler", p.direction, "down");
                p.setAssociation(null);
                p.setVelocity(0, p.data("tumbler").speed);
              } else {
                this.makeFaller(p);
              }
              p.prefClimb = false;
            } else {
              p.setVelocity(data.speed * (2 * p.direction - 1), 0);
            }
          } else if (p.frame === 0) {
            let loop = data.loop;
            if (!loop) loop = -10;
            if (loop < 0) {
              if (!randInt(-loop)) this.makeWalker(p, false);
            } else if (p.cycle >= loop) {
              this.makeWalker(p, false);
            }
          }
          break;

        case "climber": {
          const direction = p.direction;
          if (p.y < 0) {
            p.direction = direction ? 0 : 1;
            this.makeFaller(p);
            p.prefClimb = false;
          } else if (status === TOON_BLOCKED) {
            // Try to step out...
            const v = p.v;
            const xoffset = (1 - direction * 2) * this.jump;
            if (!p.offsetBlocked(xoffset, v)) {
              p.move(xoffset, v);
              p.setVelocity(-xoffset - (1 - direction * 2), 0);
              p.advance();
              p.setVelocity(0, v);
            } else {
              p.direction = direction ? 0 : 1;
              this.makeFaller(p);
              p.prefClimb = false;
            }
          } else if (!p.blocked(direction ? "right" : "left")) {
            // Reached the top corner: haul ourselves over onto the surface.
            if (p.offsetBlocked((2 * direction - 1) * this.jump, 0)) {
              p.setVelocity((2 * direction - 1) * (this.jump - 1), 0);
              p.advance();
              p.setVelocity(0, -data.speed);
            } else {
              this.makeWalker(p, true);
              p.setPosition(p.x + 2 * direction - 1, p.y);
              p.prefDirection = direction;
              p.prefClimb = true;
            }
          } else if (p.v > -data.terminalVelocity) {
            p.v -= data.acceleration;
          }
          break;
        }

        case "floater":
          if (p.y < 0) {
            p.direction = p.u > 0 ? 1 : 0;
            this.makeFaller(p);
          } else if (status !== TOON_OK) {
            if (p.blocked("up")) {
              p.direction = p.u > 0 ? 1 : 0;
              this.makeFaller(p);
            } else {
              p.direction = p.direction ? 0 : 1;
              p.setVelocity(-p.u, -data.speed);
            }
          }
          break;

        case "explosion":
          if (this.angels && !p.terminating && p.has("angel")) {
            p.setType("angel", p.direction, "here");
            p.setVelocity((randInt(5) - 2) * this.scale, -p.data("angel").speed);
            p.setAssociation(null);
          }
        // fall through — just like the original
        case "angel":
          if (p.y < -data.height) {
            p.active = false;
          }
          if (status !== TOON_OK) {
            p.u = -p.u;
          }
          break;

        default:
          // exit / zapped / splatted / squashed play out via nocycle.
          break;
      }
    }

    this.penguinNumber = lastActive + 1;
    return this.penguinNumber;
  }

  /** Call when surfaces are about to move: remember who stands on what. */
  calculateAssociations(prevRects: SolidRect[]): void {
    for (let i = 0; i < this.penguinNumber; i++) {
      this.toons[i].calculateAssociation(prevRects);
    }
  }

  /** Call after surfaces moved: carry riders along (within 16px per tick). */
  relocateAssociated(): void {
    for (let i = 0; i < this.penguinNumber; i++) {
      this.toons[i].relocateAssociated(16 * this.scale);
    }
  }
}
