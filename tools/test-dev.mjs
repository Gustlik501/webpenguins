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

  const ok =
    overrides.cardGone === true &&
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
