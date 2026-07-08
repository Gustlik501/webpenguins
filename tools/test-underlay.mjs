// Verifies surface decisions on the "underlay canvas" page pattern
// (google.com dark mode): page background painted by a non-ancestor fixed
// div. A box matching that canvas color must be invisible to the scanner,
// the visible pill inside it must be solid, transparent hit-test overlays
// must not occlude, and genuinely covered boxes must stay occluded.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser, Tab, sleep } from "./cdp.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scratch = process.env.WP_SCRATCH || path.join(root, ".test");

const { proc, port } = await launchBrowser(path.join(scratch, "edge-profile"));
try {
  const url = "file:///" + path.join(root, "demo", "underlay.html").replace(/\\/g, "/");
  const tab = await Tab.open(port, url);
  await sleep(2000);
  const report = await tab.eval(`
    (function () {
      var d = window.__webpenguins;
      var byId = function (id) { return document.getElementById(id); };
      var ex = function (id) {
        var r = d.explain(byId(id));
        return { solid: r.solid, because: r.because || null, backdrop: r.backdrop, canvas: r.pageCanvas };
      };
      return {
        phantom: ex("phantom"),
        pill: ex("pill"),
        scrim: ex("scrim"),
        buried: ex("buried"),
        banner: ex("banner"),
        rects: d.world.rects.map(function (r) {
          return r.w + "x" + r.h + (r.mask ? " MASK" : "");
        })
      };
    })()
  `);
  console.log(JSON.stringify(report, null, 1));

  const ok =
    report.phantom.solid === false &&
    report.pill.solid === true &&
    report.scrim.solid === false &&
    report.buried.solid === false &&
    /covered/.test(report.buried.because || "") &&
    report.banner.solid === true &&
    !report.rects.some((r) => r.startsWith("660x")) && // phantom's box
    report.rects.some((r) => r.startsWith("602x") && r.includes("MASK")); // the pill (border-box)
  console.log("UNDERLAY-CHECK:", ok ? "OK" : "FAIL");
  await tab.screenshot(path.join(scratch, "underlay.png"));
  tab.close();
  if (!ok) process.exitCode = 1;
} finally {
  proc.kill();
}
