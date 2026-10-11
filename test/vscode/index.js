"use strict";

// In-editor test, loaded by VS Code through --extensionTestsPath. Expects the workspace built
// by test/run-vscode.js and its JSON config in PC_TEST_CONFIG.

const vscode = require("vscode");
const fs = require("fs");
const net = require("net");
const path = require("path");

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail: cond ? undefined : String(detail) });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, label) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (_) { /* retry */ }
    await sleep(200);
  }
  throw new Error("timeout waiting for " + label);
}
const setCfg = (k, v) => vscode.workspace.getConfiguration("portClash").update(k, v, vscode.ConfigurationTarget.Global);
const pcDiags = (p) => vscode.languages.getDiagnostics(vscode.Uri.file(p)).filter((d) => d.source === "PortClash");
const labelOf = (i) => (typeof i.label === "string" ? i.label : i.label.label);
function listen(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(null));
    s.listen({ port, host: "127.0.0.1" }, () => resolve(s));
  });
}

async function run() {
  const cfg = JSON.parse(fs.readFileSync(process.env.PC_TEST_CONFIG, "utf8"));
  const { mode, root, outsideDir, resultFile, shotDir } = cfg;
  const log = { infos: [], warns: [] };
  try {
    const ext = vscode.extensions.getExtension("jaytankdev.portclash");
    const api = ext.isActive ? ext.exports : await ext.activate();
    api.setUi({ info: async (m) => (log.infos.push(m), undefined), warn: async (m) => (log.warns.push(m), undefined) });
    await api.ready;
    const pkg = ext.packageJSON;

    if (mode === "empty") {
      await vscode.commands.executeCommand("workbench.view.extension.portclash");
      await api.rescan();
      check("empty: no rows", api.getTreeItems().length === 0, api.getTreeItems().map(labelOf).join(","));
      check("empty: no badge", api.getBadge() === 0, api.getBadge());
      check("empty: status reports 0 ports", /Ports: 0 · 0 clashes/.test(api.getStatusText()), api.getStatusText());
      const welcomes = pkg.contributes.viewsWelcome.filter((w) => w.view === "portClash.ports");
      check("empty: welcome says what it looks for and has a Refresh button", welcomes.some((w) => /config\.portClash\.enabled && isWorkspaceTrusted/.test(w.when) && /docker compose/.test(w.contents) && /command:portClash\.refresh/.test(w.contents)));
      const pm = await vscode.commands.executeCommand("portClash.showPortMap");
      check("empty: Show Port Map explains there is nothing", pm && pm.status === "empty" && /no declared ports/.test(log.infos.join(" ")), JSON.stringify(pm));
      return;
    }

    const expectedTop = ["PC001  3000/tcp", "PC001  5432/tcp", "PC002  5000/tcp", "PC004  3000/tcp"];

    if (mode === "untrusted") {
      check("untrusted: workspace is not trusted", !vscode.workspace.isTrusted);
      const held = await listen(5174);
      await vscode.commands.executeCommand("portClash.refresh");
      check("untrusted: rows still listed (read-only scan)", expectedTop.every((l) => api.getTreeItems().some((i) => labelOf(i) === l)), api.getTreeItems().map(labelOf).join(" | "));
      check("untrusted: badge = 2 clashes", api.getBadge() === 2, api.getBadge());
      check("untrusted: workspace checkListening=true is ignored (no live check)", api.getLive() === null && !api.getFindings().some((f) => f.code === "PC005"), JSON.stringify(api.getLive()));
      check("untrusted: status has no 'in use'", !/in use/.test(api.getStatusText()), api.getStatusText());
      const child = api.getChildItems("PC001  3000/tcp")[0];
      const o = child && (await vscode.commands.executeCommand(child.command.command, ...child.command.arguments));
      check("untrusted: row click opens the file", o && o.status === "opened", JSON.stringify(o));
      const welcomes = pkg.contributes.viewsWelcome.filter((w) => w.view === "portClash.ports");
      check("untrusted: untrusted empty state with Manage Workspace Trust", welcomes.some((w) => /!isWorkspaceTrusted/.test(w.when) && /workbench\.trust\.manage/.test(w.contents)));
      if (held) await new Promise((r) => held.close(r));
      return;
    }

    // ---------------- trusted ----------------
    check("workspace is trusted", vscode.workspace.isTrusted);
    // container + icon
    const container = (pkg.contributes.viewsContainers.activitybar || []).find((c) => c.id === "portclash");
    check("activity bar container 'portclash' contributed", container && container.title === "PortClash" && container.icon === "media/activity.svg");
    check("activity icon exists", fs.existsSync(path.join(ext.extensionPath, "media", "activity.svg")));
    check("view portClash.ports moved into the container (not Explorer)", (pkg.contributes.views.portclash || []).some((v) => v.id === "portClash.ports") && !pkg.contributes.views.explorer);
    check("onView activation", pkg.activationEvents.includes("onView:portClash.ports"));
    await vscode.commands.executeCommand("workbench.view.extension.portclash");
    await waitFor(() => api.isViewVisible(), 10000, "view visible").catch(() => {});
    check("view opens", api.isViewVisible());

    // rows
    await waitFor(() => api.getTreeItems().length >= 4, 20000, "rows");
    const top = api.getTreeItems();
    const labels = top.map(labelOf);
    check("rows: clashes first, labelled with code + exact port", expectedTop.every((l, i) => labels[i] === l), labels.join(" | "));
    check("rows: plain ports and scopes listed", labels.includes("6379/tcp") && labels.includes("5174/tcp") && labels.includes("3000/tcp (.env)"), labels.join(" | "));
    check("rows: no source read through the symlink that leaves the workspace", !labels.some((l) => /4444/.test(l)) && !api.getModel().sources.some((s) => /linked/.test(s.file)), labels.join(" | "));
    const r3000 = top[0];
    check("row description names rule and owners", r3000.description === "port clash: next dev (apps/web/package.json), next start (apps/web/package.json), service api (compose.yaml)", r3000.description);
    check("row icon is the error codicon", r3000.iconPath && r3000.iconPath.id === "error");
    check("clash row context enables the inline action", r3000.contextValue === "portClashClash");
    const kids = api.getChildItems("PC001  3000/tcp");
    check("children name the exact sources", kids.length === 3 && kids.some((k) => labelOf(k) === 'compose.yaml service api ports "${API_PORT:-8080}:8080"') && kids.some((k) => /next dev, default port/.test(labelOf(k))), kids.map(labelOf).join(" | "));
    check("children description is file:line", kids.some((k) => k.description === "compose.yaml:5"), kids.map((k) => k.description).join(","));
    check("badge = clashes = 2", api.getBadge() === 2 && api.getModel().clashCount === 2, api.getBadge());
    check("status bar text", api.getStatusText() === "$(plug) Ports: 5 · 2 clashes", api.getStatusText());
    check("diagnostics published (PC001 on compose.yaml)", pcDiags(path.join(root, "compose.yaml")).some((d) => d.code === "PC001"));

    // menus
    const menus = pkg.contributes.menus;
    check("view/title buttons: find free, port map, refresh", ["portClash.findFreePort", "portClash.showPortMap", "portClash.refresh"].every((c) => menus["view/title"].some((m) => m.command === c && /portClash\.ports/.test(m.when))));
    check("inline Find Free Port on host port rows", menus["view/item/context"].some((m) => m.command === "portClash.findFreePort" && m.group === "inline"));
    const welcomes = pkg.contributes.viewsWelcome.filter((w) => w.view === "portClash.ports");
    check("welcome states: turned off, empty, untrusted", welcomes.length === 3 && welcomes.some((w) => w.when === "!config.portClash.enabled"));

    // open command: real rows open the right file/line
    const kid = kids.find((k) => k.description === "compose.yaml:5");
    const o1 = await vscode.commands.executeCommand(kid.command.command, ...kid.command.arguments);
    const ed = vscode.window.activeTextEditor;
    check("row click opens compose.yaml at line 5", o1 && o1.status === "opened" && ed && ed.document.uri.fsPath === path.join(root, "compose.yaml") && ed.selection.active.line === 4, JSON.stringify(o1));
    const f4 = top[3];
    const o2 = await vscode.commands.executeCommand(f4.command.command, ...f4.command.arguments);
    check("PC004 row opens apps/api/src/index.js line 2", o2 && o2.status === "opened" && vscode.window.activeTextEditor.document.uri.fsPath === path.join(root, "apps/api/src/index.js") && vscode.window.activeTextEditor.selection.active.line === 1, JSON.stringify(o2));
    // forged / outside arguments
    const forged = [
      [{ type: "source", s: { file: path.join(outsideDir, "compose.yaml"), line: 0 } }],
      [path.join(outsideDir, "compose.yaml"), 0],
      ["/etc/passwd", 0],
      [{ file: path.join(root, "linked", "compose.yaml"), line: 4 }],
      [{ type: "source", s: { file: path.join(root, "compose.yaml"), line: 999 } }],
      [{ file: path.join(root, "compose.yaml") }],
      [undefined],
      ["../../outside/compose.yaml", 0],
    ];
    const fr = [];
    for (const args of forged) fr.push(await vscode.commands.executeCommand("portClash.openSource", ...args));
    check("open command rejects forged/outside/stale args", fr.every((r) => r && r.status !== "opened"), JSON.stringify(fr));
    check("nothing outside the workspace was opened", !vscode.workspace.textDocuments.some((d) => d.uri.fsPath.startsWith(outsideDir) || d.uri.fsPath === "/etc/passwd"));

    // inline action: Find Free Port on the 3000 row
    const el = api.getTopElements()[0];
    const ff = await vscode.commands.executeCommand("portClash.findFreePort", el);
    check("inline Find Free Port uses the row's port (no picker)", ff && ff.status === "found" && ff.port > 3000 && ff.port !== 5000 && /is free on this machine/.test(log.infos.join(" ")), JSON.stringify(ff));
    const ffPriv = await vscode.commands.executeCommand("portClash.findFreePort", 80);
    check("Find Free Port near 80 suggests >= 1024", ffPriv && ffPriv.status === "found" && ffPriv.port >= 1024, JSON.stringify(ffPriv));

    // port map
    const pm = await vscode.commands.executeCommand("portClash.showPortMap");
    check("Show Port Map opens the Markdown map", pm && pm.status === "opened" && /5 host ports declared, 2 clashes/.test(pm.content), JSON.stringify(pm && pm.status));

    // save path (watchers may not fire on this machine): edit .env in the editor and save
    const envPath = path.join(root, ".env");
    const doc = await vscode.workspace.openTextDocument(envPath);
    await vscode.window.showTextDocument(doc);
    const we = new vscode.WorkspaceEdit();
    we.replace(doc.uri, new vscode.Range(0, 0, 0, doc.lineAt(0).text.length), "API_PORT=3010");
    await vscode.workspace.applyEdit(we);
    await doc.save();
    await waitFor(() => api.getBadge() === 1, 15000, "badge after save").catch(() => {});
    check("saving .env (API_PORT=3010) rescans: 3000 clash gone, badge 1", api.getBadge() === 1 && !api.getTreeItems().some((i) => labelOf(i) === "PC001  3000/tcp") && api.getStatusText() === "$(plug) Ports: 6 · 1 clash", api.getBadge() + " " + api.getStatusText());
    // file changed on disk (no editor) + explicit refresh
    fs.writeFileSync(envPath, "API_PORT=3000\nDB_PORT=5432\n");
    await vscode.commands.executeCommand("portClash.refresh");
    await waitFor(() => api.getBadge() === 2, 10000, "badge after refresh").catch(() => {});
    check("disk change + refresh brings the clash back", api.getBadge() === 2, api.getBadge());
    // concurrent rescans never overlap and settle on the latest state
    await Promise.all([api.rescan(), api.rescan(), api.rescan()]);
    check("concurrent rescans settle", api.getBadge() === 2 && api.getTreeItems().length === top.length);

    check("polling fallback runs while the window is focused", !vscode.window.state.focused || api.isPolling(), vscode.window.state.focused);

    // live check (opt-in) with a real listener on the declared vite port
    const held = await listen(5174);
    await setCfg("checkListening", true);
    await vscode.commands.executeCommand("portClash.refresh");
    await waitFor(() => api.getFindings().some((f) => f.code === "PC005"), 10000, "PC005").catch(() => {});
    check("checkListening: PC005 for 5174 held by another socket", !held || api.getFindings().some((f) => f.code === "PC005" && f.port === 5174), JSON.stringify(api.getLive() && [...api.getLive().inUse]));
    check("checkListening: status shows in use", !held || /in use/.test(api.getStatusText()), api.getStatusText());
    check("checkListening: row labelled PC005", !held || api.getTreeItems().some((i) => labelOf(i) === "PC005  5174/tcp"), api.getTreeItems().map(labelOf).join(" | "));
    if (held) await new Promise((r) => held.close(r));
    await setCfg("checkListening", undefined);
    await vscode.commands.executeCommand("portClash.refresh");
    await waitFor(() => !api.getFindings().some((f) => f.code === "PC005"), 10000, "PC005 gone").catch(() => {});
    check("checkListening off again: no PC005", !api.getFindings().some((f) => f.code === "PC005"));

    // screenshot with findings present
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await vscode.commands.executeCommand("workbench.view.extension.portclash");
    await sleep(6000);
    fs.writeFileSync(path.join(shotDir, "shot-trusted"), "1");
    await waitFor(() => fs.existsSync(path.join(shotDir, "shot-done-trusted")), 20000, "screenshot").catch(() => {});
    check("screenshot taken", fs.existsSync(path.join(shotDir, "shot-done-trusted")));

    // turned off
    await setCfg("enabled", false);
    await waitFor(() => api.getTreeItems().length === 0 && api.getBadge() === 0, 10000, "disabled").catch(() => {});
    check("turned off: view empty, badge cleared, diagnostics cleared", api.getTreeItems().length === 0 && api.getBadge() === 0 && pcDiags(path.join(root, "compose.yaml")).length === 0);
    await setCfg("enabled", true);
    await waitFor(() => api.getBadge() === 2, 15000, "re-enabled").catch(() => {});
    check("turned on again: rows and badge back", api.getBadge() === 2 && api.getTreeItems().length === top.length, api.getBadge());
  } catch (e) {
    check("unexpected exception", false, String(e && e.stack ? e.stack : e));
  } finally {
    for (const k of ["checkListening", "enabled"]) {
      try {
        await setCfg(k, undefined);
      } catch (_) { /* ignore */ }
    }
    const passed = results.filter((r) => r.ok).length;
    fs.writeFileSync(resultFile, JSON.stringify({ passed, failed: results.length - passed, results }, null, 2));
  }
}

module.exports = { run };
