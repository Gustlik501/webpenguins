// Diagnose mask collision on the demo wordmark.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser, Tab, sleep } from "./cdp.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scratch = process.env.WP_SCRATCH || path.join(root, ".test");

const { proc, port } = await launchBrowser(path.join(scratch, "edge-profile"));
try {
  const demoUrl = "file:///" + path.join(root, "demo", "index.html").replace(/\\/g, "/");
  const tab = await Tab.open(port, demoUrl);
  await sleep(1000);
  const report = await tab.eval(`
    (function () {
      document.getElementById('wordmark').scrollIntoView({block: 'center', behavior: 'instant'});
      window.flock.destroy();
      window.flock = WebPenguins.start({ penguins: 10, debug: true });
      return new Promise(function (res) {
        setTimeout(function () {
          var d = window.__webpenguins;
          var el = document.getElementById('wordmark');
          var r = el.getBoundingClientRect();
          var docX = r.left + scrollX, docY = r.top + scrollY;
          var rects = d.world.rects.map(function (q) {
            return q.x + "," + q.y + " " + q.w + "x" + q.h + (q.mask ? " MASK(" + q.mask.w + "x" + q.mask.h + ")" : "");
          });
          // sample collisions across the wordmark: a horizontal line through
          // the letters (baseline-ish) and one above the caps
          var hits = "";
          for (var x = 0; x < 640; x += 32) {
            hits += d.world.intersects(docX + x, docY + 100, 1, 1) ? "#" : ".";
          }
          var above = "";
          for (var x2 = 0; x2 < 640; x2 += 32) {
            above += d.world.intersects(docX + x2, docY + 10, 1, 1) ? "#" : ".";
          }
          res({
            canvasDoc: Math.round(docX) + "," + Math.round(docY),
            scroll: Math.round(scrollY),
            glass: d.world.glassY,
            worldH: d.world.height,
            rectCount: d.world.rects.length,
            rects: rects,
            midLine: hits,
            aboveCaps: above
          });
        }, 1500);
      });
    })()
  `);
  console.log(JSON.stringify(report, null, 1));
  tab.close();
} finally {
  proc.kill();
}
