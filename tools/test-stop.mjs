// Verifies the graceful exit: flock.stop() should play the bomber sequence
// and then remove the canvas.
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
  await sleep(9000); // let them land and settle
  await tab.eval("window.flock.stop(); 'ok'");
  await sleep(600); // bombs mid-animation
  await tab.screenshot(path.join(shots, "exit.png"));
  const during = await tab.eval("!!document.querySelector('canvas[data-webpenguins]')");
  await sleep(4000);
  const after = await tab.eval("!!document.querySelector('canvas[data-webpenguins]')");
  console.log("canvas during exit:", during, "| canvas 4s after stop:", after);
  tab.close();
} finally {
  proc.kill();
}
