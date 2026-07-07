// For every toon: what is under its feet? Names the invisible platforms.
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
  await tab.eval(`
    document.getElementById('wordmark').scrollIntoView({block: 'center', behavior: 'instant'});
    window.flock.destroy();
    window.flock = WebPenguins.start({ penguins: 24, debug: true });
    'ok'
  `);
  await sleep(20000);
  const report = await tab.eval(`
    (function () {
      var d = window.__webpenguins;
      var w = d.world;
      var m = d.manager;
      var out = [];
      for (var i = 0; i < m.penguinNumber; i++) {
        var t = m.toons[i];
        if (!t.active) continue;
        var data = t.data();
        var feetY = t.y + data.height;
        var support = "none";
        if (feetY >= w.height) support = "floor";
        else if (w.glassActive() && Math.abs(feetY - w.glassY) < 1) support = "glass";
        else {
          for (var j = 0; j < w.rects.length; j++) {
            var r = w.rects[j];
            if (t.x < r.x + r.w && t.x + data.width > r.x && feetY < r.y + r.h && feetY + 1 > r.y) {
              support = r.x + "," + r.y + " " + r.w + "x" + r.h + (r.mask ? " MASK" : "");
              // does the mask actually agree?
              if (r.mask && !w.intersects(t.x, feetY, data.width, 1)) support += " (mask says NO)";
              break;
            }
          }
        }
        out.push(t.type + " @" + t.x + "," + t.y + " -> " + support);
      }
      return { scroll: Math.round(scrollY), glass: w.glassY, toons: out };
    })()
  `);
  console.log(JSON.stringify(report, null, 1));
  tab.close();
} finally {
  proc.kill();
}
