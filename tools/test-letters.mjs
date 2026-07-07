// Deterministic pixel-collision check: drop penguins right above letters
// and confirm they land ON the glyphs, then screenshot the moment.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser, Tab, sleep } from "./cdp.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scratch = process.env.WP_SCRATCH || path.join(root, ".test");
const shots = process.argv[2] || scratch;

const { proc, port } = await launchBrowser(path.join(scratch, "edge-profile"));
try {
  const demoUrl = "file:///" + path.join(root, "demo", "index.html").replace(/\\/g, "/");
  const tab = await Tab.open(port, demoUrl);
  await sleep(1000);
  const report = await tab.eval(`
    (function () {
      document.getElementById('wordmark').scrollIntoView({block: 'center', behavior: 'instant'});
      window.flock.destroy();
      window.flock = WebPenguins.start({ penguins: 12, snow: 160, debug: true });
      return new Promise(function (res) {
        setTimeout(function () {
          var d = window.__webpenguins;
          var el = document.getElementById('wordmark');
          var r = el.getBoundingClientRect();
          var docX = r.left + scrollX, docY = r.top + scrollY;
          // drop six penguins spread across the word, just above the caps
          var m = d.manager;
          var drops = [70, 150, 230, 310, 390, 470];
          for (var i = 0; i < drops.length && i < m.penguinNumber; i++) {
            var t = m.toons[i];
            t.setPosition(Math.round(docX + drops[i]), Math.round(docY - 40));
            t.type = "faller";
            t.frame = 0;
            t.setAssociation(null);
            t.setVelocity(0, 3);
          }
          setTimeout(function () {
            var out = [];
            for (var i = 0; i < 6; i++) {
              var t = m.toons[i];
              var feet = t.y + t.data().height;
              out.push(t.type + " x" + t.x + " feet@" + (feet - docY) + "px-into-canvas");
            }
            res({ canvasTop: Math.round(docY), landed: out });
          }, 4000);
        }, 1200);
      });
    })()
  `);
  console.log(JSON.stringify(report, null, 1));
  await sleep(2500);
  await tab.screenshot(path.join(shots, "letters.png"));
  tab.close();
} finally {
  proc.kill();
}
