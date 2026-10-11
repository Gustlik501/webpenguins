// Developer mode + overrides: option-level overrides must add/remove
// surfaces; the dev panel must exist; clicking an element must cycle its
// override; the export snippet must carry settings + overrides; the panel's
// settings must apply (rebuilding where needed), collapse to its penguin
// icon, bomb + revive, close, and come up from a data-dev script tag.
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
  // The panel lives in an open shadow root; expand() undoes a collapse
  // remembered from an earlier step (the panel keeps that across starts).
  await tab.eval(`
    window.__wp = function () {
      var h = document.querySelector("[data-webpenguins-devpanel]");
      return h && h.shadowRoot;
    };
    window.__wpExpand = function () {
      var r = window.__wp();
      var fab = r && r.querySelector("[data-wp-fab]");
      if (fab && !fab.hidden) fab.click();
    };
    "ok"
  `);

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
          window.__wpExpand();
          var panel = window.__wp();
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
              // Esc collapses the panel to its penguin and stops picking
              window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
              setTimeout(function () {
                click(); // must NOT cycle the override any more
                var r = window.__wp();
                res({
                  panel: !!panel,
                  ghostSolidAfterClick: afterFirst,
                  snippetAfterClick: snippet1,
                  ghostSolidAfterSecond: rects2.some(function (r) { return r.w === 400 && r.h === 60; }),
                  snippetAfterSecond: snippet2,
                  collapsedAfterEsc: !!r && r.querySelector("[data-wp-card]").hidden &&
                    !r.querySelector("[data-wp-fab]").hidden,
                  pickingOffAfterEsc: /data-ignore="#ghost"/.test(r.querySelector("[data-wp-snippet]").value),
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
          window.__wpExpand();
          var head = document.getElementById("inkhead");
          head.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: true }));
          setTimeout(function () {
            var panel = window.__wp();
            var snippet = panel ? panel.querySelector("[data-wp-snippet]").value : "";
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
            res({ snippet: snippet });
          }, 2000);
        }, 1200);
      });
    })()
  `);
  console.log("SHIFT-CLICK:", JSON.stringify(shiftClick));

  // 5. The panel's settings: pinned bottom-right, live penguin count (only
  //    persisted on release), a theme change rebuilds the engine and is
  //    persisted, collapse/expand toggles the overlay, bomb -> revive.
  const panelUi = await tab.eval(`
    (function () {
      window.flock.destroy();
      window.__saved = [];
      window.__exited = false;
      window.flock = WebPenguins.start({
        penguins: 3, devMode: true, debug: true,
        onSettingsChange: function (p) { window.__saved.push(p); },
        onDevModeExit: function () { window.__exited = true; }
      });
      var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
      var out = {};
      return wait(1200).then(function () {
        window.__wpExpand();
        var r = window.__wp();
        var card = r.querySelector("[data-wp-card]").getBoundingClientRect();
        // clientWidth/Height: the viewport minus scrollbars, like position:fixed
        var de = document.documentElement;
        out.pinnedRight = Math.abs(de.clientWidth - card.right - 16) <= 1;
        out.pinnedBottom = Math.abs(de.clientHeight - card.bottom - 16) <= 1;
        out.pinnedAt = [Math.round(card.right), Math.round(card.bottom), de.clientWidth, de.clientHeight];
        out.themeOptions = r.getElementById("wp-theme").options.length;

        var slider = r.getElementById("wp-penguins");
        slider.value = "7";
        slider.dispatchEvent(new Event("input"));
        out.savedBeforeRelease = window.__saved.length;
        return wait(100).then(function () {
        out.liveCount = window.__webpenguins.manager.penguinNumber;
        slider.dispatchEvent(new Event("change"));
        out.savedAfterRelease = JSON.stringify(window.__saved);

        var before = window.__webpenguins.engine;
        var theme = r.getElementById("wp-theme");
        theme.value = "Turtles";
        theme.dispatchEvent(new Event("change"));
        return wait(1200).then(function () {
          out.rebuilt = window.__webpenguins.engine !== before;
          out.overlayAfterRebuild = !!window.__webpenguins.engine.dev;
          out.penguinsAfterRebuild = window.__webpenguins.manager.penguinNumber;
          out.snippet = r.querySelector("[data-wp-snippet]").value;
          out.savedTheme = JSON.stringify(window.__saved[window.__saved.length - 1]);

          r.querySelector("[data-wp-collapse]").click();
          out.overlayOffCollapsed = !window.__webpenguins.engine.dev;
          out.fabShown = !r.querySelector("[data-wp-fab]").hidden;
          out.fabIconDrawn = (function () {
            var c = r.querySelector("[data-wp-fab] canvas");
            var d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
            for (var i = 3; i < d.length; i += 4) if (d[i] > 0) return true;
            return false;
          })();
          r.querySelector("[data-wp-fab]").click();
          out.overlayBackExpanded = !!window.__webpenguins.engine.dev;

          r.querySelector("[data-wp-bomb]").click();
          out.bombLabel = r.querySelector("[data-wp-bomb]").textContent;
          return wait(9000);
        }).then(function () {
          var bomb = r.querySelector("[data-wp-bomb]");
          out.afterBombLabel = bomb.textContent;
          out.panelSurvivedBomb = !!window.__wp();
          var dead = window.__webpenguins.engine;
          bomb.click(); // bring them back
          return wait(1200).then(function () {
            out.revived = window.__webpenguins.engine !== dead &&
              window.__webpenguins.manager.penguinNumber === 7;
            r.querySelector("[data-wp-close]").click();
            out.closed = !document.querySelector("[data-webpenguins-devpanel]") && window.__exited;
            out.overlayOffClosed = !window.__webpenguins.engine.dev;
            out.err = window.__webpenguins.engine.lastError || "none";
            return out;
          });
        });
        });
      });
    })()
  `);
  console.log("PANEL-UI:", JSON.stringify(panelUi, null, 1));

  // 6. Embedding with data-dev on the script tag: the panel comes up with
  //    no extension, and the snippet points at the same file, minus data-dev.
  const embed = await tab.eval(`
    (function () {
      window.flock.destroy();
      var s = document.createElement("script");
      s.src = "../dist/webpenguins.js";
      s.setAttribute("data-auto", "");
      s.setAttribute("data-dev", "");
      s.setAttribute("data-penguins", "5");
      s.setAttribute("data-trees", "1");
      document.body.appendChild(s);
      return new Promise(function (res) {
        setTimeout(function () {
          window.__wpExpand();
          var r = window.__wp();
          res({
            panel: !!r,
            snippet: r ? r.querySelector("[data-wp-snippet]").value : ""
          });
        }, 2000);
      });
    })()
  `);
  console.log("EMBED-DEV:", JSON.stringify(embed));

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
    dev.collapsedAfterEsc === true &&
    dev.pickingOffAfterEsc === true &&
    panelUi.pinnedRight === true &&
    panelUi.pinnedBottom === true &&
    panelUi.themeOptions >= 5 &&
    panelUi.liveCount === 7 &&
    panelUi.savedBeforeRelease === 0 &&
    panelUi.savedAfterRelease === '[{"penguins":7}]' &&
    panelUi.rebuilt === true &&
    panelUi.overlayAfterRebuild === true &&
    panelUi.penguinsAfterRebuild === 7 &&
    /data-theme="Turtles"/.test(panelUi.snippet) &&
    /data-penguins="7"/.test(panelUi.snippet) &&
    panelUi.savedTheme === '{"theme":"Turtles"}' &&
    panelUi.overlayOffCollapsed === true &&
    panelUi.fabShown === true &&
    panelUi.fabIconDrawn === true &&
    panelUi.overlayBackExpanded === true &&
    /Bombs away/.test(panelUi.bombLabel) &&
    /Bring them back/.test(panelUi.afterBombLabel) &&
    panelUi.panelSurvivedBomb === true &&
    panelUi.revived === true &&
    panelUi.closed === true &&
    panelUi.overlayOffClosed === true &&
    panelUi.err === "none" &&
    embed.panel === true &&
    /^<script src="\.\.\/dist\/webpenguins\.js" data-auto data-penguins="5" data-trees="1"><\/script>$/.test(embed.snippet) &&
    dev.err === "none";
  console.log("DEV-CHECK:", ok ? "OK" : "FAIL");

  // screenshot with dev overlay on (fresh instance so the overlay is up)
  await tab.eval(
    'window.flock.destroy(); window.flock = WebPenguins.start({ penguins: 4, trees: 2, devMode: true, debug: true }); "ok"'
  );
  await sleep(2500);
  await tab.eval('window.__wpExpand(); "ok"');
  await sleep(300);
  await tab.screenshot(path.join(scratch, "devmode.png"));
  await tab.eval('window.__wp().querySelector("[data-wp-collapse]").click(); "ok"');
  await sleep(300);
  await tab.screenshot(path.join(scratch, "devmode-collapsed.png"));
  tab.close();
  if (!ok) process.exitCode = 1;
} finally {
  proc.kill();
}
