// Loads the MV3 extension in headless Chromium/Edge and checks that the
// content script injects the overlay on an ordinary http page — and that
// developer mode brings up the in-page panel, whose edits land in
// storage.sync without touching the page's own storage.
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { Tab, findBrowser, sleep } from "./cdp.mjs";

/** Chromium's id for an unpacked extension: sha256(path), hex mapped to a-p. */
function unpackedId(dir) {
  const hex = crypto.createHash("sha256").update(path.resolve(dir)).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scratch = process.env.WP_SCRATCH || path.join(root, ".test");
const shots = process.argv[2] || scratch;

const PAGE = `<!DOCTYPE html><html><head><style>
  body { margin:0; font: 16px/1.6 sans-serif; background:#fafafa; color:#222; }
  main { max-width: 640px; margin: 0 auto; padding: 120px 20px 50vh; }
  .card { background:#fff; border:1px solid #ccc; border-radius:8px; padding:20px; margin:24px 0; box-shadow: 0 2px 8px rgba(0,0,0,.1); }
</style></head><body><main>
  <h1>A perfectly normal web page</h1>
  <div class="card">Nothing to see here. Certainly no penguins.</div>
  <p>Just regular content minding its own business.</p>
  <div class="card" style="height:100px">Another box.</div>
</main></body></html>`;

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(PAGE);
});
await new Promise((r) => server.listen(8123, "127.0.0.1", r));

const exe = findBrowser();
const profile = path.join(scratch, "edge-ext-profile");
fs.rmSync(profile, { recursive: true, force: true });
fs.mkdirSync(profile, { recursive: true });
const extPath = path.join(root, "extension");

const proc = spawn(
  exe,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--window-size=1100,800",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    `--load-extension=${extPath}`,
    "about:blank",
  ],
  { stdio: "ignore" }
);

try {
  const portFile = path.join(profile, "DevToolsActivePort");
  let port = 0;
  for (let i = 0; i < 100 && !port; i++) {
    await sleep(100);
    if (fs.existsSync(portFile)) port = Number(fs.readFileSync(portFile, "utf8").split(/\r?\n/)[0]);
  }
  if (!port) throw new Error("no devtools port");

  const tab = await Tab.open(port, "http://127.0.0.1:8123/");
  await sleep(8000);
  const status = await tab.eval(`
    (function () {
      var c = document.querySelector('canvas[data-webpenguins]');
      return {
        canvas: !!c,
        size: c ? c.width + "x" + c.height : null,
        global: typeof WebPenguins
      };
    })()
  `);
  console.log("EXTENSION STATUS:", JSON.stringify(status));
  await tab.screenshot(path.join(shots, "extension.png"));

  // Developer mode via storage (what the popup toggle writes).
  const popup = await Tab.open(port, `chrome-extension://${unpackedId(extPath)}/popup.html`);
  await sleep(500);
  await popup.eval(`new Promise((r) => chrome.storage.sync.set({ devMode: true }, () => r("ok")))`);
  await sleep(1500);
  const dev = await tab.eval(`
    (function () {
      var h = document.querySelector("[data-webpenguins-devpanel]");
      var r = h && h.shadowRoot;
      if (!r) return { panel: false };
      var fab = r.querySelector("[data-wp-fab]");
      if (!fab.hidden) fab.click();
      var theme = r.getElementById("wp-theme");
      theme.value = "Turtles";
      theme.dispatchEvent(new Event("change"));
      return {
        panel: true,
        pageStorage: Object.keys(localStorage).filter(function (k) { return /penguin/i.test(k); }),
        global: typeof WebPenguins
      };
    })()
  `);
  await sleep(1500);
  const stored = await popup.eval(
    `new Promise((r) => chrome.storage.sync.get(null, (s) => r({ theme: s.theme, devMode: s.devMode })))`
  );
  const after = await tab.eval(`
    (function () {
      var h = document.querySelector("[data-webpenguins-devpanel]");
      return {
        panel: !!h,
        theme: h ? h.shadowRoot.getElementById("wp-theme").value : null,
        snippet: h ? h.shadowRoot.querySelector("[data-wp-snippet]").value : ""
      };
    })()
  `);
  console.log("EXTENSION DEV:", JSON.stringify({ dev, stored, after }));
  await tab.screenshot(path.join(shots, "extension-dev.png"));
  const ok =
    status.canvas === true &&
    status.global === "undefined" &&
    dev.panel === true &&
    dev.pageStorage.length === 0 &&
    stored.theme === "Turtles" &&
    after.panel === true &&
    after.theme === "Turtles" &&
    /data-theme="Turtles"/.test(after.snippet);
  console.log("EXTENSION-CHECK:", ok ? "OK" : "FAIL");
  if (!ok) process.exitCode = 1;
  popup.close();
  tab.close();
} finally {
  proc.kill();
  server.close();
}
