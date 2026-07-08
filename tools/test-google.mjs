// Verifies pixel collision on the real google.com logo SVG (local replica):
// the logo must get a mask, and penguins dropped over it must land ON the
// letterforms, not on the bounding box.
//
// demo/google-replica.html is git-ignored (it embeds Google's trademarked
// logo paths). Regenerate it by curling https://www.google.com/, extracting
// the <svg class="lnXdpd">…</svg> markup into a dark page, and loading
// dist/webpenguins.js with { debug: true }.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser, Tab, sleep } from "./cdp.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scratch = process.env.WP_SCRATCH || path.join(root, ".test");
const shots = process.argv[2] || scratch;

const { proc, port } = await launchBrowser(path.join(scratch, "edge-profile"));
try {
  const url = "file:///" + path.join(root, "demo", "google-replica.html").replace(/\\/g, "/");
  const tab = await Tab.open(port, url);
  await sleep(2500);
  const report = await tab.eval(`
    (function () {
      var d = window.__webpenguins;
      var w = d.world;
      var svg = document.querySelector("svg.lnXdpd");
      var r = svg.getBoundingClientRect();
      var docX = r.left + scrollX, docY = r.top + scrollY;
      // the search pill is rounded-rect masked now too — pin the logo by width
      var logoRect = w.rects.filter(function (q) { return q.mask && q.w === 272; })[0];
      // scanline through the letters (y=46 hits the round bowls of o/g/e)
      var line = "";
      for (var x = 0; x < 272; x += 8) line += w.intersects(docX + x, docY + 46, 1, 1) ? "#" : ".";
      // drop penguins across the logo, just above it
      var m = d.manager;
      var drops = [10, 50, 90, 130, 170, 210, 250];
      for (var i = 0; i < drops.length && i < m.penguinNumber; i++) {
        var t = m.toons[i];
        t.setPosition(Math.round(docX + drops[i] - 15), Math.round(docY - 45));
        t.type = "faller"; t.frame = 0;
        t.setAssociation(null);
        t.setVelocity(0, 3);
      }
      return new Promise(function (res) {
        setTimeout(function () {
          var out = [];
          for (var i = 0; i < drops.length && i < m.penguinNumber; i++) {
            var t = m.toons[i];
            out.push(t.type + " x" + (t.x - Math.round(docX)) + " feet@" + (t.y + t.data().height - Math.round(docY)));
          }
          res({
            logoMasked: !!logoRect,
            logoRect: logoRect ? logoRect.w + "x" + logoRect.h : null,
            scanlineY46: line,
            toons: out
          });
        }, 3500);
      });
    })()
  `);
  console.log(JSON.stringify(report, null, 1));
  await sleep(300);
  await tab.screenshot(path.join(shots, "google-replica.png"));
  tab.close();
} finally {
  proc.kill();
}
