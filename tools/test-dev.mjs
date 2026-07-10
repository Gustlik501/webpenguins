// Developer mode + overrides: option-level overrides must add/remove
// surfaces; the dev panel must exist; clicking an element must cycle its
// override; the export snippet must carry settings + overrides.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser, Tab, sleep } from "./cdp.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scratch = process.env.WP_SCRATCH || path.join(root, ".test");

const { proc, port } = await launchBrowser(path.join(scratch, "edge-profile"));
try {
  const url = "file:///" + path.join(root, "demo", "probe.html").replace(/\\/g, "/");
  const tab = await Tab.open(port, url);
  await sleep(1500);

  // 1. Option-level overrides: ignore the cards, force the ghost div solid.
  const overrides = await tab.eval(`
    (function () {
      window.flock.destroy();
      window.flock = WebPenguins.start({
        penguins: 3, ignore: [".card"], solid: ["#ghost"], debug: true
      });
      return new Promise(function (res) {
        setTimeout(function () {
          var rects = window.__webpenguins.world.rects;
          res({
            // the two .card boxes (720x71, 720x152) gone; .img (720x200) stays
            cardGone: !rects.some(function (r) { return r.h === 71 || r.h === 152; }),
            imgStays: rects.some(function (r) { return r.w === 720 && r.h === 200; }),
            ghostSolid: rects.some(function (r) { return r.w === 400 && r.h === 60; })
          });
        }, 800);
      });
    })()
  `);
  console.log("OVERRIDE-OPTIONS:", JSON.stringify(overrides));

  // 1b. A forced child inside an ignored subtree must still collide:
  //     ignore the card, force the <em> inside it solid.
  const forcedChild = await tab.eval(`
    (function () {
      window.flock.destroy();
      window.flock = WebPenguins.start({
        penguins: 3, ignore: [".card"], solid: ["#cardem"], debug: true
      });
      return new Promise(function (res) {
        setTimeout(function () {
          var w = window.__webpenguins.world;
          var em = document.getElementById("cardem");
          var r = em.getBoundingClientRect();
          var ex = r.left + scrollX, ey = r.top + scrollY;
          res({
            cardGone: !w.rects.some(function (q) { return q.h === 71 || q.h === 152; }),
            emSolid: w.rects.some(function (q) {
              return Math.abs(q.x - ex) < 3 && Math.abs(q.y - ey) < 3;
            })
          });
        }, 800);
      });
    })()
  `);
  console.log("FORCED-CHILD:", JSON.stringify(forcedChild));

  // 2. Dev mode UI: panel appears, a click on #ghost forces it solid,
  //    a second click flips it to ignored, snippet carries it all.
  const dev = await tab.eval(`
    (function () {
      window.flock.destroy();
      window.flock = WebPenguins.start({ penguins: 3, theme: "Turtles", trees: 2, devMode: true, debug: true });
      return new Promise(function (res) {
        setTimeout(function () {
          var panel = document.querySelector("[data-webpenguins-devpanel]");
          var ghost = document.getElementById("ghost");
          var click = function () {
            ghost.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
          };
          click(); // auto (not solid) -> forced solid
          setTimeout(function () {
            var rects1 = window.__webpenguins.world.rects;
            var afterFirst = rects1.some(function (r) { return r.w === 400 && r.h === 60; });
            var snippet1 = panel ? panel.querySelector("[data-wp-snippet]").value : "";
            click(); // forced solid -> ignored
            setTimeout(function () {
              var rects2 = window.__webpenguins.world.rects;
              var snippet2 = panel ? panel.querySelector("[data-wp-snippet]").value : "";
              // Esc exits dev mode
              window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
              setTimeout(function () {
                res({
                  panel: !!panel,
                  ghostSolidAfterClick: afterFirst,
                  snippetAfterClick: snippet1,
                  ghostSolidAfterSecond: rects2.some(function (r) { return r.w === 400 && r.h === 60; }),
                  snippetAfterSecond: snippet2,
                  panelGoneAfterEsc: !document.querySelector("[data-webpenguins-devpanel]"),
                  err: window.__webpenguins.engine.lastError || "none"
                });
              }, 300);
            }, 400);
          }, 400);
        }, 1200);
      });
    })()
  `);
  console.log("DEV-MODE:", JSON.stringify(dev, null, 1));

  // 3. Pixel-perfect override on a text heading: penguins must collide
  //    with the glyphs of "Short", not its full-width block box.
  const pixel = await tab.eval(`
    (function () {
      window.flock.destroy();
      window.flock = WebPenguins.start({ penguins: 2, pixel: ["#inkhead"], debug: true });
      return new Promise(function (res) {
        setTimeout(function () {
          var w = window.__webpenguins.world;
          var head = document.getElementById("inkhead");
          var hr = head.getBoundingClientRect();
          var hx = hr.left + scrollX, hy = hr.top + scrollY;
          var r = w.rects.filter(function (q) {
            return q.mask && Math.abs(q.y - hy) < 3 && Math.abs(q.x - hx) < 3;
          })[0];
          if (!r) return res({ masked: false });
          var midY = Math.round(r.y + r.h / 2);
          var ink = false;
          for (var x = 0; x < 160; x++) {
            if (w.intersects(r.x + x, midY, 1, 1)) { ink = true; break; }
          }
          var rightSide = false;
          for (var x2 = Math.round(r.w * 0.6); x2 < r.w; x2 += 4) {
            if (w.intersects(r.x + x2, midY, 1, 1)) { rightSide = true; break; }
          }
          res({ masked: true, rect: r.w + "x" + r.h, glyphInk: ink, rightEmpty: !rightSide });
        }, 2500);
      });
    })()
  `);
  console.log("PIXEL-TEXT:", JSON.stringify(pixel));

  // 3b. Forced overrides must escape the windows-don't-nest rule: an <em>
  //     INSIDE an accepted card still becomes a pixel surface.
  const nested = await tab.eval(`
    (function () {
      window.flock.destroy();
      window.flock = WebPenguins.start({ penguins: 2, pixel: ["#cardem"], debug: true });
      return new Promise(function (res) {
        setTimeout(function () {
          var w = window.__webpenguins.world;
          var em = document.getElementById("cardem");
          var r = em.getBoundingClientRect();
          var ex = r.left + scrollX, ey = r.top + scrollY;
          var hit = w.rects.filter(function (q) {
            return q.mask && Math.abs(q.x - ex) < 3 && Math.abs(q.y - ey) < 3;
          })[0];
          var cardStillSolid = w.rects.some(function (q) { return q.h === 71; });
          res({ emMasked: !!hit, cardStillSolid: cardStillSolid });
        }, 2500);
      });
    })()
  `);
  console.log("NESTED-PIXEL:", JSON.stringify(nested));

  // 4. Shift+click in dev mode toggles pixel-perfect and exports data-pixel.
  const shiftClick = await tab.eval(`
    (function () {
      window.flock.destroy();
      window.flock = WebPenguins.start({ penguins: 2, devMode: true, debug: true });
      return new Promise(function (res) {
        setTimeout(function () {
          var head = document.getElementById("inkhead");
          head.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: true }));
          setTimeout(function () {
            var panel = document.querySelector("[data-webpenguins-devpanel]");
            var snippet = panel ? panel.querySelector("[data-wp-snippet]").value : "";
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
            res({ snippet: snippet });
          }, 2000);
        }, 1200);
      });
    })()
  `);
  console.log("SHIFT-CLICK:", JSON.stringify(shiftClick));

  const ok =
    overrides.cardGone === true &&
    overrides.imgStays === true &&
    overrides.ghostSolid === true &&
    forcedChild.cardGone === true &&
    forcedChild.emSolid === true &&
    pixel.masked === true &&
    pixel.glyphInk === true &&
    pixel.rightEmpty === true &&
    nested.emMasked === true &&
    nested.cardStillSolid === true &&
    /data-pixel="#inkhead"/.test(shiftClick.snippet) &&
    overrides.imgStays === true &&
    overrides.ghostSolid === true &&
    dev.panel === true &&
    dev.ghostSolidAfterClick === true &&
    /data-solid="#ghost"/.test(dev.snippetAfterClick) &&
    /data-theme="Turtles"/.test(dev.snippetAfterClick) &&
    /data-penguins="3"/.test(dev.snippetAfterClick) &&
    /data-trees="2"/.test(dev.snippetAfterClick) &&
    dev.ghostSolidAfterSecond === false &&
    /data-ignore="#ghost"/.test(dev.snippetAfterSecond) &&
    dev.panelGoneAfterEsc === true &&
    dev.err === "none";
  console.log("DEV-CHECK:", ok ? "OK" : "FAIL");

  // screenshot with dev overlay on (fresh instance so the overlay is up)
  await tab.eval(
    'window.flock.destroy(); window.flock = WebPenguins.start({ penguins: 4, trees: 2, devMode: true, debug: true }); "ok"'
  );
  await sleep(2500);
  await tab.screenshot(path.join(scratch, "devmode.png"));
  tab.close();
  if (!ok) process.exitCode = 1;
} finally {
  proc.kill();
}
