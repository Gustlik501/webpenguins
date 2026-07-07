// Tiny Chrome DevTools Protocol client for testing the engine in a real
// headless browser (Node >= 22: global fetch + WebSocket, zero deps).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const EDGE_PATHS = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
];

export async function launchBrowser(userDataDir) {
  const exe = EDGE_PATHS.find((p) => fs.existsSync(p));
  if (!exe) throw new Error("No Edge/Chrome found");
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.rmSync(path.join(userDataDir, "DevToolsActivePort"), { force: true });
  const proc = spawn(
    exe,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--window-size=1280,900",
      "--remote-debugging-port=0",
      `--user-data-dir=${userDataDir}`,
      "about:blank",
    ],
    { stdio: "ignore" }
  );
  // The chosen port lands in DevToolsActivePort inside the profile dir.
  const portFile = path.join(userDataDir, "DevToolsActivePort");
  let port = 0;
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (fs.existsSync(portFile)) {
      const txt = fs.readFileSync(portFile, "utf8").trim().split(/\r?\n/)[0];
      port = Number(txt);
      if (port > 0) break;
    }
  }
  if (!port) {
    proc.kill();
    throw new Error("Browser did not report a DevTools port");
  }
  return { proc, port };
}

export class Tab {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }

  static async open(port, url) {
    const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, {
      method: "PUT",
    });
    const info = await res.json();
    const ws = new WebSocket(info.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
    return new Tab(ws);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Evaluate an expression, return its JSON value. */
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error("page exception: " + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
    }
    return r.result.value;
  }

  async screenshot(file) {
    const r = await this.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(file, Buffer.from(r.data, "base64"));
  }

  close() {
    this.ws.close();
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
