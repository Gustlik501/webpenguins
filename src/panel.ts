// The in-page control panel: the extension popup's menu plus the developer
// tools, pinned to the bottom-right corner and collapsible to a little
// penguin. Shown with { devMode: true } / data-dev, so a site embedding
// webpenguins gets everything the extension offers without installing it.
// It lives in a shadow root: page CSS can't restyle it, and its markup
// stays out of the page's querySelector results.
import { Overrides } from "./devmode";
import { IconSprite, iconSprite, themeNames } from "./sprites";
import { WebPenguinsOptions } from "./types";

export interface PanelHost {
  options(): WebPenguinsOptions;
  /** Apply settings; `persist` once the user settles (e.g. slider release). */
  set(patch: Partial<WebPenguinsOptions>, persist: boolean): void;
  overrides(): Overrides;
  clearOverrides(): void;
  surfaceCount(): number;
  platformCount(): number;
  snippet(): string;
  /** Penguins alive, mid-exit, or gone after "Bomb them all". */
  flockState(): "running" | "exiting" | "gone";
  bomb(): void;
  revive(): void;
  /** Collision overlay + click-to-override picking on/off. */
  setOverlay(on: boolean): void;
  /** The close button: leave developer mode altogether. */
  exit(): void;
}

// The original five first, in the popup's order; the contributed pack after.
const THEME_ORDER = ["Penguins", "Big Penguins", "Classic Penguins", "Turtles", "Bill"];

// Collapsed + overlay state survives engine restarts (a module variable)
// and, on sites embedding us, reloads (localStorage). An extension content
// script shares the page's localStorage, so there we keep the extension's
// promise of leaving nothing page-visible behind.
const STORE_KEY = "webpenguins:panel";
let memory: { collapsed: boolean; collisions: boolean } | null = null;

function inExtension(): boolean {
  const c = (globalThis as { chrome?: { runtime?: { id?: string } } }).chrome;
  return !!c?.runtime?.id;
}

function loadMemory(): { collapsed: boolean; collisions: boolean } {
  if (memory) return memory;
  memory = { collapsed: false, collisions: true };
  if (!inExtension()) {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
      if (saved) memory = { collapsed: !!saved.collapsed, collisions: saved.collisions !== false };
    } catch {
      // private mode / blocked storage: in-memory only
    }
  }
  return memory;
}

function saveMemory(): void {
  if (inExtension() || !memory) return;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(memory));
  } catch {
    // ignore
  }
}

/** A theme's walker on a tiny canvas; walks in place while hovered. */
class PenguinIcon {
  readonly canvas = document.createElement("canvas");
  private ctx = this.canvas.getContext("2d");
  private sprite: IconSprite | null = null;
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private size: number) {
    this.canvas.style.width = this.canvas.style.height = size + "px";
    this.canvas.setAttribute("aria-hidden", "true");
  }

  setTheme(theme: string | string[] | undefined): void {
    this.sprite = iconSprite(theme);
    this.frame = 0;
    const img = this.sprite?.image;
    if (img && !img.complete) img.addEventListener("load", () => this.draw(), { once: true });
    this.draw();
  }

  walk(on: boolean): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.frame = 0;
    if (on && this.sprite && this.sprite.frames > 1) {
      this.timer = setInterval(() => {
        this.frame = (this.frame + 1) % this.sprite!.frames;
        this.draw();
      }, 90);
    }
    this.draw();
  }

  private draw(): void {
    const s = this.sprite;
    const ctx = this.ctx;
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const box = Math.round(this.size * dpr);
    if (this.canvas.width !== box) this.canvas.width = this.canvas.height = box;
    ctx.clearRect(0, 0, box, box);
    if (!s || !s.image.complete || !s.image.naturalWidth) return;
    // Whole device pixels per sprite pixel when it fits; shrink otherwise.
    const fit = (box * 0.9) / Math.max(s.w, s.h);
    const k = fit >= 1 ? Math.floor(fit) : fit;
    const dw = s.w * k;
    const dh = s.h * k;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      s.image,
      this.frame * s.cellW + s.sx,
      s.row * s.cellH + s.sy,
      s.w,
      s.h,
      Math.round((box - dw) / 2),
      Math.round((box - dh) / 2),
      dw,
      dh
    );
  }

  destroy(): void {
    clearInterval(this.timer);
  }
}

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
.wp {
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483646;
  font: 13px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  color: #eef2f7; color-scheme: dark;
}
.card {
  width: 292px; max-width: calc(100vw - 32px); max-height: calc(100vh - 32px);
  overflow: auto; background: #10315c; border: 1px solid #2a5688;
  border-radius: 12px; box-shadow: 0 10px 32px rgba(0, 0, 0, .45);
  transform-origin: bottom right; animation: pop .14s ease-out;
}
@keyframes pop { from { opacity: 0; transform: scale(.92); } }
header { display: flex; align-items: center; gap: 10px; padding: 10px 8px 6px 12px; }
header .title { flex: 1; min-width: 0; }
h1 { font-size: 15px; margin: 0; font-weight: 600; line-height: 1.2; }
.sub { font-size: 11px; opacity: .65; }
.icon-btn {
  width: 28px; height: 28px; border: 0; border-radius: 6px; background: transparent;
  color: inherit; cursor: pointer; font: 18px/1 system-ui, sans-serif; padding: 0;
  display: grid; place-items: center; opacity: .8;
}
.icon-btn:hover { background: #1c4e89; opacity: 1; }
main { padding: 0 14px 12px; }
.row { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 4px 0; }
.row label { flex: 1; }
input[type="range"] { width: 112px; accent-color: #6aa3e3; margin: 0; }
input[type="checkbox"] { accent-color: #6aa3e3; width: 15px; height: 15px; margin: 0; }
select, input[type="number"] {
  background: #1c4e89; color: #fff; border: 1px solid #3a6ea5; border-radius: 4px;
  padding: 2px 4px; width: 132px; font: inherit; font-size: 12px;
}
input[type="number"] { width: 56px; }
.count { min-width: 22px; text-align: right; font-variant-numeric: tabular-nums; }
hr { border: 0; border-top: 1px solid #2a5688; margin: 8px 0; }
button.action {
  width: 100%; margin-top: 8px; padding: 7px; border: 0; border-radius: 6px;
  background: #d9534f; color: #fff; font: 600 13px/1.3 system-ui, sans-serif; cursor: pointer;
}
button.action:hover { background: #c9302c; }
button.action:disabled { opacity: .6; cursor: default; }
button.action.revive { background: #2f8f5b; }
button.action.revive:hover { background: #277a4d; }
button.action.secondary { background: #2a5688; margin-top: 6px; font-weight: 500; }
button.action.secondary:hover { background: #34689f; }
.stats { font-size: 12px; opacity: .8; font-variant-numeric: tabular-nums; }
.hint { font-size: 12px; opacity: .75; margin: 4px 0 6px; }
.g { color: #4ade80; } .c { color: #38bdf8; } .r { color: #f87171; } .v { color: #c084fc; }
.label { display: block; font-size: 12px; opacity: .75; margin: 6px 0 3px; }
.snip { display: flex; gap: 6px; }
.snip input {
  flex: 1; min-width: 0; background: #0b2344; color: #9fc0e8; border: 1px solid #2a5688;
  border-radius: 6px; padding: 4px 6px; font: 11px ui-monospace, SFMono-Regular, Menlo, monospace;
}
.snip button {
  background: #2563eb; color: #fff; border: 0; border-radius: 6px; padding: 4px 10px;
  cursor: pointer; font: 600 12px system-ui, sans-serif;
}
.snip button:hover { background: #1d4ed8; }
.fab {
  width: 52px; height: 52px; border-radius: 50%; border: 1px solid #2a5688;
  background: #10315c; box-shadow: 0 6px 20px rgba(0, 0, 0, .4); cursor: pointer;
  display: grid; place-items: center; padding: 0; animation: pop .14s ease-out;
  transition: transform .12s ease, background .12s ease;
}
.fab:hover { background: #1c4e89; transform: translateY(-2px); }
.fab canvas, header canvas { image-rendering: pixelated; display: block; }
:focus-visible { outline: 2px solid #9cc3ee; outline-offset: 2px; }
`;

const HTML = `
<div class="wp">
  <button class="fab" data-wp-fab title="Web Penguins" aria-label="Open the Web Penguins panel" hidden></button>
  <section class="card" data-wp-card role="dialog" aria-label="Web Penguins">
    <header>
      <span data-wp-logo></span>
      <div class="title"><h1>Web Penguins</h1><div class="sub">developer mode</div></div>
      <button class="icon-btn" data-wp-collapse title="Collapse (Esc)" aria-label="Collapse">&#8722;</button>
      <button class="icon-btn" data-wp-close title="Close developer mode" aria-label="Close developer mode">&#215;</button>
    </header>
    <main>
      <div class="row">
        <label for="wp-penguins">Penguins</label>
        <input type="range" id="wp-penguins" min="0" max="80" step="1">
        <span class="count" data-wp-count></span>
      </div>
      <div class="row"><label for="wp-theme">Theme</label><select id="wp-theme"></select></div>
      <div class="row"><label for="wp-snow">Snow</label><input type="checkbox" id="wp-snow"></div>
      <div class="row">
        <label for="wp-santa">Santa</label>
        <select id="wp-santa">
          <option value="off">off</option><option value="regular">regular</option>
          <option value="medium">medium</option><option value="big">big</option>
        </select>
      </div>
      <div class="row"><label for="wp-trees">Trees</label><input type="number" id="wp-trees" min="0" max="12" step="1"></div>
      <div class="row"><label for="wp-blood">Splats &amp; zaps (blood)</label><input type="checkbox" id="wp-blood"></div>
      <div class="row"><label for="wp-zap">Click to zap</label><input type="checkbox" id="wp-zap"></div>
      <button class="action" data-wp-bomb></button>
      <hr>
      <div class="row"><label for="wp-collisions"><strong>Show collisions</strong></label><input type="checkbox" id="wp-collisions"></div>
      <div class="stats" data-wp-stats></div>
      <p class="hint" data-wp-hint>Click an element to cycle <span class="g">auto</span> &#8594;
        <span class="c">solid</span> / <span class="r">ignored</span>. Shift+click:
        <span class="v">pixel-perfect</span> (exact element under the cursor).</p>
      <label class="label" for="wp-snippet">Embed snippet</label>
      <div class="snip">
        <input id="wp-snippet" data-wp-snippet readonly spellcheck="false">
        <button data-wp-copy>Copy</button>
      </div>
      <button class="action secondary" data-wp-clear>Clear overrides</button>
    </main>
  </section>
</div>`;

export class Panel {
  readonly host: HTMLDivElement;
  private root: ShadowRoot;
  private fab: HTMLButtonElement;
  private card: HTMLElement;
  private fabIcon = new PenguinIcon(36);
  private logoIcon = new PenguinIcon(32);
  private state = loadMemory();
  private timer: ReturnType<typeof setInterval> | undefined;
  private listeners: Array<() => void> = [];
  private iconTheme = "";

  constructor(private api: PanelHost) {
    this.host = document.createElement("div");
    // Ignore explicitly: being fixed would otherwise make it a platform.
    this.host.setAttribute("data-webpenguins", "ignore");
    this.host.setAttribute("data-webpenguins-devpanel", "");
    this.root = this.host.attachShadow({ mode: "open" });
    this.root.innerHTML = `<style>${CSS}</style>${HTML}`;
    this.fab = this.$("[data-wp-fab]") as HTMLButtonElement;
    this.card = this.$("[data-wp-card]");
    this.fab.appendChild(this.fabIcon.canvas);
    this.$("[data-wp-logo]").appendChild(this.logoIcon.canvas);

    const themeSelect = this.$("#wp-theme") as HTMLSelectElement;
    const all = themeNames();
    for (const t of [...THEME_ORDER.filter((t) => all.includes(t)), ...all.filter((t) => !THEME_ORDER.includes(t))]) {
      themeSelect.add(new Option(t, t));
    }
    this.wire();
    // Clicking and typing in the panel is not the page's business (its
    // shortcuts, click-outside handlers…); our own window-capture
    // listeners have already seen these events by now.
    for (const type of ["click", "dblclick", "pointerdown", "pointerup", "mousedown", "mouseup", "keydown", "keyup", "keypress"]) {
      this.root.addEventListener(type, (e) => e.stopPropagation());
    }
    document.documentElement.appendChild(this.host);
    this.applyCollapsed();
    this.sync();
  }

  private $(sel: string): HTMLElement {
    return this.root.querySelector(sel) as HTMLElement;
  }

  private input(id: string): HTMLInputElement {
    return this.root.getElementById(id) as HTMLInputElement;
  }

  private wire(): void {
    const on = (sel: string, type: string, fn: (el: HTMLInputElement) => void) => {
      const el = this.$(sel) as HTMLInputElement;
      el.addEventListener(type, () => fn(el));
    };
    on("#wp-penguins", "input", (el) => {
      this.$("[data-wp-count]").textContent = el.value;
      this.api.set({ penguins: Number(el.value) }, false); // live, unsaved
    });
    on("#wp-penguins", "change", (el) => this.api.set({ penguins: Number(el.value) }, true));
    on("#wp-theme", "change", (el) => {
      const v = el.value;
      this.api.set({ theme: v.includes(",") ? v.split(",") : v }, true);
    });
    on("#wp-snow", "change", (el) => this.api.set({ snow: el.checked }, true));
    on("#wp-santa", "change", (el) => {
      this.api.set({ santa: el.value === "off" ? false : (el.value as "regular" | "medium" | "big") }, true);
    });
    on("#wp-trees", "change", (el) => {
      const n = Math.max(0, Math.min(12, Math.round(Number(el.value)) || 0));
      el.value = String(n);
      this.api.set({ trees: n }, true);
    });
    on("#wp-blood", "change", (el) => this.api.set({ blood: el.checked }, true));
    on("#wp-zap", "change", (el) => this.api.set({ zapOnClick: el.checked }, true));
    on("#wp-collisions", "change", (el) => {
      this.state.collisions = el.checked;
      saveMemory();
      this.applyOverlay();
      this.sync();
    });
    on("[data-wp-bomb]", "click", () => {
      if (this.api.flockState() === "gone") this.api.revive();
      else this.api.bomb();
      this.sync();
    });
    on("[data-wp-clear]", "click", () => this.api.clearOverrides());
    on("[data-wp-collapse]", "click", () => this.setCollapsed(true));
    on("[data-wp-close]", "click", () => this.api.exit());
    on("[data-wp-fab]", "click", () => this.setCollapsed(false));
    on("[data-wp-copy]", "click", (btn) => {
      const snippet = this.$("[data-wp-snippet]") as HTMLInputElement;
      snippet.select();
      const done = () => {
        btn.textContent = "Copied!";
        setTimeout(() => (btn.textContent = "Copy"), 1200);
      };
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(snippet.value).then(done, () => {
          document.execCommand("copy");
          done();
        });
      } else {
        document.execCommand("copy");
        done();
      }
    });
    this.fab.addEventListener("mouseenter", () => this.fabIcon.walk(true));
    this.fab.addEventListener("mouseleave", () => this.fabIcon.walk(false));
    this.fab.addEventListener("focus", () => this.fabIcon.walk(true));
    this.fab.addEventListener("blur", () => this.fabIcon.walk(false));

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !this.state.collapsed) this.setCollapsed(true);
    };
    window.addEventListener("keydown", onKey, true);
    this.listeners.push(() => window.removeEventListener("keydown", onKey, true));
  }

  /**
   * Collapsing gets the panel *and* the overlay out of the way: the page
   * is clickable again and you see exactly what visitors will see.
   */
  setCollapsed(collapsed: boolean): void {
    if (this.state.collapsed === collapsed) return;
    this.state.collapsed = collapsed;
    saveMemory();
    this.applyCollapsed();
    // Keep keyboard focus on the panel when it changes shape.
    (collapsed ? this.fab : (this.$("[data-wp-collapse]") as HTMLButtonElement)).focus({ preventScroll: true });
  }

  private applyCollapsed(): void {
    const collapsed = this.state.collapsed;
    this.fab.hidden = !collapsed;
    this.card.hidden = collapsed;
    this.fabIcon.walk(false);
    clearInterval(this.timer);
    this.timer = undefined;
    if (!collapsed) {
      // Surface counts and the snippet drift as the page settles.
      this.timer = setInterval(() => this.syncLive(), 500);
      this.sync();
    }
    this.applyOverlay();
  }

  private applyOverlay(): void {
    this.api.setOverlay(!this.state.collapsed && this.state.collisions);
  }

  /** Re-read every control from the options (after any outside change). */
  sync(): void {
    const o = this.api.options();
    const focused = this.root.activeElement;
    const put = (id: string, fn: (el: HTMLInputElement) => void) => {
      const el = this.input(id);
      if (el !== focused) fn(el);
    };
    const n = o.penguins ?? 25;
    put("wp-penguins", (el) => (el.value = String(n)));
    this.$("[data-wp-count]").textContent = String(n);
    put("wp-theme", (el) => {
      const sel = el as unknown as HTMLSelectElement;
      const themes = Array.isArray(o.theme) ? o.theme : [o.theme ?? "Penguins"];
      const value = themes.join(",");
      // A mixed flock (theme: ["Penguins", "Turtles"]) gets its own entry.
      if (![...sel.options].some((op) => op.value === value)) sel.add(new Option(themes.join(" + "), value));
      sel.value = value;
    });
    put("wp-snow", (el) => (el.checked = o.snow !== false && o.snow !== 0));
    put("wp-santa", (el) => (el.value = o.santa === false ? "off" : o.santa === true || !o.santa ? "big" : o.santa));
    put("wp-trees", (el) => (el.value = String(o.trees ?? 0)));
    put("wp-blood", (el) => (el.checked = o.blood ?? true));
    put("wp-zap", (el) => (el.checked = o.zapOnClick ?? true));
    put("wp-collisions", (el) => (el.checked = this.state.collisions));
    this.$("[data-wp-hint]").hidden = !this.state.collisions;

    const themeKey = JSON.stringify(o.theme ?? "");
    if (themeKey !== this.iconTheme) {
      this.iconTheme = themeKey;
      this.fabIcon.setTheme(o.theme);
      this.logoIcon.setTheme(o.theme);
    }
    this.syncLive();
  }

  /** The parts that change on their own: counts, snippet, bomb state. */
  private syncLive(): void {
    const ov = this.api.overrides();
    const platforms = this.api.platformCount();
    this.$("[data-wp-stats]").textContent =
      `${this.api.surfaceCount()} surfaces · ` + (platforms > 0 ? `${platforms} platforms · ` : "") +
      `${ov.solid.length} solid · ` +
      `${ov.ignore.length} ignored · ${ov.pixel.length} pixel`;
    const snippet = this.$("[data-wp-snippet]") as HTMLInputElement;
    const next = this.api.snippet();
    if (snippet.value !== next) snippet.value = next;
    const bomb = this.$("[data-wp-bomb]") as HTMLButtonElement;
    const state = this.api.flockState();
    bomb.disabled = state === "exiting";
    bomb.classList.toggle("revive", state === "gone");
    bomb.textContent =
      state === "gone" ? "🐧 Bring them back" : state === "exiting" ? "💣 Bombs away…" : "💣 Bomb them all";
  }

  destroy(): void {
    clearInterval(this.timer);
    for (const off of this.listeners) off();
    this.listeners = [];
    this.fabIcon.destroy();
    this.logoIcon.destroy();
    this.host.remove();
  }
}
