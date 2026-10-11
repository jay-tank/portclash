"use strict";

// Launches a real, isolated VS Code window with PortClash loaded from this folder and runs
// test/vscode/index.js inside it three times: trusted (full suite + screenshot of the
// PortClash view), untrusted (workspace settings must not switch the live check on) and an
// empty workspace (empty state). The screenshot is saved as <tmpBaseDir>/portclash-panel.png.
// Usage: node test/run-vscode.js [tmpBaseDir]

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFileSync } = require("child_process");
const { write, makeMonorepo, makeEmpty } = require("./fixtures");

const extDir = path.resolve(__dirname, "..");
const base = fs.realpathSync(fs.mkdtempSync(path.join(process.argv[2] || os.tmpdir(), "pc-vscode-")));
const shot = path.join(process.argv[2] ? path.resolve(process.argv[2]) : base, "portclash-panel.png");

function buildWorkspace(tag, kind) {
  const d = path.join(base, tag);
  const root = path.join(d, "ws", "repo");
  const outsideDir = path.join(d, "outside");
  fs.mkdirSync(outsideDir, { recursive: true });
  if (kind === "empty") makeEmpty(root);
  else {
    makeMonorepo(root);
    // a symlinked compose file that leads out of the workspace must never be read
    write(outsideDir, "compose.yaml", 'services:\n  secret:\n    image: x\n    ports:\n      - "4444:4444"\n');
    fs.mkdirSync(path.join(root, "linked"), { recursive: true });
    fs.symlinkSync(path.join(outsideDir, "compose.yaml"), path.join(root, "linked", "compose.yaml"));
  }
  if (kind === "untrusted") {
    write(root, ".vscode/settings.json", JSON.stringify({ "portClash.checkListening": true }, null, 2));
  }
  const wsFile = path.join(d, "test.code-workspace");
  fs.writeFileSync(wsFile, JSON.stringify({ folders: [{ path: root }] }, null, 2));
  return { root, outsideDir, wsFile };
}

const userDir = path.join(base, "user");
const extsDir = path.join(base, "exts");
fs.mkdirSync(path.join(userDir, "User"), { recursive: true });
fs.mkdirSync(extsDir, { recursive: true });
const settingsPath = path.join(userDir, "User", "settings.json");
const resultFile = path.join(base, "results.json");
const cfgFile = path.join(base, "config.json");
const shotDir = path.join(base, "shots");
fs.mkdirSync(shotDir);

function writeSettings(trustEnabled) {
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({
      "security.workspace.trust.enabled": trustEnabled,
      "security.workspace.trust.startupPrompt": "never",
      "git.enabled": false,
      "extensions.autoUpdate": false,
      "telemetry.telemetryLevel": "off",
      "update.mode": "none",
      "workbench.startupEditor": "none",
      "workbench.tips.enabled": false,
    }, null, 2)
  );
}

async function launch(ws, mode, extraArgs) {
  fs.writeFileSync(cfgFile, JSON.stringify(Object.assign({ mode, resultFile, shotDir }, ws)));
  const args = [
    "--wait", "--new-window",
    "--user-data-dir", userDir,
    "--extensions-dir", extsDir,
    "--disable-extensions",
    ...extraArgs,
    "--skip-welcome", "--skip-release-notes",
    "--extensionDevelopmentPath=" + extDir,
    "--extensionTestsPath=" + path.join(__dirname, "vscode", "index.js"),
    ws.wsFile,
  ];
  console.log("code " + args.join(" "));
  const child = spawn("code", args, { stdio: "inherit", env: Object.assign({}, process.env, { PC_TEST_CONFIG: cfgFile }) });
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  const killer = setTimeout(() => child.kill("SIGKILL"), 300000);
  const poll = setInterval(() => {
    const want = path.join(shotDir, "shot-" + mode);
    if (!fs.existsSync(want)) return;
    fs.unlinkSync(want);
    try {
      execFileSync("import", ["-window", "root", "-display", process.env.DISPLAY || ":99", shot]);
      console.log("screenshot: " + shot);
    } catch (e) {
      console.log("screenshot failed: " + e.message);
    }
    fs.writeFileSync(path.join(shotDir, "shot-done-" + mode), "1");
  }, 300);
  const status = await exited;
  clearTimeout(killer);
  clearInterval(poll);
  console.log("code exit status:", status);
  if (!fs.existsSync(resultFile)) {
    console.log("FAIL: no results written");
    return { passed: 0, failed: 1, results: [] };
  }
  const res = JSON.parse(fs.readFileSync(resultFile, "utf8"));
  fs.unlinkSync(resultFile);
  for (const t of res.results) console.log((t.ok ? "PASS " : "FAIL ") + "[" + mode + "] " + t.name + (t.detail ? " :: " + t.detail : ""));
  return res;
}

(async () => {
  writeSettings(false);
  const r1 = await launch(buildWorkspace("run1", "trusted"), "trusted", ["--disable-workspace-trust"]);
  writeSettings(true);
  const r2 = await launch(buildWorkspace("run2", "untrusted"), "untrusted", []);
  writeSettings(false);
  const r3 = await launch(buildWorkspace("run3", "empty"), "empty", ["--disable-workspace-trust"]);
  const all = [r1, r2, r3];
  const passed = all.reduce((a, r) => a + r.passed, 0);
  const failed = all.reduce((a, r) => a + r.failed, 0);
  console.log(`\nin-editor tests: ${passed} passed, ${failed} failed (trusted ${r1.passed}/${r1.passed + r1.failed}, untrusted ${r2.passed}/${r2.passed + r2.failed}, empty ${r3.passed}/${r3.passed + r3.failed})`);
  if (!failed) fs.rmSync(base, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();
