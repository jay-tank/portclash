"use strict";

// Plain Node unit test of PortClash's scanner, view rows, live check and listen probe.
// Run: node test/unit.test.js

const fs = require("fs");
const os = require("os");
const net = require("net");
const path = require("path");
const { EventEmitter } = require("events");
const X = require("../extension")._internals;
const { write, makeMonorepo } = require("./fixtures");

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log("PASS " + name);
  } else {
    fail++;
    console.log("FAIL " + name + (detail !== undefined ? " :: " + detail : ""));
  }
}

function walk(d) {
  return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
}
function modelOf(root, cfg) {
  const files = walk(root)
    .map((abs) => ({ abs, rel: path.relative(root, abs).split(path.sep).join("/"), root, text: fs.readFileSync(abs, "utf8") }))
    .filter((f) => X.classifyFile(f.rel));
  return X.buildModel(files, cfg || {});
}
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pc-unit-")));
const codes = (m) => m.findings.map((f) => f.code).sort().join(",");

/** A port that is free right now on 127.0.0.1 (asks the OS, then releases it). */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen({ port: 0, host: "127.0.0.1" }, () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}
function listenOn(port) {
  return new Promise((resolve, reject) => {
    const s = net.createServer((c) => {
      c.on("error", () => {});
      c.end("holder");
    });
    s.once("error", reject);
    s.listen({ port, host: "127.0.0.1" }, () => resolve(s));
  });
}
function connectReads(port) {
  return new Promise((resolve) => {
    const c = net.connect({ port, host: "127.0.0.1" });
    let data = "";
    c.on("data", (d) => (data += d));
    c.on("end", () => resolve(data));
    c.on("error", () => resolve("error"));
  });
}

/** Fake net module that records every server and lets the test drive its events. */
function fakeNet(behaviour) {
  const servers = [];
  return {
    servers,
    createServer() {
      const srv = new EventEmitter();
      srv.closeCalls = 0;
      srv.listenCalls = 0;
      srv.unref = () => {};
      srv.close = (cb) => {
        srv.closeCalls++;
        if (cb) setImmediate(cb);
      };
      srv.listen = (opts) => {
        srv.listenCalls++;
        srv.opts = opts;
        behaviour(srv);
      };
      servers.push(srv);
      return srv;
    },
  };
}

(async () => {
  // ---- model on the article's monorepo ----
  const root = makeMonorepo(tmp());
  const m = modelOf(root);
  check("monorepo: PC001 x5, PC002, PC003 x2, PC004", codes(m) === "PC001,PC001,PC001,PC001,PC001,PC002,PC003,PC003,PC004", codes(m));
  check("monorepo: 2 clashes, 5 host ports", m.clashCount === 2 && m.hostBindCount === 5, m.clashCount + "/" + m.hostBindCount);
  check("status text matches README/blog format", X.statusText(m, null) === "$(plug) Ports: 5 · 2 clashes", X.statusText(m, null));
  check("status text: blog example 'Ports: 9 · 1 clash'", X.statusText({ hostBindCount: 9, clashCount: 1 }, null) === "$(plug) Ports: 9 · 1 clash");
  check("status text with live check", X.statusText({ hostBindCount: 2, clashCount: 0 }, { inUse: new Map([[3000, "x"]]) }) === "$(plug) Ports: 2 · 0 clashes · 1 in use");
  const pc001 = m.findings.find((f) => f.code === "PC001" && f.file.endsWith("compose.yaml") && f.port === 3000);
  check("PC001 compose api (API_PORT=3000) vs next dev", pc001 && /next dev, default port/.test(pc001.message), pc001 && pc001.message);
  check("PC001 has related locations", pc001 && pc001.related.length === 2);
  check("next dev and next start (same package) are not reported against each other", !m.findings.some((f) => f.code === "PC001" && /package\.json/.test(f.file) && f.related.some((r) => /package\.json/.test(r.file))));
  check("DB_PORT in .env alone is never a clash", !m.findings.some((f) => f.file.endsWith(".env")));
  check("devcontainer forwardPorts never clash", !m.findings.some((f) => /devcontainer/.test(f.file)));
  check("redis on 127.0.0.1 is not PC003", !m.findings.some((f) => f.code === "PC003" && /redis/.test(f.message)));
  check("vite.config strictPort 5174: no clash, no Vite note", !m.findings.some((f) => /Vite silently/.test(f.message)));

  // ---- view rows ----
  const rows = X.viewRows(m, m.findings);
  const labels = rows.map((r) => r.label);
  check("rows: clashes first, labelled with code and exact port", labels[0] === "PC001  3000/tcp" && labels[1] === "PC001  5432/tcp", labels.join(" | "));
  check("rows: PC002 / PC004 rows", labels.includes("PC002  5000/tcp") && labels.includes("PC004  3000/tcp"), labels.join(" | "));
  check("rows: non-host scopes tagged", labels.includes("3000/tcp (.env)") && labels.includes("5432/tcp (forwardPorts)"), labels.join(" | "));
  check("rows: plain ports listed after findings", labels.indexOf("6379/tcp") > labels.indexOf("PC004  3000/tcp"));
  check("rows: labels are unique", new Set(labels).size === labels.length, labels.join(" | "));
  const r3000 = rows[0];
  check("row description names the rule and the owners", r3000.description === "port clash: next dev (apps/web/package.json), next start (apps/web/package.json), service api (compose.yaml)", r3000.description);
  check("row tooltip has file:line and the full message", /compose\.yaml:5/.test(r3000.tooltip) && /Only one can listen at a time/.test(r3000.tooltip), r3000.tooltip);
  const r5432 = rows[1];
  check("5432 row lists both rules", /^port clash, database on 0\.0\.0\.0: /.test(r5432.description), r5432.description);
  const r004 = rows.find((r) => r.code === "PC004");
  check("PC004 row points at the code line", r004.kind === "finding" && /apps\/api\/src\/index\.js:2$/.test(r004.description), r004.description);

  // ---- README rule examples ----
  {
    const r = tmp();
    write(r, "compose.yaml", 'services:\n  grafana:\n    image: grafana/grafana\n    ports:\n      - "3100-3105:3100-3105"\n  loki:\n    image: grafana/loki\n    ports:\n      - "3103:3103"\n  web:\n    image: nginx\n    ports:\n      - "80:80"\n');
    write(r, "package.json", JSON.stringify({ scripts: { dev: "vite --port 80", api: "flask run" } }));
    const mm = modelOf(r);
    check("range 3100-3105 vs 3103 is PC001", mm.findings.filter((f) => f.code === "PC001" && f.port !== 80).length === 2 && mm.findings.some((f) => f.code === "PC001" && /3103/.test(f.message)), codes(mm));
    check("vite --port 80 (privileged, non-Docker) is PC002", mm.findings.some((f) => f.code === "PC002" && /privileged/.test(f.message) && f.file.endsWith("package.json")));
    check("Docker-published 80 is not a privileged note", !mm.findings.some((f) => f.code === "PC002" && /privileged/.test(f.message) && f.file.endsWith("compose.yaml")));
    check("vite --port 80 also clashes with compose 80", mm.findings.some((f) => f.code === "PC001" && f.port === 80));
    check("flask run default 5000 is PC002 AirPlay", mm.findings.some((f) => f.code === "PC002" && /AirPlay/.test(f.message)));
    const off = modelOf(r, { airPlayNote: "off", privilegedPortNote: false, ignorePorts: [80] });
    check("settings: airPlayNote off, privilegedPortNote false, ignorePorts", !off.findings.some((f) => f.code === "PC002") && !off.sources.some((s) => s.lo === 80));
  }

  {
    const cp = (cmd) => X.commandPorts(cmd, {});
    check("uvicorn --port 0 (random port) binds nothing fixed", cp("uvicorn app:app --port 0").length === 0, JSON.stringify(cp("uvicorn app:app --port 0")));
    check("next dev -p 0 binds nothing fixed", cp("next dev -p 0").length === 0);
    check("uvicorn default 8000 on 127.0.0.1", cp("uvicorn app:app")[0].port === 8000 && cp("uvicorn app:app")[0].ip === "127.0.0.1");
    check("PORT=4001 next dev", cp("PORT=4001 next dev")[0].port === 4001);
  }

  // ---- /proc/net/tcp ----
  const proc = "  sl  local_address rem_address   st\n   0: 0100007F:0BB8 00000000:0000 0A 0\n   1: 00000000:1538 00000000:0000 0A 0\n   2: 0100007F:1F90 0100007F:9C40 01 0\n";
  const parsed = X.parseProcNetTcp(proc);
  check("parseProcNetTcp: LISTEN only, ip + port", parsed.length === 2 && parsed[0].ip === "127.0.0.1" && parsed[0].port === 3000 && parsed[1].ip === "0.0.0.0" && parsed[1].port === 5432, JSON.stringify(parsed));
  check("hexToIp ::1", X.hexToIp("00000000000000000000000001000000") === "::1");
  const liveL = await X.liveListening(new Set([3000, 5432, 8080]), { platform: "linux", readFile: () => proc, probe: () => { throw new Error("must not probe on linux"); } });
  check("linux live check reads /proc, no probe, ip listed once", liveL.method === "/proc/net/tcp" && liveL.inUse.get(3000) === "127.0.0.1" && liveL.inUse.size === 2, JSON.stringify([...liveL.inUse]));
  const probed = [];
  const liveD = await X.liveListening(new Set([80, 443, 1023, 3000, 70000, 3001]), { platform: "darwin", probe: async (p) => (probed.push(p), p === 3000 ? "inuse" : "free") });
  check("listen-probe live check never probes privileged/invalid ports", probed.join(",") === "3000,3001" && liveD.inUse.has(3000) && !liveD.inUse.has(3001), probed.join(","));
  let clock = 0;
  const probed2 = [];
  const liveB = await X.liveListening(new Set([2000, 2001, 2002, 2003]), { platform: "win32", now: () => clock, budgetMs: 5000, probe: async (p) => { probed2.push(p); clock += 3000; return "free"; } });
  check("listen-probe live check stops at its time budget", liveB.partial === true && probed2.length === 2, probed2.join(","));
  const lf = X.liveFindings(m, { method: "/proc/net/tcp", inUse: new Map([[6379, "127.0.0.1"]]) });
  check("PC005 for a declared port in use", lf.length === 1 && lf[0].code === "PC005" && /service redis|redis/.test(lf[0].message), JSON.stringify(lf.map((f) => f.message)));

  // ---- probePort: guards (no socket at all) ----
  const guardNet = fakeNet(() => {});
  for (const p of [0, 1, 80, 443, 1023, 65536, 70000, 3000.5, "3000", NaN, null, undefined]) {
    const r = await X.probePort(p, guardNet);
    if (r !== "unknown") check("probe guard " + p, false, r);
  }
  check("probe never creates a socket for privileged / invalid ports", guardNet.servers.length === 0, guardNet.servers.length);

  // ---- probePort: always closes ----
  const okNet = fakeNet((srv) => setImmediate(() => srv.emit("listening")));
  check("probe: free -> closed", (await X.probePort(4000, okNet)) === "free" && okNet.servers[0].closeCalls === 1 && okNet.servers[0].opts.host === "127.0.0.1" && okNet.servers[0].opts.port === 4000);
  const busyNet = fakeNet((srv) => setImmediate(() => srv.emit("error", Object.assign(new Error("busy"), { code: "EADDRINUSE" }))));
  check("probe: EADDRINUSE -> inuse, socket closed", (await X.probePort(4001, busyNet)) === "inuse" && busyNet.servers[0].closeCalls >= 1);
  const accNet = fakeNet((srv) => setImmediate(() => srv.emit("error", Object.assign(new Error("acc"), { code: "EACCES" }))));
  check("probe: EACCES -> unknown, socket closed", (await X.probePort(4002, accNet)) === "unknown" && accNet.servers[0].closeCalls >= 1);
  const throwNet = fakeNet(() => { throw new Error("sync"); });
  check("probe: listen throws -> unknown, socket closed", (await X.probePort(4003, throwNet)) === "unknown" && throwNet.servers[0].closeCalls >= 1);
  let lateSrv = null;
  const lateNet = fakeNet((srv) => { lateSrv = srv; });
  const t0 = Date.now();
  const lateRes = await X.probePort(4004, lateNet);
  const closesAtTimeout = lateSrv.closeCalls;
  lateSrv.emit("listening");
  await new Promise((r) => setImmediate(r));
  check("probe: timeout -> unknown and closed", lateRes === "unknown" && closesAtTimeout >= 1 && Date.now() - t0 >= 1400, lateRes + " " + closesAtTimeout);
  check("probe: a late 'listening' after the timeout is closed again", lateSrv.closeCalls === closesAtTimeout + 1, lateSrv.closeCalls);
  const connNet = fakeNet((srv) => setImmediate(() => srv.emit("listening")));
  await X.probePort(4005, connNet);
  let destroyed = false;
  connNet.servers[0].emit("connection", { destroy: () => (destroyed = true) });
  check("probe: a connection during the probe is destroyed", destroyed);

  // ---- probePort with real sockets ----
  const fp = await freePort();
  check("probe (real): free port -> free", (await X.probePort(fp)) === "free");
  const again = await listenOn(fp).then((s) => new Promise((r) => s.close(() => r(true)))).catch(() => false);
  check("probe (real): port is released after the probe", again);
  const hp = await freePort();
  const holder = await listenOn(hp);
  check("probe (real): port held on 127.0.0.1 -> inuse", (await X.probePort(hp)) === "inuse");
  check("probe (real): the holder still owns the port", (await connectReads(hp)) === "holder");
  await new Promise((r) => holder.close(r));

  // ---- connect probe (macOS / Windows path), real sockets ----
  {
    const sockets = [];
    let servers = 0;
    const spyNet = {
      connect(o) {
        const c = net.connect(o);
        sockets.push(c);
        return c;
      },
      createServer() {
        servers++;
        return net.createServer();
      },
    };
    // a listener on 0.0.0.0 (all interfaces): must be detected, nothing sent, never bound
    const wp = await freePort();
    let received = 0;
    let accepted = 0;
    const closedByProbe = [];
    const wild = net.createServer((c) => {
      accepted++;
      c.on("error", () => {});
      c.on("data", (d) => (received += d.length));
      c.on("close", () => closedByProbe.push(true));
    });
    await new Promise((r) => wild.listen({ port: wp, host: "0.0.0.0" }, r));
    const rW = await X.probePort(wp, spyNet, { platform: "darwin" });
    await new Promise((r) => setTimeout(r, 200));
    check("connect probe: listener on 0.0.0.0 -> inuse", rW === "inuse", rW);
    check("connect probe: no bind attempted when the connect succeeds", servers === 0, servers);
    check("connect probe: nothing sent, connection closed by the probe", accepted === 1 && received === 0 && closedByProbe.length === 1, accepted + "/" + received + "/" + closedByProbe.length);
    const rW2 = await X.probePort(wp, spyNet, { platform: "win32" });
    check("connect probe (win32 path): listener on 0.0.0.0 -> inuse", rW2 === "inuse", rW2);
    const liveW = await X.liveListening(new Set([wp]), { platform: "darwin" });
    check("live check (darwin, default probe) detects the 0.0.0.0 listener", liveW.inUse.has(wp) && /connect/.test(liveW.method), JSON.stringify([...liveW.inUse]) + " " + liveW.method);
    await new Promise((r) => wild.close(r));
    // a listener on 127.0.0.1
    const lp = await freePort();
    const lo = await listenOn(lp);
    check("connect probe: listener on 127.0.0.1 -> inuse", (await X.connectProbe(lp, spyNet)) === "inuse");
    await new Promise((r) => lo.close(r));
    // a free port: refused by connect, then the bind probe says free
    const fp2 = await freePort();
    check("connect probe: free port -> refused", (await X.connectProbe(fp2, spyNet)) === "refused");
    const before = servers;
    check("probe (darwin path): free port -> free via bind probe", (await X.probePort(fp2, spyNet, { platform: "darwin" })) === "free" && servers === before + 1);
    check("probe (darwin path): free port still bindable afterwards", await listenOn(fp2).then((s) => new Promise((r) => s.close(() => r(true)))).catch(() => false));
    // guard: no connect to privileged / invalid ports
    const n0 = sockets.length;
    for (const p of [80, 1023, 0, 70000]) await X.probePort(p, spyNet, { platform: "darwin" });
    check("connect probe never touches privileged / invalid ports", sockets.length === n0, sockets.length - n0);
    // linux keeps /proc + bind only: no connect
    const n1 = sockets.length;
    await X.probePort(await freePort(), spyNet, { platform: "linux" });
    check("linux path never connects", sockets.length === n1);
    await new Promise((r) => setTimeout(r, 100));
    check("every connect socket was destroyed (" + sockets.length + ")", sockets.length >= 5 && sockets.every((c) => c.destroyed), sockets.map((c) => c.destroyed).join(","));
    // timeout path: a connect that never answers is destroyed and falls back to the bind probe
    const hung = [];
    const hungNet = {
      connect() {
        const e = new EventEmitter();
        e.destroyed = false;
        e.destroy = () => (e.destroyed = true);
        hung.push(e);
        return e;
      },
      createServer: () => net.createServer(),
    };
    const t1 = Date.now();
    const rH = await X.connectProbe(4100, hungNet, 300);
    check("connect probe timeout -> unknown after ~300 ms, socket destroyed", rH === "unknown" && hung[0].destroyed && Date.now() - t1 >= 250 && Date.now() - t1 < 1000, rH + " " + (Date.now() - t1));
    const fp3 = await freePort();
    check("probe falls back to the bind probe after a connect timeout", (await X.probePort(fp3, hungNet, { platform: "darwin", connectTimeoutMs: 100 })) === "free" && hung[1].destroyed);
  }

  // ---- findFreePort ----
  const seen = [];
  const pr = async (p) => (seen.push(p), "free");
  const declared = { sources: [{ scope: "host", lo: 1024, hi: 1026 }] };
  const ff = await X.findFreePortRange(80, declared, { platform: "darwin", probe: pr });
  check("find free near 80 starts at 1024 and skips declared ports", ff.port === 1027 && ff.from === 1024 && seen.every((p) => p >= 1024), JSON.stringify(ff) + " " + seen.join(","));
  seen.length = 0;
  const ff2 = await X.findFreePortRange(4999, { sources: [] }, { platform: "darwin", probe: async (p) => (seen.push(p), p === 5001 ? "free" : "inuse") });
  check("find free skips 5000/7000 without probing", ff2.port === 5001 && !seen.includes(5000), seen.join(","));
  seen.length = 0;
  const procBusy = "  sl local rem st\n 0: 00000000:0BB9 00000000:0000 0A 0\n";
  const ff3 = await X.findFreePortRange(3000, { sources: [] }, { platform: "linux", readFile: () => procBusy, probe: pr });
  check("linux: a port /proc lists as listening is skipped and never bound", ff3.port === 3002 && !seen.includes(3001), seen.join(","));
  const ff4 = await X.findFreePortRange(65535, { sources: [] }, { platform: "darwin", probe: pr });
  check("find free after 65535: none, nothing probed", ff4.port === null && ff4.from > ff4.to);
  const ffReal = await X.findFreePort(await freePort(), { sources: [] });
  check("find free (real sockets) returns a bindable port", typeof ffReal === "number" && ffReal >= 1024);

  // ---- markdown map ----
  const md = X.markdownMap(m);
  check("port map lists totals and rows", /5 host ports declared, 2 clashes\./.test(md) && /\| 3000\/tcp \| host \|/.test(md));

  console.log(`\nunit tests: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log("FAIL unexpected " + (e && e.stack));
  process.exit(1);
});
