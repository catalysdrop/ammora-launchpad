/**
 * Screenshot the production build served locally (vite preview).
 * Reuses the proven headless-Chromium + proxy-shim pattern from the
 * AgentEscrow demo (proxy-shim.js in the Aevum goal dir).
 *
 * Usage:
 *   npm run preview -- --port 4173 --strictPort   (in another shell)
 *   NODE_PATH=<aevum video node_modules> node scripts/shot-local.cjs [url]
 */
const { chromium } = require("playwright-core");
const { spawn } = require("child_process");
const path = require("path");

const SHIM = "/home/hatch/workspace/goals/aevum-builder-challenge-1-daftar-submit/hidden_files/video/proxy-shim.js";
const URL = process.argv[2] || "http://127.0.0.1:4173/";
const OUT = process.argv[3] || path.join(__dirname, "shots", "01-home.png");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startShim(port) {
  const shim = spawn(process.execPath, [SHIM, String(port)], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("proxy-shim did not start")), 15000);
    shim.stdout.on("data", (d) => {
      if (d.toString().includes("listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    shim.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error("proxy-shim exited with " + code));
    });
  });
  return shim;
}

(async () => {
  const shim = await startShim(18081);
  let browser;
  try {
    browser = await chromium.launch({
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--force-device-scale-factor=1",
        "--proxy-server=http://127.0.0.1:18081",
        "--ignore-certificate-errors",
      ],
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(`console: ${m.text()}`);
    });
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("requestfailed", (r) => errors.push(`reqfail: ${r.url()} ${r.failure()?.errorText}`));
    await page.goto(URL, { waitUntil: "networkidle", timeout: 60000 });
    await sleep(9000);
    const checks = {};
    for (const text of ["Ammora Launchpad", "Connect wallet", "Create a launch", "My launches", "How it works", "GIWA Sepolia"]) {
      checks[text] = (await page.locator(`text=${text}`).first().count()) > 0;
    }
    const badge = await page.locator(".deploy-badge").innerText().catch(() => "(badge missing)");
    console.log(JSON.stringify({ url: URL, checks, badge: badge.slice(0, 200), errors: errors.slice(0, 10) }, null, 2));
    await page.screenshot({ path: OUT });
    console.log("screenshot:", OUT);
    await browser.close();
    console.log("SHOT DONE");
  } finally {
    if (browser) await browser.close().catch(() => {});
    shim.kill();
  }
})().catch((e) => {
  console.error("SHOT FAILED:", e.message);
  process.exit(1);
});
