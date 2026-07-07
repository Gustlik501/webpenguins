// Screenshot the demo wordmark after penguins have had time to settle on it.
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
  // park the viewport on the wordmark section and give the flock time
  await tab.eval(`
    document.getElementById('wordmark').scrollIntoView({block: 'center', behavior: 'instant'});
    window.flock.destroy();
    window.flock = WebPenguins.start({ penguins: 24, trees: 3, snow: 200 });
    'ok'
  `);
  for (const t of [8, 14, 20, 45]) {
    await sleep((t === 8 ? 8 : t - [8, 14, 20, 45][[8, 14, 20, 45].indexOf(t) - 1]) * 1000);
    await tab.screenshot(path.join(shots, `wordmark-${t}s.png`));
  }
  tab.close();
} finally {
  proc.kill();
}
