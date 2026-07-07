// Behavioural smoke test: drive the demo/probe pages in a real headless
// browser, let the engine run in real time, inspect state, take screenshots.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser, Tab, sleep } from "./cdp.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scratch = process.env.WP_SCRATCH || path.join(root, ".test");
const shots = process.argv[3] || scratch;

const { proc, port } = await launchBrowser(path.join(scratch, "edge-profile"));
try {
  const probeUrl = "file:///" + path.join(root, "demo", "probe.html").replace(/\\/g, "/");
  const demoUrl = "file:///" + path.join(root, "demo", "index.html").replace(/\\/g, "/");
  const seconds = Number(process.argv[2] || 12);

  // ---- probe: engine state sanity ----
  const probe = await Tab.open(port, probeUrl);
  await sleep(1500);
  const early = await probe.eval("document.getElementById('out').textContent");
  console.log("EARLY:", early);
  // Pixel-mask collision: the stones canvas must collide only where drawn.
  const maskCheck = await probe.eval(`
    (function () {
      var w = window.__webpenguins.world;
      var r = w.rects.filter(function (x) { return x.mask; })[0];
      if (!r) return "NO-MASKED-RECT";
      return {
        rect: r.x + "," + r.y + " " + r.w + "x" + r.h,
        solidLeftStone: w.intersects(r.x + 60, r.y + 70, 1, 1),
        gapBetween: w.intersects(r.x + 200, r.y + 70, 1, 1),
        solidRightStone: w.intersects(r.x + 340, r.y + 70, 1, 1),
        airAboveStones: w.intersects(r.x + 60, r.y + 10, 1, 1)
      };
    })()
  `);
  console.log("MASK-CHECK:", JSON.stringify(maskCheck));

  // Inline-SVG mask (the google.com logo case): vector-rasterized shapes.
  const svgCheck = await probe.eval(`
    (function () {
      var w = window.__webpenguins.world;
      var r = w.rects.filter(function (x) { return x.mask && x.w === 300; })[0];
      if (!r) return "NO-SVG-MASK";
      return {
        rect: r.x + "," + r.y + " " + r.w + "x" + r.h,
        solidBar: w.intersects(r.x + 60, r.y + 50, 1, 1),
        gapBetween: w.intersects(r.x + 165, r.y + 50, 1, 1),
        solidCircle: w.intersects(r.x + 240, r.y + 50, 1, 1),
        airAboveBar: w.intersects(r.x + 60, r.y + 10, 1, 1)
      };
    })()
  `);
  console.log("SVG-MASK-CHECK:", JSON.stringify(svgCheck));

  await sleep(seconds * 1000);
  const late = await probe.eval("document.getElementById('out').textContent");
  console.log("LATE :", late);

  // Scrolling must be a pure camera move: same rects, nobody dies.
  const statesBefore = await probe.eval(
    "window.__webpenguins.manager.toons.slice(0, window.__webpenguins.manager.penguinNumber).map(function(p){return p.type;})"
  );
  await probe.eval("window.scrollTo({top: 400, behavior: 'instant'}); 'ok'");
  await sleep(500);
  const statesAfter = await probe.eval(
    "window.__webpenguins.manager.toons.slice(0, window.__webpenguins.manager.penguinNumber).map(function(p){return p.type;})"
  );
  const deaths = ["explosion", "zapped", "squashed", "angel", "splatted"];
  const beforeDeaths = statesBefore.filter((t) => deaths.includes(t)).length;
  const afterDeaths = statesAfter.filter((t) => deaths.includes(t)).length;
  console.log(
    "SCROLL-SAFETY:",
    afterDeaths <= beforeDeaths ? "OK" : "FAIL",
    "| before:",
    statesBefore.join(","),
    "| after:",
    statesAfter.join(",")
  );
  console.log("SCROLLED:", await probe.eval("document.getElementById('out').textContent"));
  await probe.screenshot(path.join(shots, "probe.png"));
  probe.close();

  // ---- demo: rect audit + the pretty screenshot ----
  const demo = await Tab.open(port, demoUrl);
  await sleep(1000);
  const rects = await demo.eval(`
    (function () {
      window.flock.destroy();
      window.flock = WebPenguins.start({ penguins: 8, trees: 3, debug: true });
      return new Promise(function (res) {
        setTimeout(function () {
          res(window.__webpenguins.world.rects.map(function (r) {
            return r.x + "," + r.y + " " + r.w + "x" + r.h;
          }));
        }, 500);
      });
    })()
  `);
  console.log("DEMO RECTS:", JSON.stringify(rects));
  await sleep(seconds * 1000);
  await demo.screenshot(path.join(shots, "demo.png"));
  // the page bottom: desktop floor, trees, snowline
  await demo.eval("window.scrollTo({top: 1e9, behavior: 'instant'}); 'ok'");
  await sleep(5000);
  await demo.screenshot(path.join(shots, "demo-bottom.png"));
  demo.close();
  console.log("screenshots written to", shots);
} finally {
  proc.kill();
}
