"use strict";

/**
 * PortClash - finds port conflicts across a workspace before you run anything.
 *
 * It statically collects every declared host port (docker compose `ports:`, package.json
 * scripts and dev-server defaults, Vite / Astro / webpack / Angular configs, Procfile,
 * Makefile and shell scripts, devcontainer.json, .vscode/launch.json, Kubernetes manifests)
 * and reports:
 *
 *   PC001  two different sources bind the same host port                        - Error
 *   PC002  a declared port is a known-busy system port (macOS AirPlay 5000/7000)
 *          or a privileged port (< 1024) for a non-Docker dev server             - Information
 *   PC003  compose publishes a database / cache port on all interfaces           - Warning
 *   PC004  a PORT env var fallback in code disagrees with .env / compose         - Information
 *   PC005  (opt-in) a declared port is already in use on this machine            - Information
 *
 * UI: an activity bar view "Ports" (one row per declared port, labelled with the code and the
 * exact port, e.g. "PC001  3000/tcp", children = the lines that claim it; badge = clashes), a
 * status bar summary, Problems diagnostics, a Markdown port map and Find Free Port Near...
 *
 * Zero telemetry. No child processes. No http/https. The only socket use is the optional,
 * off-by-default live check (PC005) and Find Free Port Near...: on Linux it reads /proc/net/tcp
 * and /proc/net/tcp6 instead of opening sockets; on macOS and Windows it first opens and at once
 * closes a local connection to 127.0.0.1:<port> (no data is sent), and only when nothing answers
 * there it briefly listens on 127.0.0.1:<port> and closes it again.
 *
 * YAML: VS Code ships no YAML parser to extensions and this extension has no dependencies,
 * so it contains a small block-YAML reader (multi-document streams, block maps/sequences,
 * plain/quoted scalars, single-line flow collections, comments, tags and anchors).
 */

const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------------------
// Minimal YAML block reader (with line info per key / list item)
// ---------------------------------------------------------------------------------------
const LINE_INFO = new WeakMap();

function lineInfo(node) {
  let info = LINE_INFO.get(node);
  if (!info) {
    info = { self: -1, keys: Object.create(null), items: [] };
    LINE_INFO.set(node, info);
  }
  return info;
}

function keyLine(obj, key) {
  if (!obj || typeof obj !== "object") return -1;
  const info = LINE_INFO.get(obj);
  if (!info) return -1;
  const l = info.keys[key];
  return typeof l === "number" ? l : -1;
}

function nodeLine(obj) {
  if (!obj || typeof obj !== "object") return -1;
  const info = LINE_INFO.get(obj);
  return info ? info.self : -1;
}

function stripComment(text) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inDouble) {
      if (c === "\\") i++;
      else if (c === '"') inDouble = false;
    } else if (inSingle) {
      if (c === "'") inSingle = false;
    } else if (c === '"') {
      inDouble = true;
    } else if (c === "'") {
      inSingle = true;
    } else if (c === "#" && (i === 0 || text[i - 1] === " " || text[i - 1] === "\t")) {
      return text.slice(0, i).replace(/\s+$/, "");
    }
  }
  return text.replace(/\s+$/, "");
}

function findKeyColon(text) {
  let inSingle = false;
  let inDouble = false;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inDouble) {
      if (c === "\\") i++;
      else if (c === '"') inDouble = false;
      continue;
    }
    if (inSingle) {
      if (c === "'") inSingle = false;
      continue;
    }
    if (c === '"' && i === 0) inDouble = true;
    else if (c === "'" && i === 0) inSingle = true;
    else if (c === "{" || c === "[") {
      if (i === 0 && depth === 0) return -1;
      depth++;
    } else if (c === "}" || c === "]") depth = Math.max(0, depth - 1);
    else if (c === ":" && depth === 0 && (i + 1 === text.length || text[i + 1] === " ")) {
      return i;
    }
  }
  return -1;
}

function isQuoted(s) {
  return s.length >= 2 && ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'"));
}

function unquote(s) {
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    return s
      .slice(1, -1)
      .replace(/\\(["\\/nrt])/g, (_, ch) => ({ n: "\n", r: "\r", t: "\t" }[ch] || ch));
  }
  if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  return s;
}

/** YAML 1.2 core-schema typing of a plain (unquoted) scalar. */
function plainScalar(t) {
  if (t === "" || t === "~" || /^(?:null|Null|NULL)$/.test(t)) return null;
  if (/^(?:true|True|TRUE)$/.test(t)) return true;
  if (/^(?:false|False|FALSE)$/.test(t)) return false;
  if (/^[-+]?\d+$/.test(t)) return Number(t);
  if (/^0x[0-9a-fA-F]+$/.test(t)) return parseInt(t, 16);
  if (/^0o[0-7]+$/.test(t)) return parseInt(t.slice(2), 8);
  if (/^[-+]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?$/.test(t)) return Number(t);
  return t;
}

function stripProps(text) {
  let t = text;
  for (;;) {
    const m = /^(?:!\S*|&\S+)(?:\s+|$)/.exec(t);
    if (!m) break;
    t = t.slice(m[0].length);
  }
  return { text: t, alias: /^\*\S+$/.test(t) };
}

const UNKNOWN = Object.freeze({ __unknown: true });

function parseInlineValue(raw) {
  const { text, alias } = stripProps(raw.trim());
  if (alias) return UNKNOWN;
  if (/\{\{.*\}\}/.test(text) && !isQuoted(text)) return UNKNOWN; // helmfile .gotmpl templating
  if (text[0] === "{" || text[0] === "[") {
    const parser = { s: text, i: 0 };
    try {
      return parseFlow(parser);
    } catch (_) {
      return UNKNOWN;
    }
  }
  if (isQuoted(text)) return unquote(text);
  return plainScalar(text);
}

function parseFlow(p) {
  skipWs(p);
  const c = p.s[p.i];
  if (c === "{") {
    p.i++;
    const obj = {};
    for (;;) {
      skipWs(p);
      if (p.s[p.i] === "}") {
        p.i++;
        return obj;
      }
      const key = String(parseFlowScalar(p, true));
      skipWs(p);
      let val = null;
      if (p.s[p.i] === ":") {
        p.i++;
        val = parseFlow(p);
      }
      obj[key] = val;
      skipWs(p);
      if (p.s[p.i] === ",") p.i++;
      else if (p.s[p.i] === "}") {
        p.i++;
        return obj;
      } else throw new Error("bad flow mapping");
    }
  }
  if (c === "[") {
    p.i++;
    const arr = [];
    for (;;) {
      skipWs(p);
      if (p.s[p.i] === "]") {
        p.i++;
        return arr;
      }
      arr.push(parseFlow(p));
      skipWs(p);
      if (p.s[p.i] === ",") p.i++;
      else if (p.s[p.i] === "]") {
        p.i++;
        return arr;
      } else throw new Error("bad flow sequence");
    }
  }
  return parseFlowScalar(p, false);
}

function skipWs(p) {
  while (p.i < p.s.length && /\s/.test(p.s[p.i])) p.i++;
  if (p.i >= p.s.length) throw new Error("unterminated flow");
}

function parseFlowScalar(p, isKey) {
  const start = p.i;
  const q = p.s[p.i];
  if (q === '"' || q === "'") {
    p.i++;
    while (p.i < p.s.length) {
      if (q === '"' && p.s[p.i] === "\\") {
        p.i += 2;
        continue;
      }
      if (p.s[p.i] === q) {
        if (q === "'" && p.s[p.i + 1] === "'") {
          p.i += 2;
          continue;
        }
        p.i++;
        return unquote(p.s.slice(start, p.i));
      }
      p.i++;
    }
    throw new Error("unterminated quote");
  }
  while (p.i < p.s.length) {
    const ch = p.s[p.i];
    if (ch === "," || ch === "}" || ch === "]") break;
    if (ch === ":" && (isKey || /[\s,}\]]/.test(p.s[p.i + 1] || " "))) break;
    p.i++;
  }
  const t = p.s.slice(start, p.i).trim();
  return isKey ? t : plainScalar(t);
}

function tokenize(lines, startLine, endLine) {
  const tokens = [];
  for (let i = startLine; i < endLine; i++) {
    const stripped = stripComment(lines[i]);
    if (!stripped.trim()) continue;
    const indent = stripped.length - stripped.replace(/^[ \t]+/, "").length;
    const text = stripped.slice(indent);
    if (/^\{\{.*\}\}$/.test(text) && !/^\{\{.*\}\}\s*:/.test(text)) continue; // template directive
    tokens.push({ indent, text, line: i });
    if (/(?:^|[:\-]\s+|^-\s*)[|>][+-]?\d*[+-]?$/.test(text) || /^[|>][+-]?\d*$/.test(text)) {
      let j = i + 1;
      while (j < endLine) {
        const l = lines[j];
        if (l.trim() === "") {
          j++;
          continue;
        }
        const ind = l.length - l.replace(/^[ \t]+/, "").length;
        if (ind <= indent) break;
        j++;
      }
      i = j - 1;
    }
  }
  return tokens;
}

function isSeqItem(text) {
  return text === "-" || text.startsWith("- ");
}

function parseBlock(tokens, i, indent) {
  const tok = tokens[i];
  if (!tok) return [null, i];
  if (isSeqItem(tok.text)) return parseSequence(tokens, i, tok.indent);
  if (findKeyColon(tok.text) >= 0) return parseMapping(tokens, i, tok.indent);
  let j = i + 1;
  while (j < tokens.length && tokens[j].indent > indent) j++;
  return [parseInlineValue(tok.text), j];
}

function parseMapping(tokens, i, indent) {
  const obj = {};
  const info = lineInfo(obj);
  info.self = tokens[i].line;
  while (i < tokens.length && tokens[i].indent === indent && !isSeqItem(tokens[i].text)) {
    const tok = tokens[i];
    const colon = findKeyColon(tok.text);
    if (colon < 0) {
      i++;
      while (i < tokens.length && tokens[i].indent > indent) i++;
      continue;
    }
    const key = unquote(stripProps(tok.text.slice(0, colon).trim()).text);
    const rest = tok.text.slice(colon + 1).trim();
    i++;
    let value;
    if (rest === "" || /^(?:!\S*|&\S+)$/.test(rest)) {
      const next = tokens[i];
      if (next && next.indent > indent) {
        [value, i] = parseBlock(tokens, i, next.indent);
      } else if (next && next.indent === indent && isSeqItem(next.text)) {
        [value, i] = parseSequence(tokens, i, indent);
      } else {
        value = null;
      }
    } else if (/^[|>][+-]?\d*[+-]?$/.test(stripProps(rest).text)) {
      value = UNKNOWN;
    } else {
      value = parseInlineValue(rest);
      while (i < tokens.length && tokens[i].indent > indent) i++;
    }
    if (key === "<<") continue;
    info.keys[key] = tok.line;
    obj[key] = value;
  }
  return [obj, i];
}

function parseSequence(tokens, i, indent) {
  const arr = [];
  const info = lineInfo(arr);
  info.self = tokens[i].line;
  while (i < tokens.length && tokens[i].indent === indent && isSeqItem(tokens[i].text)) {
    const tok = tokens[i];
    const rest = tok.text === "-" ? "" : tok.text.slice(1);
    const restTrim = rest.replace(/^\s+/, "");
    info.items.push(tok.line);
    if (restTrim === "") {
      i++;
      const next = tokens[i];
      if (next && next.indent > indent) {
        let v;
        [v, i] = parseBlock(tokens, i, next.indent);
        arr.push(v);
      } else {
        arr.push(null);
      }
      continue;
    }
    const col = indent + 1 + (rest.length - restTrim.length);
    tokens[i] = { indent: col, text: restTrim, line: tok.line };
    let v;
    if (isSeqItem(restTrim) || findKeyColon(restTrim) >= 0) {
      [v, i] = parseBlock(tokens, i, col);
    } else {
      v = /^[|>][+-]?\d*[+-]?$/.test(restTrim) ? UNKNOWN : parseInlineValue(restTrim);
      i++;
      while (i < tokens.length && tokens[i].indent > indent) i++;
    }
    arr.push(v);
  }
  return [arr, i];
}

/** @returns {{value:any, startLine:number}[]} */
function parseYamlDocuments(text) {
  const lines = String(text).split(/\r?\n/);
  const docs = [];
  let start = 0;
  const flush = (end) => {
    const tokens = tokenize(lines, start, end);
    if (tokens.length) {
      let value = null;
      try {
        [value] = parseBlock(tokens, 0, tokens[0].indent);
      } catch (_) {
        value = null;
      }
      docs.push({ value, startLine: tokens[0].line });
    }
  };
  for (let i = 0; i < lines.length; i++) {
    if (/^(?:---|\.\.\.)(?:\s|$)/.test(lines[i])) {
      flush(i);
      start = i + 1;
    }
  }
  flush(lines.length);
  return docs;
}

function isObj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v) && v !== UNKNOWN;
}

// ---------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------
function plural(n, one, many) {
  return n + " " + (n === 1 ? one : many || one + "s");
}

function toPort(v) {
  if (typeof v === "number" && Number.isInteger(v)) return v >= 1 && v <= 65535 ? v : null;
  if (typeof v === "string" && /^\s*\d{1,5}\s*$/.test(v)) return toPort(Number(v));
  return null;
}

function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end < 0) re += "\\{";
      else {
        re += "(?:" + glob.slice(i + 1, end).split(",").map((s) => s.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")).join("|") + ")";
        i = end;
      }
    } else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$", "i");
}

function matchesAny(rel, globs) {
  return (globs || []).some((g) => globToRegExp(g).test(rel));
}

/** Line (0-based) of the first match of `re` at or after `from`, else `fallback`. */
function findLine(lines, re, from, fallback) {
  for (let i = Math.max(0, from || 0); i < lines.length; i++) if (re.test(lines[i])) return i;
  return fallback === undefined ? 0 : fallback;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------------------
// JSONC reader (comments + trailing commas), used for devcontainer.json / launch.json /
// angular.json / package.json
// ---------------------------------------------------------------------------------------
function stripJsonComments(text) {
  let out = "";
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === "\\") {
        out += text[i + 1] || "";
        i++;
      } else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        if (text[i] === "\n") out += "\n";
        i++;
      }
      i++;
    } else out += c;
  }
  return out;
}

function parseJsonc(text) {
  try {
    const clean = stripJsonComments(String(text).replace(/^﻿/, "")).replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(clean);
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------------------
// .env reader
// ---------------------------------------------------------------------------------------
/** @returns {{key:string, value:string, line:number}[]} */
function parseDotenv(text) {
  const out = [];
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    let v = m[2].trim();
    if (v[0] === '"' || v[0] === "'") {
      const q = v[0];
      const end = v.indexOf(q, 1);
      v = end > 0 ? v.slice(1, end) : v.slice(1);
    } else {
      v = v.replace(/\s+#.*$/, "").trim();
    }
    out.push({ key: m[1], value: v, line: i });
  }
  return out;
}

/** Environments that do not run on the developer machine are not used. */
function envFileKind(base) {
  if (!/^\.env(?:\..+)?$/i.test(base)) return null;
  if (/(?:^|\.)(?:example|sample|template|dist|defaults?)(?:\.|$)/i.test(base.slice(4))) return "template";
  if (/(?:^|\.)(?:prod|production|staging|stage|test|ci|preview|vault|enc|encrypted|keys?)(?:\.|$)/i.test(base.slice(4))) return null;
  return "local";
}

function isPortKey(k) {
  return /^(?:[A-Za-z0-9_]*_)?PORT$/i.test(k);
}

// ---------------------------------------------------------------------------------------
// Variable interpolation (${VAR}, ${VAR:-default}, ${VAR-default}, $VAR)
// ---------------------------------------------------------------------------------------
/**
 * @param {string} s
 * @param {(name:string)=>({value:string, file?:string, line?:number}|undefined)} lookup
 * @returns {{text:string, vars:string[], refs:object[], unresolved:boolean}}
 */
function interpolate(s, lookup) {
  const vars = [];
  const refs = [];
  let unresolved = false;
  const text = String(s)
    .replace(/\$\$/g, "\u0000")
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?+])((?:[^{}]|\{[^{}]*\})*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (all, n1, op, arg, n2) => {
      const name = n1 || n2;
      vars.push(name);
      const hit = lookup(name);
      const set = hit && hit.value !== undefined;
      const nonEmpty = set && hit.value !== "";
      if (hit) refs.push(Object.assign({ name }, hit));
      if (!op) {
        if (set) return hit.value;
        unresolved = true;
        return "";
      }
      const def = arg === undefined ? "" : arg.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*):?-([^{}]*)\}/g, (a, n, d) => {
        const h = lookup(n);
        return h && h.value !== "" ? h.value : d;
      });
      if (op === ":-") return nonEmpty ? hit.value : def;
      if (op === "-") return set ? hit.value : def;
      if (op === ":+") return nonEmpty ? def : "";
      if (op === "+") return set ? def : "";
      if (set && (op === "?" || nonEmpty)) return hit.value;
      unresolved = true;
      return "";
    })
    .replace(/\u0000/g, "$");
  return { text, vars, refs, unresolved };
}

// ---------------------------------------------------------------------------------------
// Port specs
// ---------------------------------------------------------------------------------------
function normIp(ip) {
  if (!ip) return "";
  let s = String(ip).trim().replace(/^\[|\]$/g, "");
  if (s === "0.0.0.0" || s === "::" || s === "*" || s === "0") return "";
  if (s.toLowerCase() === "localhost") return "127.0.0.1";
  return s;
}

function parseRange(s) {
  const m = /^\s*(\d{1,5})(?:\s*-\s*(\d{1,5}))?\s*$/.exec(String(s));
  if (!m) return null;
  const lo = toPort(m[1]);
  const hi = m[2] ? toPort(m[2]) : lo;
  if (!lo || !hi || hi < lo) return null;
  return [lo, hi];
}

/**
 * Compose / docker run short syntax: [[IP:]HOST:]CONTAINER[/PROTOCOL]
 * @returns {{ip:string, lo:number, hi:number, target:string, proto:string}|null} null when no
 *   fixed host port is published (container-only or random host port).
 */
function parseShortPort(spec) {
  let s = String(spec).trim();
  let proto = "tcp";
  const pm = /\/(tcp|udp|sctp)$/i.exec(s);
  if (pm) {
    proto = pm[1].toLowerCase();
    s = s.slice(0, pm.index);
  }
  let ip = "";
  const v6 = /^\[([^\]]+)\]:(.*)$/.exec(s);
  if (v6) {
    ip = v6[1];
    s = v6[2];
  }
  const parts = s.split(":");
  if (!v6 && parts.length >= 3) {
    ip = parts.slice(0, parts.length - 2).join(":");
    parts.splice(0, parts.length - 2);
  }
  if (parts.length < 2) return null; // container port only: Docker picks a random host port
  const host = parts[0];
  const target = parts[1];
  if (host === "") return null;
  const r = parseRange(host);
  if (!r) return null;
  return { ip: normIp(ip), lo: r[0], hi: r[1], target, proto };
}

function portLabel(lo, hi) {
  return lo === hi ? String(lo) : lo + "-" + hi;
}

// ---------------------------------------------------------------------------------------
// Command-line parsing (package.json scripts, Procfile, Makefile, *.sh)
// ---------------------------------------------------------------------------------------
function splitSegments(cmd) {
  const out = [];
  let cur = "";
  let q = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) {
      cur += c;
      if (c === "\\" && q === '"') {
        cur += cmd[i + 1] || "";
        i++;
      } else if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      cur += c;
    } else if (c === ";" || c === "\n" || c === "&" || c === "|" || c === "(" || c === ")") {
      if (cur.trim()) out.push(cur);
      cur = "";
      if ((c === "&" || c === "|") && cmd[i + 1] === c) i++;
    } else cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function shellWords(seg) {
  const words = [];
  let cur = "";
  let q = null;
  let has = false;
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (q) {
      if (c === q) q = null;
      else if (c === "\\" && q === '"' && i + 1 < seg.length) cur += seg[++i];
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      has = true;
    } else if (c === "\\" && i + 1 < seg.length) {
      cur += seg[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) words.push(cur);
      cur = "";
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has || cur) words.push(cur);
  return words;
}

const WRAPPERS = new Set(["cross-env", "cross-env-shell", "env", "npx", "bunx", "pnpx", "exec", "sudo", "time", "nohup", "concurrently-skip"]);
const PM_EXEC = { pnpm: ["exec", "dlx"], npm: ["exec", "x"], yarn: ["dlx", "exec"], bun: ["x"], poetry: ["run"], uv: ["run"], pipenv: ["run"], pdm: ["run"], hatch: ["run"], rye: ["run"] };

/** Value of a flag: `--port 3000`, `--port=3000`, `-p 3000`, `-p3000`. */
function flagValue(words, names) {
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    for (const n of names) {
      if (w === n && i + 1 < words.length) return words[i + 1];
      if (n.startsWith("--") && w.startsWith(n + "=")) return w.slice(n.length + 1);
      if (!n.startsWith("--") && n.length === 2 && w.startsWith(n) && w.length > 2 && /^\d/.test(w.slice(2))) return w.slice(2);
    }
  }
  return undefined;
}

function flagValues(words, names) {
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    for (const n of names) {
      if (w === n && i + 1 < words.length) out.push(words[++i]);
      else if (n.startsWith("--") && w.startsWith(n + "=")) out.push(w.slice(n.length + 1));
    }
  }
  return out;
}

function positionals(words, flagsWithValue) {
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w.startsWith("-")) {
      if (flagsWithValue.includes(w)) i++;
      continue;
    }
    out.push(w);
  }
  return out;
}

/**
 * Framework defaults (only documented ones - see README "Sources").
 * next dev/start: 3000 (nextjs.org/docs/app/api-reference/cli/next)
 * nuxt dev: 3000 (nuxt.com/docs/api/commands/dev)
 * vite / vite dev / vite serve: 5173 (vite.dev/config/server-options#server-port)
 * astro dev: 4321 (docs.astro.build/en/reference/cli-reference/)
 * ng serve: 4200 (angular.dev/cli/serve)
 * manage.py runserver: 127.0.0.1:8000 (docs.djangoproject.com/en/stable/ref/django-admin/#runserver)
 * flask run: 127.0.0.1:5000 (flask.palletsprojects.com/en/stable/cli/)
 * uvicorn: 127.0.0.1:8000 (uvicorn.dev/settings/)
 */
function commandPorts(seg, ctx) {
  let words = shellWords(seg.trim());
  const env = {};
  const results = [];
  for (let guard = 0; guard < 12 && words.length; guard++) {
    const w = words[0];
    const a = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(w);
    if (a) {
      env[a[1]] = a[2];
      words = words.slice(1);
      continue;
    }
    if (WRAPPERS.has(w)) {
      words = words.slice(1);
      while (words[0] && /^-/.test(words[0]) && !/=/.test(words[0])) words = words.slice(1);
      continue;
    }
    if (w === "dotenv" || w === "env-cmd") {
      const dd = words.indexOf("--");
      words = dd >= 0 ? words.slice(dd + 1) : words.slice(1).filter((x, i, arr) => !(x.startsWith("-") || (i > 0 && /^-[ef]$/.test(arr[i - 1]))));
      continue;
    }
    if (PM_EXEC[w] && PM_EXEC[w].includes(words[1])) {
      words = words.slice(2);
      continue;
    }
    if (/^python(?:\d(?:\.\d+)?)?$/.test(w) || w === "py") {
      const mi = words.indexOf("-m");
      if (mi >= 0 && words[mi + 1]) words = words.slice(mi + 1);
      else if (words[1] && /manage\.py$/.test(words[1])) words = ["manage.py"].concat(words.slice(2));
      else break;
      continue;
    }
    break;
  }
  if (!words.length) return results;
  const bin = path.posix.basename(words[0].replace(/\\/g, "/"));
  const args = words.slice(1);

  const resolveVal = (raw, extraVars) => {
    if (raw === undefined || raw === null) return null;
    const vars = [];
    const r = interpolate(String(raw), (name) => {
      if (Object.prototype.hasOwnProperty.call(env, name)) return { value: env[name], inline: true };
      return ctx.lookup ? ctx.lookup(name) : undefined;
    });
    for (const v of r.vars) vars.push(v);
    if (extraVars) for (const v of extraVars) vars.push(v);
    return { text: r.text, vars, refs: r.refs };
  };
  const push = (tool, raw, def, opts) => {
    opts = opts || {};
    let port = null;
    let vars = [];
    let refs = [];
    let isDefault = false;
    let ip = opts.ip === undefined ? "" : opts.ip;
    if (raw !== undefined && raw !== null && raw !== "") {
      const r = resolveVal(raw);
      vars = r.vars;
      refs = r.refs;
      let t = r.text;
      const hp = /^(?:\[([^\]]+)\]|([^:]*)):(\d{1,5})$/.exec(t);
      if (hp) {
        ip = normIp(hp[1] || hp[2]);
        t = hp[3];
      }
      if (/^\s*0+\s*$/.test(t)) return; // port 0 = the OS picks a free port: nothing fixed is bound
      port = toPort(t);
      if (!port && def && r.vars.length) {
        port = def;
        isDefault = true;
      }
    } else if (opts.envNames) {
      for (const n of opts.envNames) {
        if (Object.prototype.hasOwnProperty.call(env, n)) {
          const r = resolveVal(env[n], [n]);
          port = toPort(r.text);
          vars = r.vars;
          refs = r.refs;
          if (port) break;
        }
      }
    }
    if (!port && def) {
      port = def;
      isDefault = true;
    }
    if (!port) return;
    results.push({ tool, port, portEnd: port, ip, vars, refs, isDefault, strict: opts.strict, proto: "tcp" });
  };

  const sub = args[0];
  const subIsFlag = sub === undefined || sub.startsWith("-");
  if (bin === "next") {
    if (subIsFlag || sub === "dev" || sub === "start") push("next " + (subIsFlag ? "dev" : sub), flagValue(args, ["-p", "--port"]), 3000, { envNames: ["PORT"] });
  } else if (bin === "nuxt" || bin === "nuxi") {
    if (sub === "dev") push("nuxt dev", flagValue(args, ["-p", "--port"]), 3000, { envNames: ["NUXT_PORT", "NITRO_PORT", "PORT"] });
  } else if (bin === "vite") {
    if (subIsFlag || sub === "dev" || sub === "serve") {
      const cfg = ctx.config && ctx.config.vite;
      const flag = flagValue(args, ["--port"]);
      if (flag !== undefined) push("vite", flag, null, { strict: args.includes("--strictPort") || (cfg && cfg.strict) });
      else if (!cfg || !cfg.port) push("vite", undefined, 5173, { strict: args.includes("--strictPort") || (cfg && cfg.strict) });
    } else if (sub === "preview") {
      const flag = flagValue(args, ["--port"]);
      if (flag !== undefined) push("vite preview", flag, null);
    }
  } else if (bin === "astro") {
    if (sub === "dev" || sub === "preview") {
      const flag = flagValue(args, ["--port"]);
      const cfg = ctx.config && ctx.config.astro;
      if (flag !== undefined) push("astro " + sub, flag, null);
      else if (sub === "dev" && (!cfg || !cfg.port)) push("astro dev", undefined, 4321);
    }
  } else if (bin === "ng") {
    if (sub === "serve" || sub === "s" || sub === "dev") {
      const flag = flagValue(args, ["--port"]);
      const cfg = ctx.config && ctx.config.angular;
      if (flag !== undefined) push("ng serve", flag, null);
      else if (!cfg || !cfg.port) push("ng serve", undefined, 4200);
    }
  } else if (bin === "webpack" || bin === "webpack-cli" || bin === "webpack-dev-server") {
    if (sub === "serve" || bin === "webpack-dev-server") {
      const flag = flagValue(args, ["--port"]);
      if (flag !== undefined && flag !== "auto") push("webpack serve", flag, null);
    }
  } else if (bin === "manage.py" || bin === "django-admin") {
    if (sub === "runserver") {
      const pos = positionals(args.slice(1), ["--settings", "--pythonpath"]);
      const ip6 = args.includes("-6") || args.includes("--ipv6");
      const ap = pos[0];
      if (ap !== undefined) {
        const r = resolveVal(ap);
        const m = /^(?:(\[[^\]]+\]|[^:]+):)?(\d{1,5})$/.exec(r.text);
        if (m && toPort(m[2])) {
          results.push({ tool: "runserver", port: toPort(m[2]), portEnd: toPort(m[2]), ip: m[1] ? normIp(m[1]) : ip6 ? "::1" : "127.0.0.1", vars: r.vars, refs: r.refs, isDefault: false, proto: "tcp" });
        }
      } else results.push({ tool: "runserver", port: 8000, portEnd: 8000, ip: ip6 ? "::1" : "127.0.0.1", vars: [], refs: [], isDefault: true, proto: "tcp" });
    }
  } else if (bin === "flask") {
    const ri = args.indexOf("run");
    if (ri >= 0) {
      const rest = args.slice(ri + 1);
      const host = flagValue(rest, ["-h", "--host"]);
      push("flask run", flagValue(rest, ["-p", "--port"]), 5000, { envNames: ["FLASK_RUN_PORT"], ip: host !== undefined ? normIp(host) : "127.0.0.1" });
    }
  } else if (bin === "uvicorn") {
    const host = flagValue(args, ["--host"]);
    push("uvicorn", flagValue(args, ["--port"]), 8000, { ip: host !== undefined ? normIp(host) : "127.0.0.1" });
  } else if (bin === "docker" || bin === "podman") {
    const isRun = sub === "run" || (sub === "container" && args[1] === "run");
    if (isRun) {
      for (const p of flagValues(args, ["-p", "--publish"])) {
        const r = resolveVal(p);
        const sp = parseShortPort(r.text);
        if (sp) results.push({ tool: bin + " run -p", port: sp.lo, portEnd: sp.hi, ip: sp.ip, vars: r.vars, refs: r.refs, isDefault: false, proto: sp.proto, target: sp.target, docker: true });
      }
    }
  } else if (bin === "kubectl" || bin === "oc") {
    const pi = args.indexOf("port-forward");
    if (pi >= 0) {
      const rest = args.slice(pi + 1);
      const addr = flagValue(rest, ["--address"]);
      const pos = positionals(rest, ["-n", "--namespace", "--address", "--context", "--kubeconfig", "--pod-running-timeout", "-c", "--container"]);
      for (const spec of pos.slice(1)) {
        const r = resolveVal(spec);
        const m = /^(\d{1,5})?(?::(\S+))?$/.exec(r.text);
        if (!m || !m[1]) continue;
        const lp = toPort(m[1]);
        if (!lp) continue;
        const ips = addr ? addr.split(",").map(normIp) : ["127.0.0.1"];
        results.push({ tool: "kubectl port-forward", port: lp, portEnd: lp, ip: ips.includes("") ? "" : ips[0], vars: r.vars, refs: r.refs, isDefault: false, proto: "tcp" });
      }
    }
  } else {
    const flag = flagValue(args, ["--port"]);
    if (flag !== undefined) push(bin, flag, null);
  }
  return results;
}

// ---------------------------------------------------------------------------------------
// JS config blocks (vite / astro / webpack)
// ---------------------------------------------------------------------------------------
function blockAfter(text, re) {
  const m = re.exec(text);
  if (!m) return null;
  let i = text.indexOf("{", m.index + m[0].length - 1);
  if (i < 0) return null;
  const start = i;
  let depth = 0;
  for (; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return { body: text.slice(start, i + 1), offset: start };
    }
  }
  return null;
}

function lineOfOffset(text, off) {
  let n = 0;
  for (let i = 0; i < off && i < text.length; i++) if (text[i] === "\n") n++;
  return n;
}

/** Reads `<blockKey>: { port: 3000 }` from a JS/TS config, including `port: Number(process.env.PORT) || 3000`. */
function jsConfigPort(text, blockKey) {
  const b = blockAfter(text, new RegExp("\\b" + blockKey + "\\s*:\\s*\\{"));
  if (!b) return null;
  // only direct children: blank out nested blocks
  let body = "";
  let depth = 0;
  for (let i = 0; i < b.body.length; i++) {
    const c = b.body[i];
    if (c === "{") depth++;
    if (depth <= 1 || c === "\n") body += c;
    else body += " ";
    if (c === "}") depth--;
  }
  const direct = /\bport\s*:\s*['"]?(\d{1,5})['"]?\s*[,}\n]/.exec(body);
  const fallback = /\bport\s*:[^,\n}]*?(?:\|\||\?\?)\s*['"]?(\d{1,5})['"]?/.exec(body);
  const envRef = /\bport\s*:[^,\n}]*process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\])/.exec(body);
  const m = direct || fallback;
  const strict = /\bstrictPort\s*:\s*true\b/.test(body);
  if (!m) return { port: null, strict, line: lineOfOffset(text, b.offset) };
  return {
    port: toPort(m[1]),
    strict,
    line: lineOfOffset(text, b.offset + m.index),
    envVar: envRef ? envRef[1] || envRef[2] : null,
  };
}

// ---------------------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------------------
const DEFAULTS = {
  exclude: ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**", "**/.next/**", "**/.nuxt/**", "**/.svelte-kit/**", "**/vendor/**", "**/.venv/**", "**/venv/**", "**/__pycache__/**", "**/target/**", "**/coverage/**"],
  ignorePorts: [],
  databasePorts: [5432, 3306, 6379, 27017, 9200, 11211, 5984, 1433, 26257, 8086],
  airPlayNote: "always",
  privilegedPortNote: true,
  codeFallbacks: true,
};

const DB_NAMES = { 5432: "PostgreSQL", 3306: "MySQL/MariaDB", 6379: "Redis", 27017: "MongoDB", 9200: "Elasticsearch/OpenSearch", 11211: "Memcached", 5984: "CouchDB", 1433: "SQL Server", 26257: "CockroachDB", 8086: "InfluxDB" };

function normalizeConfig(c) {
  const s = Object.assign({}, DEFAULTS, c || {});
  s.ignorePorts = (Array.isArray(s.ignorePorts) ? s.ignorePorts : []).map(toPort).filter(Boolean);
  s.databasePorts = (Array.isArray(s.databasePorts) ? s.databasePorts : DEFAULTS.databasePorts).map(toPort).filter(Boolean);
  if (!["always", "macOSOnly", "off"].includes(s.airPlayNote)) s.airPlayNote = "always";
  return s;
}

const COMPOSE_RE = /^(?:docker-)?compose(?:[.-][\w.-]+)?\.ya?ml$/i;
const CODE_RE = /\.(?:[cm]?js|jsx|[cm]?ts|tsx|py)$/i;

function classifyFile(rel) {
  const base = path.posix.basename(rel);
  if (COMPOSE_RE.test(base)) return "compose";
  if (envFileKind(base)) return "env";
  if (base === "package.json") return "package";
  if (/^vite\.config\.[cm]?[jt]s$/.test(base)) return "vite";
  if (/^astro\.config\.[cm]?[jt]s$/.test(base)) return "astro";
  if (/^webpack(?:\.[\w-]+)*\.config\.[cm]?[jt]s$|^webpack\.config\.[cm]?[jt]s$/.test(base)) return "webpack";
  if (base === "angular.json") return "angular";
  if (base === "Procfile" || /^Procfile\.[\w-]+$/.test(base)) return "procfile";
  if (base === "Makefile" || base === "makefile" || base === "GNUmakefile" || /\.mk$/.test(base)) return "makefile";
  if (/\.(?:sh|bash|zsh)$/.test(base)) return "shell";
  if (base === "devcontainer.json" || base === ".devcontainer.json") return "devcontainer";
  if (base === "launch.json" && /(?:^|\/)\.vscode\/launch\.json$/.test(rel)) return "launch";
  if (/\.ya?ml$/i.test(base)) return "yaml";
  if (CODE_RE.test(base)) return "code";
  return null;
}

/**
 * @param {{abs:string, rel:string, root:string, text:string}[]} files
 * @param {object} config
 */
function buildModel(files, config) {
  const cfg = normalizeConfig(config);
  const sources = [];
  const findings = [];
  const byAbs = new Map(files.map((f) => [f.abs, f]));
  const linesCache = new Map();
  const linesOf = (f) => {
    if (!linesCache.has(f.abs)) linesCache.set(f.abs, String(f.text).split(/\r?\n/));
    return linesCache.get(f.abs);
  };
  const relOf = (abs) => (byAbs.get(abs) ? byAbs.get(abs).rel : abs);

  // -- .env files: directory -> key -> {value, file, line}
  const envByDir = new Map();
  const envTemplatesByDir = new Map();
  for (const f of files) {
    if (classifyFile(f.rel) !== "env") continue;
    const kind = envFileKind(path.posix.basename(f.rel));
    const dir = path.dirname(f.abs);
    const target = kind === "template" ? envTemplatesByDir : envByDir;
    if (!target.has(dir)) target.set(dir, new Map());
    const map = target.get(dir);
    // precedence: .env.development.local > .env.local > .env.development > .env
    const rank = /\.local$/.test(f.rel) ? (/\.env\.local$/.test(f.rel) ? 2 : 3) : /\.env$/.test(f.rel) ? 0 : 1;
    for (const e of parseDotenv(f.text)) {
      const prev = map.get(e.key);
      if (!prev || prev.rank <= rank) map.set(e.key, { value: e.value, file: f.abs, line: e.line, rank });
      if (isPortKey(e.key) && toPort(e.value)) {
        sources.push({
          id: "env:" + dir + ":" + e.key,
          kind: "env",
          scope: "reference",
          lo: toPort(e.value),
          hi: toPort(e.value),
          ip: "",
          proto: "tcp",
          file: f.abs,
          line: e.line,
          label: path.posix.basename(f.rel) + " " + e.key + "=" + e.value,
          vars: [e.key],
          template: kind === "template",
        });
      }
    }
  }
  for (const [dir, m] of envTemplatesByDir) if (!envByDir.has(dir)) envByDir.set(dir, m);

  const rootOf = (abs) => {
    const f = byAbs.get(abs);
    return f ? f.root : path.parse(abs).root;
  };
  /** nearest-first lookup walking up to the workspace root */
  const envLookup = (dir, root, sameDirOnly) => (name) => {
    let d = dir;
    for (;;) {
      const m = envByDir.get(d);
      if (m && m.has(name)) return m.get(name);
      if (sameDirOnly || d === root || path.dirname(d) === d) return undefined;
      d = path.dirname(d);
    }
  };

  // -- per-directory JS/JSON configs (vite, astro, angular, webpack)
  const configByDir = new Map();
  const cfgOf = (dir) => {
    if (!configByDir.has(dir)) configByDir.set(dir, {});
    return configByDir.get(dir);
  };

  const addSource = (s) => {
    if (!s.lo) return;
    s.ip = s.ip || "";
    s.proto = s.proto || "tcp";
    s.hi = s.hi || s.lo;
    sources.push(s);
  };

  for (const f of files) {
    const kind = classifyFile(f.rel);
    const dir = path.dirname(f.abs);
    const lines = linesOf(f);
    if (kind === "vite" || kind === "astro") {
      const r = jsConfigPort(f.text, "server");
      if (r) cfgOf(dir)[kind] = r;
      if (r && r.port) {
        addSource({ id: "app:" + dir, kind, scope: "host", lo: r.port, file: f.abs, line: r.line, label: path.posix.basename(f.rel) + " server.port" + (r.envVar ? " (fallback, " + r.envVar + " unset)" : ""), vars: r.envVar ? [r.envVar] : [], tool: kind, strict: r.strict });
      }
    } else if (kind === "webpack") {
      const r = jsConfigPort(f.text, "devServer");
      if (r && r.port) {
        cfgOf(dir).webpack = r;
        addSource({ id: "app:" + dir, kind, scope: "host", lo: r.port, file: f.abs, line: r.line, label: path.posix.basename(f.rel) + " devServer.port", vars: r.envVar ? [r.envVar] : [], tool: "webpack" });
      }
    } else if (kind === "angular") {
      const j = parseJsonc(f.text);
      if (!j || typeof j.projects !== "object" || !j.projects) continue;
      for (const [pname, proj] of Object.entries(j.projects)) {
        const targets = proj && (proj.architect || proj.targets);
        const serve = targets && targets.serve;
        const port = serve && serve.options && toPort(serve.options.port);
        if (!port) continue;
        const pl = findLine(lines, new RegExp('"' + escapeRe(pname) + '"\\s*:'), 0, 0);
        const line = findLine(lines, new RegExp('"port"\\s*:\\s*' + port + "\\b"), pl, pl);
        cfgOf(dir).angular = { port };
        addSource({ id: "app:" + dir, kind, scope: "host", lo: port, file: f.abs, line, label: "angular.json " + pname + " serve port", vars: [], tool: "ng serve" });
      }
    }
  }

  const pushCommand = (cmd, meta) => {
    for (const seg of splitSegments(cmd)) {
      let res;
      try {
        res = commandPorts(seg, meta.ctx);
      } catch (_) {
        res = [];
      }
      for (const r of res) {
        addSource({
          id: r.tool === "kubectl port-forward" || r.docker ? "cmd:" + meta.file + ":" + meta.line + ":" + r.port : meta.id,
          kind: meta.kind,
          scope: "host",
          lo: r.port,
          hi: r.portEnd,
          ip: r.ip,
          proto: r.proto,
          file: meta.file,
          line: meta.line,
          label: meta.label + " (" + r.tool + (r.isDefault ? ", default port" : "") + ")",
          vars: r.vars,
          refs: r.refs,
          tool: r.tool,
          isDefault: r.isDefault,
          strict: r.strict,
          docker: !!r.docker,
          target: r.target,
        });
      }
    }
  };

  for (const f of files) {
    const kind = classifyFile(f.rel);
    const dir = path.dirname(f.abs);
    const lines = linesOf(f);
    const ctx = { lookup: envLookup(dir, f.root), config: configByDir.get(dir) || {} };
    if (kind === "package") {
      const j = parseJsonc(f.text);
      if (!j || !j.scripts || typeof j.scripts !== "object") continue;
      const sl = findLine(lines, /"scripts"\s*:/, 0, 0);
      for (const [name, cmd] of Object.entries(j.scripts)) {
        if (typeof cmd !== "string") continue;
        const line = findLine(lines, new RegExp('^\\s*"' + escapeRe(name) + '"\\s*:'), sl, sl);
        pushCommand(cmd, { id: "app:" + dir, kind: "script", file: f.abs, line, label: 'package.json script "' + name + '"', ctx });
      }
    } else if (kind === "procfile") {
      lines.forEach((l, i) => {
        const m = /^([A-Za-z0-9_-]+)\s*:\s*(.+)$/.exec(l);
        if (m) pushCommand(m[2], { id: "app:" + dir, kind: "procfile", file: f.abs, line: i, label: path.posix.basename(f.rel) + " " + m[1], ctx });
      });
    } else if (kind === "makefile" || kind === "shell") {
      let target = null;
      lines.forEach((l, i) => {
        const t = /^([A-Za-z0-9_.%/-]+)\s*:(?!=)/.exec(l);
        if (kind === "makefile" && t) target = t[1];
        const isRecipe = kind === "makefile" ? /^\t/.test(l) : !/^\s*#/.test(l);
        if (!isRecipe || !l.trim()) return;
        const cmd = l.replace(/^\t[@+-]*/, "").replace(/\$\(([A-Za-z_][A-Za-z0-9_]*)\)/g, "${$1}");
        pushCommand(cmd, { id: "cmd:" + f.abs + ":" + i, kind, file: f.abs, line: i, label: path.posix.basename(f.rel) + (target ? " " + target : "") + " line " + (i + 1), ctx });
      });
    } else if (kind === "devcontainer") {
      const j = parseJsonc(f.text);
      if (!j) continue;
      const fl = findLine(lines, /"forwardPorts"\s*:/, 0, 0);
      for (const p of Array.isArray(j.forwardPorts) ? j.forwardPorts : []) {
        const port = toPort(p) || (typeof p === "string" && /:(\d{1,5})$/.test(p) ? toPort(p.split(":").pop()) : null);
        if (port) addSource({ id: "devc-fwd:" + f.abs + ":" + port, kind: "devcontainer", scope: "forward", lo: port, file: f.abs, line: fl, label: "devcontainer.json forwardPorts " + JSON.stringify(p), vars: [] });
      }
      const al = findLine(lines, /"appPort"\s*:/, 0, 0);
      const ap = j.appPort === undefined ? [] : Array.isArray(j.appPort) ? j.appPort : [j.appPort];
      for (const p of ap) {
        const sp = typeof p === "number" ? { lo: toPort(p), hi: toPort(p), ip: "", proto: "tcp" } : parseShortPort(String(p));
        if (sp && sp.lo) addSource({ id: "devc:" + f.abs, kind: "devcontainer", scope: "host", lo: sp.lo, hi: sp.hi, ip: sp.ip, proto: sp.proto, file: f.abs, line: al, label: "devcontainer.json appPort " + JSON.stringify(p), vars: [], docker: true });
      }
    } else if (kind === "launch") {
      const j = parseJsonc(f.text);
      if (!j || !Array.isArray(j.configurations)) continue;
      for (const c of j.configurations) {
        if (!c || typeof c !== "object" || c.request !== "launch") continue;
        const name = String(c.name || c.type || "launch");
        const cl = findLine(lines, new RegExp('"name"\\s*:\\s*"' + escapeRe(name) + '"'), 0, 0);
        const env = c.env && typeof c.env === "object" ? c.env : {};
        for (const [k, v] of Object.entries(env)) {
          if (!isPortKey(k) || !toPort(String(v))) continue;
          const line = findLine(lines, new RegExp('"' + escapeRe(k) + '"\\s*:'), cl, cl);
          addSource({ id: "launch:" + f.abs + ":" + name, kind: "launch", scope: "host", lo: toPort(String(v)), file: f.abs, line, label: 'launch.json "' + name + '" env ' + k, vars: [k] });
        }
        const args = Array.isArray(c.args) ? c.args.map(String) : [];
        const pv = flagValue(args, ["--port"]);
        if (pv !== undefined && toPort(pv)) {
          const line = findLine(lines, /"--port/, cl, cl);
          addSource({ id: "launch:" + f.abs + ":" + name, kind: "launch", scope: "host", lo: toPort(pv), file: f.abs, line, label: 'launch.json "' + name + '" --port', vars: [] });
        }
      }
    }
  }

  // -- compose + kubernetes YAML
  const composeServices = []; // for PC004: {dir, name, buildDir, env: Map}
  for (const f of files) {
    const kind = classifyFile(f.rel);
    if (kind !== "compose" && kind !== "yaml") continue;
    if (kind === "yaml" && !/\b(?:kind|services)\s*:/.test(f.text)) continue;
    const dir = path.dirname(f.abs);
    const lines = linesOf(f);
    let docs;
    try {
      docs = parseYamlDocuments(f.text);
    } catch (_) {
      docs = [];
    }
    for (const d of docs) {
      const doc = d.value;
      if (!isObj(doc)) continue;
      if (isObj(doc.services) && (kind === "compose" || !doc.kind)) {
        if (kind !== "compose" && !Object.values(doc.services).some((s) => isObj(s) && (s.image !== undefined || s.build !== undefined || s.ports !== undefined))) continue;
        const lookup = envLookup(dir, f.root, true);
        for (const [svc, def] of Object.entries(doc.services)) {
          if (!isObj(def)) continue;
          const svcLine = keyLine(doc.services, svc);
          const envMap = new Map();
          const envLineBase = keyLine(def, "environment");
          if (isObj(def.environment)) {
            for (const [k, v] of Object.entries(def.environment)) envMap.set(k, { value: v === null ? undefined : String(v), line: keyLine(def.environment, k), file: f.abs });
          } else if (Array.isArray(def.environment)) {
            const info = LINE_INFO.get(def.environment);
            def.environment.forEach((e, i) => {
              const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:=(.*))?$/.exec(String(e));
              if (m) envMap.set(m[1], { value: m[2], line: info ? info.items[i] : envLineBase, file: f.abs });
            });
          }
          for (const [k, v] of envMap) {
            if (v.value === undefined) continue;
            v.value = interpolate(v.value, lookup).text;
          }
          let buildDir = null;
          if (typeof def.build === "string") buildDir = path.resolve(dir, interpolate(def.build, lookup).text);
          else if (isObj(def.build) && typeof def.build.context === "string") buildDir = path.resolve(dir, interpolate(def.build.context, lookup).text);
          composeServices.push({ dir, name: svc, buildDir, env: envMap, file: f.abs, line: svcLine });
          if (def.network_mode === "host") continue;
          if (!Array.isArray(def.ports)) continue;
          const info = LINE_INFO.get(def.ports);
          const image = typeof def.image === "string" ? def.image : "";
          def.ports.forEach((p, i) => {
            const line = info && info.items[i] >= 0 ? info.items[i] : svcLine;
            let sp = null;
            let vars = [];
            let refs = [];
            if (typeof p === "string") {
              const r = interpolate(p, lookup);
              vars = r.vars;
              refs = r.refs;
              sp = parseShortPort(r.text);
            } else if (isObj(p)) {
              if (p.published === undefined || p.published === null) return;
              const pub = interpolate(String(p.published), lookup);
              const ipI = p.host_ip ? interpolate(String(p.host_ip), lookup) : { text: "", vars: [], refs: [] };
              const tgt = p.target === undefined ? "" : interpolate(String(p.target), lookup).text;
              vars = pub.vars.concat(ipI.vars);
              refs = pub.refs.concat(ipI.refs);
              const r = parseRange(pub.text);
              if (r) sp = { ip: normIp(ipI.text), lo: r[0], hi: r[1], target: tgt, proto: (p.protocol || "tcp").toLowerCase() };
            }
            if (!sp) return;
            addSource({
              id: "compose:" + dir + ":" + svc,
              kind: "compose",
              scope: "host",
              lo: sp.lo,
              hi: sp.hi,
              ip: sp.ip,
              proto: sp.proto,
              file: f.abs,
              line,
              label: path.posix.basename(f.rel) + " service " + svc + ' ports "' + (typeof p === "string" ? p : portLabel(sp.lo, sp.hi) + ":" + sp.target) + '"',
              vars,
              refs,
              docker: true,
              service: svc,
              image,
              target: String(sp.target),
            });
          });
        }
        continue;
      }
      if (typeof doc.kind === "string" && typeof doc.apiVersion === "string") {
        const name = (isObj(doc.metadata) && doc.metadata.name) || "?";
        const ns = (isObj(doc.metadata) && doc.metadata.namespace) || "";
        if (doc.kind === "Service" && isObj(doc.spec) && Array.isArray(doc.spec.ports)) {
          doc.spec.ports.forEach((p) => {
            if (!isObj(p)) return;
            const np = toPort(p.nodePort);
            if (np) addSource({ id: "k8s:" + ns + "/Service/" + name, kind: "k8s", scope: "cluster", lo: np, file: f.abs, line: keyLine(p, "nodePort"), label: "Service " + name + " nodePort", vars: [], proto: String(p.protocol || "TCP").toLowerCase() });
          });
        }
        const walk = (node, depth) => {
          if (depth > 12 || !node || typeof node !== "object") return;
          if (Array.isArray(node)) return node.forEach((x) => walk(x, depth + 1));
          for (const key of ["containers", "initContainers"]) {
            if (!Array.isArray(node[key])) continue;
            for (const c of node[key]) {
              if (!isObj(c) || !Array.isArray(c.ports)) continue;
              for (const p of c.ports) {
                if (!isObj(p)) continue;
                const proto = String(p.protocol || "TCP").toLowerCase();
                const hp = toPort(p.hostPort);
                if (hp) addSource({ id: "k8s:" + ns + "/" + doc.kind + "/" + name, kind: "k8s", scope: "node", lo: hp, file: f.abs, line: keyLine(p, "hostPort"), label: doc.kind + " " + name + " container " + (c.name || "?") + " hostPort", vars: [], proto, ip: p.hostIP ? normIp(p.hostIP) : "" });
                const cp = toPort(p.containerPort);
                if (cp) addSource({ id: "k8s-c:" + f.abs + ":" + keyLine(p, "containerPort"), kind: "k8s", scope: "container", lo: cp, file: f.abs, line: keyLine(p, "containerPort"), label: doc.kind + " " + name + " container " + (c.name || "?") + " containerPort", vars: [], proto });
              }
            }
          }
          for (const k of Object.keys(node)) if (k !== "containers" && k !== "initContainers") walk(node[k], depth + 1);
        };
        walk(doc.spec, 0);
      }
    }
  }

  // ignore list
  const kept = sources.filter((s) => !cfg.ignorePorts.some((p) => p >= s.lo && p <= s.hi));
  sources.length = 0;
  for (const s of kept) {
    if (s.line === undefined || s.line < 0) s.line = 0;
    s.rel = relOf(s.file);
    sources.push(s);
  }

  // -- identity linking: sources resolved through the same env var from the same .env entry
  // (or the .env entry itself) are the same service
  const envKey = (s) => {
    const out = [];
    for (const r of s.refs || []) if (r.file) out.push(r.file + "#" + r.name);
    return out;
  };
  const parent = new Map();
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const s of sources) if (!parent.has(s.id)) parent.set(s.id, s.id);
  const byEnvKey = new Map();
  for (const s of sources) {
    for (const k of envKey(s)) {
      if (byEnvKey.has(k)) union(byEnvKey.get(k), s.id);
      else byEnvKey.set(k, s.id);
    }
  }
  for (const s of sources) s.group = find(s.id);

  // -- PC001 conflicts
  const binds = sources.filter((s) => s.scope === "host" || s.scope === "cluster" || s.scope === "node");
  const ipCompatible = (a, b) => a.ip === "" || b.ip === "" || a.ip === b.ip;
  const conflicts = new Map(); // source -> [other]
  const clashPorts = new Set();
  for (let i = 0; i < binds.length; i++) {
    for (let j = i + 1; j < binds.length; j++) {
      const a = binds[i];
      const b = binds[j];
      if (a.scope !== b.scope || a.proto !== b.proto) continue;
      if (a.group === b.group) continue;
      if (a.hi < b.lo || b.hi < a.lo) continue;
      if (!ipCompatible(a, b)) continue;
      if (!conflicts.has(a)) conflicts.set(a, []);
      if (!conflicts.has(b)) conflicts.set(b, []);
      conflicts.get(a).push(b);
      conflicts.get(b).push(a);
      clashPorts.add(a.scope + ":" + Math.max(a.lo, b.lo));
    }
  }
  const scopeWord = { host: "host port", cluster: "cluster nodePort", node: "node hostPort" };
  for (const [s, others] of conflicts) {
    const uniq = Array.from(new Set(others));
    const ov = uniq.map((o) => portLabel(Math.max(s.lo, o.lo), Math.min(s.hi, o.hi)));
    const portText = Array.from(new Set(ov)).join(", ");
    let msg = "Port clash: " + scopeWord[s.scope] + " " + portText + "/" + s.proto + " is also claimed by " + uniq.map((o) => o.label + " (" + o.rel + ":" + (o.line + 1) + ")").join("; ") + ".";
    if (s.scope === "host") msg += " Only one can listen at a time (EADDRINUSE).";
    else if (s.scope === "cluster") msg += " The API server rejects a second Service with the same nodePort.";
    else msg += " Pods with the same hostPort cannot be scheduled on the same node.";
    const soft = [s].concat(uniq).find((x) => (x.tool === "vite" || x.kind === "vite") && !x.strict);
    if (soft) msg += " Note: Vite silently moves to the next free port unless server.strictPort is true.";
    findings.push({
      code: "PC001",
      severity: "error",
      file: s.file,
      line: s.line,
      message: msg,
      port: s.lo,
      source: s,
      related: uniq.map((o) => ({ file: o.file, line: o.line, message: o.label + " also binds " + portLabel(o.lo, o.hi) })),
    });
  }

  // -- PC002 known-busy / privileged ports
  const seen002 = new Set();
  for (const s of sources) {
    if (s.scope !== "host") continue;
    const key = s.file + ":" + s.line + ":" + s.lo;
    if (seen002.has(key)) continue;
    seen002.add(key);
    if (cfg.airPlayNote !== "off" && (cfg.airPlayNote === "always" || process.platform === "darwin")) {
      const hit = [5000, 7000].filter((p) => p >= s.lo && p <= s.hi);
      if (hit.length) {
        findings.push({ code: "PC002", severity: "info", file: s.file, line: s.line, port: hit[0], source: s, message: "Port " + hit.join(" and ") + " is used by AirPlay (Apple lists TCP 5000 and 7000 for AirPlay). On a Mac with AirPlay Receiver turned on, the port is already taken and the server fails with EADDRINUSE or answers with 403 from AirTunes. Pick another port or turn off AirPlay Receiver in System Settings > General > AirDrop & Handoff." });
      }
    }
    if (cfg.privilegedPortNote && s.lo < 1024 && !s.docker) {
      findings.push({ code: "PC002", severity: "info", file: s.file, line: s.line, port: s.lo, source: s, message: "Port " + s.lo + " is a privileged port (below 1024). On Linux, binding it needs root or CAP_NET_BIND_SERVICE unless net.ipv4.ip_unprivileged_port_start is lowered, so this dev server will fail with EACCES for a normal user. Use a port >= 1024 and let a proxy or Docker publish 80/443." });
    }
  }

  // -- PC003 database/cache published on all interfaces
  for (const s of sources) {
    if (s.kind !== "compose" || s.ip !== "") continue;
    const tgt = parseRange(String(s.target || "").split("/")[0]);
    const dbPort = cfg.databasePorts.find((p) => (tgt && p >= tgt[0] && p <= tgt[1]) || (!tgt && p >= s.lo && p <= s.hi));
    if (!dbPort) continue;
    const name = DB_NAMES[dbPort] || "database/cache";
    findings.push({
      code: "PC003",
      severity: "warning",
      file: s.file,
      line: s.line,
      port: s.lo,
      source: s,
      message: "Service " + s.service + " publishes " + name + " (container port " + dbPort + ") on all interfaces (0.0.0.0) - anyone on your network can reach it, and Docker's published ports bypass host firewalls such as ufw. Bind it to loopback: \"127.0.0.1:" + portLabel(s.lo, s.hi) + ":" + s.target + "\".",
    });
  }

  // -- PC004 code fallbacks disagreeing with .env / compose
  if (cfg.codeFallbacks) {
    const JS_RE = /process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\])\s*\)?\s*(?:\|\||\?\?)\s*['"]?(\d{1,5})['"]?/g;
    const PY_RE = /os\.(?:getenv|environ\.get)\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*,\s*['"]?(\d{1,5})['"]?\s*\)/g;
    for (const f of files) {
      if (classifyFile(f.rel) !== "code" || !/PORT/.test(f.text)) continue;
      const lines = linesOf(f);
      const dir = path.dirname(f.abs);
      const lookup = envLookup(dir, f.root);
      const svc = composeServices.filter((c) => c.buildDir && (dir === c.buildDir || dir.startsWith(c.buildDir + path.sep))).sort((a, b) => b.buildDir.length - a.buildDir.length)[0];
      lines.forEach((l, i) => {
        const hits = [];
        let m;
        JS_RE.lastIndex = 0;
        while ((m = JS_RE.exec(l))) hits.push({ name: m[1] || m[2], fb: toPort(m[3]), col: m.index });
        PY_RE.lastIndex = 0;
        while ((m = PY_RE.exec(l))) hits.push({ name: m[1], fb: toPort(m[2]), col: m.index });
        for (const h of hits) {
          if (!isPortKey(h.name) || !h.fb || cfg.ignorePorts.includes(h.fb)) continue;
          const decl = [];
          const e = lookup(h.name);
          if (e && toPort(e.value) && toPort(e.value) !== h.fb) decl.push({ where: path.posix.basename(relOf(e.file)) + " sets " + h.name + "=" + e.value, file: e.file, line: e.line });
          if (svc && svc.env.has(h.name)) {
            const ce = svc.env.get(h.name);
            if (toPort(ce.value) && toPort(ce.value) !== h.fb) decl.push({ where: "compose service " + svc.name + " sets " + h.name + "=" + ce.value, file: ce.file, line: ce.line });
          }
          if (!decl.length) continue;
          findings.push({
            code: "PC004",
            severity: "info",
            file: f.abs,
            line: i,
            col: h.col,
            port: h.fb,
            message: h.name + " falls back to " + h.fb + " in code, but " + decl.map((d) => d.where + " (" + relOf(d.file) + ":" + (d.line + 1) + ")").join(" and ") + ". When the variable is not loaded (plain `node`/`python` run, tests, a new teammate), the app silently listens on " + h.fb + " instead.",
            related: decl.map((d) => ({ file: d.file, line: d.line, message: d.where })),
          });
        }
      });
    }
  }

  // -- port map
  const ports = new Map();
  for (const s of sources) {
    const key = s.scope + ":" + portLabel(s.lo, s.hi) + "/" + s.proto;
    if (!ports.has(key)) ports.set(key, { key, lo: s.lo, hi: s.hi, proto: s.proto, scope: s.scope, sources: [], findings: [] });
    ports.get(key).sources.push(s);
  }
  for (const f of findings) {
    if (!f.source) continue;
    const key = f.source.scope + ":" + portLabel(f.source.lo, f.source.hi) + "/" + f.source.proto;
    if (ports.has(key)) ports.get(key).findings.push(f);
  }
  const portList = Array.from(ports.values()).sort((a, b) => a.lo - b.lo || a.hi - b.hi || a.scope.localeCompare(b.scope));
  const hostBindCount = new Set(sources.filter((s) => s.scope === "host").map((s) => portLabel(s.lo, s.hi) + "/" + s.proto)).size;

  return { sources, findings, ports: portList, clashCount: clashPorts.size, hostBindCount, relOf, config: cfg };
}

// ---------------------------------------------------------------------------------------
// Live check: /proc/net/tcp parser (Linux) + local listen probe (other OS)
// ---------------------------------------------------------------------------------------
function hexToIp(hex) {
  if (hex.length === 8) {
    const b = [];
    for (let i = 6; i >= 0; i -= 2) b.push(parseInt(hex.slice(i, i + 2), 16));
    return b.join(".");
  }
  if (hex.length === 32) {
    const groups = [];
    for (let w = 0; w < 4; w++) {
      const word = hex.slice(w * 8, w * 8 + 8);
      const bytes = [word.slice(6, 8), word.slice(4, 6), word.slice(2, 4), word.slice(0, 2)].join("");
      groups.push(bytes.slice(0, 4), bytes.slice(4, 8));
    }
    const s = groups.map((g) => parseInt(g, 16).toString(16)).join(":");
    if (s === "0:0:0:0:0:0:0:0") return "::";
    if (s === "0:0:0:0:0:0:0:1") return "::1";
    const v4 = /^0:0:0:0:0:ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(s);
    if (v4) {
      const n = (parseInt(v4[1], 16) << 16) | parseInt(v4[2], 16);
      return "::ffff:" + [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
    }
    return s;
  }
  return hex;
}

/** Parses /proc/net/tcp or /proc/net/tcp6 text; returns listening sockets only (st == 0A). */
function parseProcNetTcp(text) {
  const out = [];
  const lines = String(text).split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].trim().split(/\s+/);
    if (cols.length < 4) continue;
    const local = cols[1];
    const st = cols[3];
    if (st.toUpperCase() !== "0A") continue;
    const m = /^([0-9A-Fa-f]+):([0-9A-Fa-f]{4})$/.exec(local);
    if (!m) continue;
    out.push({ ip: hexToIp(m[1]), port: parseInt(m[2], 16) });
  }
  return out;
}

/** Ports the listen probe may ever bind: unprivileged, valid TCP ports only. */
const PROBE_MIN = 1024;
const PROBE_MAX = 65535;
const PROBE_TIMEOUT_MS = 1500;
/** Upper bound for one live check with the listen probe, so a scan can never stall on it. */
const LIVE_BUDGET_MS = 5000;
const LIVE_MAX_PROBES = 300;

function probeable(port) {
  return Number.isInteger(port) && port >= PROBE_MIN && port <= PROBE_MAX;
}

/**
 * Bind probe: listens on 127.0.0.1:<port> with Node's net module and closes it again.
 * Resolves "inuse" | "free" | "unknown".
 *
 * Safety:
 * - a privileged (< 1024) or invalid port is never bound: it resolves "unknown" without
 *   creating a socket;
 * - the server is closed on every path: success, error, timeout, and a late "listening"
 *   event after the timeout (the "listening" handler always closes);
 * - incoming connections during the probe are destroyed at once, and the handle is unref'd so
 *   it never keeps the extension host alive.
 * Callers skip ports that are already known to be in use (/proc/net/tcp on Linux).
 */
function bindProbe(port, netModule) {
  if (!probeable(port)) return Promise.resolve("unknown");
  const net = netModule || require("net");
  return new Promise((resolve) => {
    let done = false;
    let t = null;
    const finish = (v) => {
      if (done) return;
      done = true;
      if (t) clearTimeout(t);
      resolve(v);
    };
    let srv;
    try {
      srv = net.createServer();
    } catch (_) {
      finish("unknown");
      return;
    }
    const close = (cb) => {
      try {
        srv.close(cb);
      } catch (_) {
        if (cb) cb();
      }
    };
    if (typeof srv.unref === "function") srv.unref();
    srv.on("connection", (sock) => {
      try {
        sock.destroy();
      } catch (_) {
        /* ignore */
      }
    });
    srv.on("listening", () => close(() => finish("free")));
    srv.on("error", (e) => {
      close();
      finish(e && e.code === "EADDRINUSE" ? "inuse" : "unknown");
    });
    t = setTimeout(() => {
      close();
      finish("unknown");
    }, PROBE_TIMEOUT_MS);
    try {
      srv.listen({ port, host: "127.0.0.1", exclusive: true });
    } catch (_) {
      close();
      finish("unknown");
    }
  });
}

const CONNECT_TIMEOUT_MS = 300;

/**
 * Connect probe: opens a TCP connection to 127.0.0.1:<port> and destroys it as soon as it is
 * established (or fails). Nothing is ever written. A listener on 127.0.0.1 or on all interfaces
 * (0.0.0.0 / ::) accepts it, so this catches the case where macOS and Windows would let a
 * loopback bind succeed next to a wildcard listener.
 * Resolves "inuse" (connected) | "refused" (ECONNREFUSED: nothing listens on loopback) |
 * "unknown" (timeout or any other error).
 */
function connectProbe(port, netModule, timeoutMs) {
  if (!probeable(port)) return Promise.resolve("unknown");
  const net = netModule || require("net");
  return new Promise((resolve) => {
    let done = false;
    let t = null;
    let sock = null;
    const kill = () => {
      try {
        if (sock) sock.destroy();
      } catch (_) {
        /* ignore */
      }
    };
    const finish = (v) => {
      kill();
      if (done) return;
      done = true;
      if (t) clearTimeout(t);
      resolve(v);
    };
    try {
      sock = net.connect({ port, host: "127.0.0.1" });
    } catch (_) {
      finish("unknown");
      return;
    }
    if (typeof sock.unref === "function") sock.unref();
    if (typeof sock.setNoDelay === "function") sock.setNoDelay(true);
    sock.on("connect", () => finish("inuse"));
    sock.on("data", () => kill());
    sock.on("error", (e) => finish(e && e.code === "ECONNREFUSED" ? "refused" : "unknown"));
    t = setTimeout(() => finish("unknown"), timeoutMs === undefined ? CONNECT_TIMEOUT_MS : timeoutMs);
  });
}

/**
 * Port probe used by the live check and Find Free Port Near...: never touches a port below
 * 1024. On every OS except Linux it first tries the connect probe; a connection means the port
 * is in use (and nothing is bound). Otherwise the bind probe decides.
 */
async function probePort(port, netModule, opts) {
  if (!probeable(port)) return "unknown";
  opts = opts || {};
  const platform = opts.platform || process.platform;
  if (platform !== "linux") {
    const c = await connectProbe(port, netModule, opts.connectTimeoutMs);
    if (c === "inuse") return "inuse";
  }
  return bindProbe(port, netModule);
}

/**
 * @returns {Promise<{method:string, inUse:Map<number,string>, partial?:boolean}>} port -> "listening on <ip>"
 */
async function liveListening(ports, opts) {
  opts = opts || {};
  const platform = opts.platform || process.platform;
  const readFile = opts.readFile || ((p) => fs.readFileSync(p, "utf8"));
  const inUse = new Map();
  if (platform === "linux") {
    let ok = false;
    for (const p of ["/proc/net/tcp", "/proc/net/tcp6"]) {
      let text;
      try {
        text = readFile(p);
        ok = true;
      } catch (_) {
        continue;
      }
      for (const s of parseProcNetTcp(text)) {
        if (!ports.has(s.port)) continue;
        const prev = inUse.get(s.port);
        if (!prev || !prev.split(", ").includes(s.ip)) inUse.set(s.port, prev ? prev + ", " + s.ip : s.ip);
      }
    }
    if (ok) return { method: "/proc/net/tcp", inUse };
  }
  const probe = opts.probe || ((p) => probePort(p, null, { platform }));
  const now = opts.now || Date.now;
  const budget = opts.budgetMs === undefined ? LIVE_BUDGET_MS : opts.budgetMs;
  const list = Array.from(ports).filter(probeable).sort((a, b) => a - b).slice(0, LIVE_MAX_PROBES);
  const startedAt = now();
  let partial = false;
  for (const p of list) {
    if (now() - startedAt > budget) {
      partial = true;
      break;
    }
    if ((await probe(p)) === "inuse") inUse.set(p, "127.0.0.1");
  }
  return { method: platform === "linux" ? "listen probe on 127.0.0.1" : "local connect + listen probe on 127.0.0.1", inUse, partial };
}

function liveFindings(model, live) {
  const out = [];
  const seen = new Set();
  for (const s of model.sources) {
    if (s.scope !== "host") continue;
    for (let p = s.lo; p <= Math.min(s.hi, s.lo + 63); p++) {
      if (!live.inUse.has(p)) continue;
      const k = s.file + ":" + s.line + ":" + p;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ code: "PC005", severity: "info", file: s.file, line: s.line, port: p, source: s, message: "Port " + p + " is in use on this machine (listening on " + live.inUse.get(p) + ", checked via " + live.method + "). If it is not this project already running, " + s.label + " will fail with EADDRINUSE." });
    }
  }
  return out;
}

function declaredPortSet(model) {
  const set = new Set();
  for (const s of model.sources) if (s.scope === "host") for (let p = s.lo; p <= Math.min(s.hi, s.lo + 63); p++) set.add(p);
  return set;
}

const FREE_PORT_WINDOW = 200;

/**
 * Next port after `start` that is not declared in the workspace, not 5000/7000, and free.
 * Only unprivileged ports are suggested (and probed): for a start below 1024 the search
 * begins at 1024. On Linux, ports that /proc/net/tcp lists as listening are skipped without
 * ever being bound.
 * @returns {Promise<{port:number|null, from:number, to:number}>}
 */
async function findFreePortRange(start, model, opts) {
  opts = opts || {};
  const declared = declaredPortSet(model);
  const probe = opts.probe || ((p) => probePort(p, null, { platform: opts.platform }));
  const from = Math.max(PROBE_MIN, (Number(start) || 0) + 1);
  const to = Math.min(PROBE_MAX, from + FREE_PORT_WINDOW - 1);
  let procBusy = null;
  if ((opts.platform || process.platform) === "linux" && from <= to) {
    try {
      const live = await liveListening(new Set(Array.from({ length: to - from + 1 }, (_, i) => from + i)), opts);
      if (live.method === "/proc/net/tcp") procBusy = live.inUse;
    } catch (_) {
      procBusy = null;
    }
  }
  for (let p = from; p <= to; p++) {
    if (declared.has(p) || p === 5000 || p === 7000) continue;
    if (procBusy && procBusy.has(p)) continue;
    const r = await probe(p);
    if (r === "free") return { port: p, from, to };
  }
  return { port: null, from, to };
}

async function findFreePort(start, model, opts) {
  return (await findFreePortRange(start, model, opts)).port;
}

// ---------------------------------------------------------------------------------------
// View rows (pure, unit-tested): one row per declared port, labelled with the code and the
// exact port, described with the rule and the owners; plus one row per code-only finding.
// ---------------------------------------------------------------------------------------
const SEV_RANK = { error: 0, warning: 1, info: 2 };
const SCOPE_TAG = { reference: ".env", forward: "forwardPorts", container: "containerPort", node: "hostPort", cluster: "nodePort" };
const CODE_TITLE = { PC001: "port clash", PC002: "busy or privileged port", PC003: "database on 0.0.0.0", PC004: "PORT fallback disagrees", PC005: "in use on this machine" };

function bySeverity(a, b) {
  return SEV_RANK[a.severity] - SEV_RANK[b.severity] || a.code.localeCompare(b.code);
}

/** Short owner name of a source, e.g. "service api (compose.yaml)" or "next dev (apps/web/package.json)". */
function ownerName(s) {
  let short;
  if (s.kind === "compose" && s.service) short = "service " + s.service;
  else if (s.kind === "env") short = s.label.slice(s.label.indexOf(" ") + 1);
  else if (s.tool && s.kind !== "vite" && s.kind !== "astro" && s.kind !== "webpack" && s.kind !== "angular") short = s.tool;
  else short = s.label;
  return short + " (" + s.rel + ")";
}

function portRowLabel(code, lo, hi, proto, scope) {
  return (code ? code + "  " : "") + portLabel(lo, hi) + "/" + (proto || "tcp") + (SCOPE_TAG[scope] ? " (" + SCOPE_TAG[scope] + ")" : "");
}

/**
 * @returns {{kind:"port"|"finding", key:string, label:string, description:string, tooltip:string,
 *   severity:string|null, code:string|null, g?:object, finding?:object, sources:object[], findings:object[]}[]}
 */
function viewRows(model, findings) {
  const rows = [];
  for (const g of model.ports) {
    const fs2 = findings.filter((f) => f.source && g.sources.includes(f.source)).sort(bySeverity);
    const worst = fs2[0] || null;
    const codes = Array.from(new Set(fs2.map((f) => f.code)));
    const owners = Array.from(new Set(g.sources.map(ownerName)));
    rows.push({
      kind: "port",
      key: "port:" + g.key,
      label: portRowLabel(worst && worst.code, g.lo, g.hi, g.proto, g.scope),
      description: (codes.length ? codes.map((c) => CODE_TITLE[c] || c).join(", ") + ": " : "") + owners.join(", "),
      tooltip:
        portLabel(g.lo, g.hi) + "/" + g.proto + " (" + g.scope + ")\n" +
        g.sources.map((s) => s.label + " - " + s.rel + ":" + (s.line + 1)).join("\n") +
        (fs2.length ? "\n\n" + Array.from(new Set(fs2.map((f) => f.code + ": " + f.message))).join("\n") : ""),
      severity: worst ? worst.severity : null,
      code: worst ? worst.code : null,
      g,
      sources: g.sources,
      findings: fs2,
      port: g.lo,
      scope: g.scope,
    });
  }
  findings.forEach((f, i) => {
    if (f.source) return;
    const rel = model.relOf ? model.relOf(f.file) : f.file;
    rows.push({
      kind: "finding",
      key: "finding:" + f.code + ":" + f.file + ":" + f.line + ":" + i,
      label: portRowLabel(f.code, f.port, f.port, "tcp", ""),
      description: (CODE_TITLE[f.code] || f.code) + ": " + rel + ":" + (f.line + 1),
      tooltip: f.code + ": " + f.message + "\n" + rel + ":" + (f.line + 1),
      severity: f.severity,
      code: f.code,
      finding: f,
      sources: [],
      findings: [f],
      port: f.port,
      scope: "code",
    });
  });
  rows.sort((a, b) => {
    const ra = a.severity ? SEV_RANK[a.severity] : 9;
    const rb = b.severity ? SEV_RANK[b.severity] : 9;
    return ra - rb || (a.code || "").localeCompare(b.code || "") || a.port - b.port || a.label.localeCompare(b.label);
  });
  return rows;
}

function statusText(model, live) {
  return "$(plug) Ports: " + model.hostBindCount + " · " + plural(model.clashCount, "clash", "clashes") + (live ? " · " + live.inUse.size + " in use" : "");
}

function markdownMap(model) {
  const rows = ["| Port | Scope | Source | Location | Findings |", "| :--- | :--- | :--- | :--- | :--- |"];
  for (const g of model.ports) {
    for (const s of g.sources) {
      const fs2 = model.findings.filter((f) => f.source === s).map((f) => f.code);
      rows.push("| " + portLabel(g.lo, g.hi) + "/" + g.proto + " | " + g.scope + " | " + s.label.replace(/\|/g, "\\|") + " | `" + s.rel + ":" + (s.line + 1) + "` | " + (fs2.length ? Array.from(new Set(fs2)).join(", ") : "-") + " |");
    }
  }
  const counts = {};
  for (const f of model.findings) counts[f.code] = (counts[f.code] || 0) + 1;
  return (
    "# PortClash port map\n\n" +
    plural(model.hostBindCount, "host port") +
    " declared, " +
    plural(model.clashCount, "clash", "clashes") +
    ".\n\n" +
    (Object.keys(counts).length ? Object.keys(counts).sort().map((k) => "- " + k + ": " + counts[k]).join("\n") + "\n\n" : "") +
    rows.join("\n") +
    "\n\nScopes: host = binds on this machine; forward = devcontainer forwardPorts (mirrors a container port, never a clash); reference = .env value (resolves other sources); container = Kubernetes containerPort; node / cluster = Kubernetes hostPort / nodePort.\n"
  );
}

// ---------------------------------------------------------------------------------------
// VS Code integration
// ---------------------------------------------------------------------------------------
// Two tiers so that code files can never crowd the declaration files out of portClash.maxFiles.
const CONFIG_GLOB = "**/{docker-compose*.yml,docker-compose*.yaml,compose*.yml,compose*.yaml,.env,.env.*,package.json,vite.config.*,astro.config.*,webpack*.config.*,angular.json,Procfile,Procfile.*,Makefile,makefile,GNUmakefile,*.mk,*.sh,*.bash,*.zsh,devcontainer.json,.devcontainer.json,launch.json,*.yaml,*.yml}";
const CODE_GLOB = "**/{*.js,*.mjs,*.cjs,*.ts,*.mts,*.cts,*.jsx,*.tsx,*.py}";
const WATCH_RE = /(?:compose[^/\\]*\.ya?ml|\.env(?:\.[^/\\]*)?|package\.json|\.config\.[cm]?[jt]s|angular\.json|Procfile[^/\\]*|[Mm]akefile|\.mk|\.(?:sh|bash|zsh)|devcontainer\.json|launch\.json|\.ya?ml|\.[cm]?[jt]sx?|\.py)$/;
const MAX_FILE_BYTES = 1024 * 1024;
const POLL_MS = 30000;
const LIVE_REUSE_MS = 30000;
const VIEW_ID = "portClash.ports";

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function activate(context) {
  const vscode = require("vscode");
  const diagnostics = vscode.languages.createDiagnosticCollection("portclash");
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 40);
  status.command = "portClash.showPortMap";
  context.subscriptions.push(diagnostics, status);
  const treeEmitter = new vscode.EventEmitter();
  context.subscriptions.push(treeEmitter);

  const emptyModel = () => ({ sources: [], findings: [], ports: [], clashCount: 0, hostBindCount: 0, relOf: (p) => p });
  let model = emptyModel();
  let live = null;
  let liveCache = null; // { key, at, result }
  let findings = [];
  let rows = [];
  let enabled = true;
  let scanPromise = null;
  let dirty = false;
  let forceLive = false;
  let timer = null;
  let pollTimer = null;
  let disposed = false;
  let scanCount = 0;
  /** fsPath -> { mtimeMs, size, text, real } so periodic rescans only re-read changed files. */
  const fileCache = new Map();

  const ui = {
    info: (m, ...items) => vscode.window.showInformationMessage(m, ...items),
    warn: (m) => vscode.window.showWarningMessage(m),
  };

  function readSettings() {
    const c = vscode.workspace.getConfiguration("portClash");
    let checkListening = c.get("checkListening", false);
    if (!vscode.workspace.isTrusted) {
      // an untrusted workspace cannot switch the live check on through its own settings
      const i = c.inspect("checkListening");
      checkListening = !!(i && i.globalValue);
    }
    const maxFiles = Number(c.get("maxFiles", 5000));
    return {
      enabled: c.get("enabled", true),
      checkListening,
      exclude: c.get("exclude", DEFAULTS.exclude),
      ignorePorts: c.get("ignorePorts", []),
      databasePorts: c.get("databasePorts", DEFAULTS.databasePorts),
      airPlayNote: c.get("airPlayNote", "always"),
      privilegedPortNote: c.get("privilegedPortNote", true),
      codeFallbacks: c.get("codeFallbacks", true),
      maxFiles: Number.isFinite(maxFiles) && maxFiles > 0 ? Math.floor(maxFiles) : 5000,
    };
  }

  const SEV = () => ({ error: vscode.DiagnosticSeverity.Error, warning: vscode.DiagnosticSeverity.Warning, info: vscode.DiagnosticSeverity.Information });

  async function realRoots() {
    const out = [];
    for (const f of vscode.workspace.workspaceFolders || []) {
      if (f.uri.scheme !== "file") continue;
      try {
        out.push(await fs.promises.realpath(f.uri.fsPath));
      } catch (_) {
        /* folder gone */
      }
    }
    return out;
  }

  async function find(glob, exclude, max) {
    if (max <= 0) return [];
    try {
      return await vscode.workspace.findFiles(glob, exclude, max);
    } catch (_) {
      return [];
    }
  }

  /** Code / YAML / shell / Makefile text that never mentions "port" is not kept in memory. */
  const needsPortWord = (kind) => kind === "code" || kind === "yaml" || kind === "shell" || kind === "makefile";

  async function readCandidate(uri, roots, kind) {
    const fsPath = uri.fsPath;
    let st;
    try {
      st = await fs.promises.stat(fsPath);
    } catch (_) {
      fileCache.delete(fsPath);
      return null;
    }
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    const hit = fileCache.get(fsPath);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit;
    let real;
    try {
      real = await fs.promises.realpath(fsPath);
    } catch (_) {
      return null;
    }
    // a symlink that leads out of every workspace folder is never read
    if (!roots.some((r) => isInside(real, r))) return null;
    let text;
    try {
      text = await fs.promises.readFile(fsPath, "utf8");
    } catch (_) {
      return null;
    }
    const entry = { mtimeMs: st.mtimeMs, size: st.size, text: needsPortWord(kind) && !/port/i.test(text) ? null : text, real };
    fileCache.set(fsPath, entry);
    return entry;
  }

  async function collectFiles(s) {
    const folders = vscode.workspace.workspaceFolders || [];
    if (!folders.length) return [];
    const exclude = (s.exclude || []).length ? "{" + s.exclude.join(",") + "}" : undefined;
    const excludeRes = (s.exclude || []).map((g) => {
      try {
        return globToRegExp(g);
      } catch (_) {
        return null;
      }
    }).filter(Boolean);
    const tier1 = await find(CONFIG_GLOB, exclude, s.maxFiles);
    const seen = new Set(tier1.map((u) => u.toString()));
    const tier2 = (await find(CODE_GLOB, exclude, s.maxFiles - tier1.length)).filter((u) => !seen.has(u.toString()));
    const uris = tier1.concat(tier2).slice(0, s.maxFiles);
    const roots = await realRoots();
    const openDocs = new Map(vscode.workspace.textDocuments.filter((d) => d.uri.scheme === "file").map((d) => [d.uri.fsPath, d]));
    const out = [];
    const live = new Set();
    const jobs = [];
    for (const uri of uris) {
      if (uri.scheme !== "file") continue;
      const folder = vscode.workspace.getWorkspaceFolder(uri);
      if (!folder) continue;
      const root = folder.uri.fsPath;
      const rel = path.relative(root, uri.fsPath).split(path.sep).join("/");
      if (excludeRes.some((re) => re.test(rel))) continue;
      const kind = classifyFile(rel);
      if (!kind) continue;
      live.add(uri.fsPath);
      jobs.push({ uri, root, rel, kind });
    }
    // read in small batches so a big workspace never blocks the extension host
    for (let i = 0; i < jobs.length; i += 32) {
      const batch = jobs.slice(i, i + 32);
      const texts = await Promise.all(
        batch.map(async (j) => {
          const doc = openDocs.get(j.uri.fsPath);
          if (doc && doc.isDirty) {
            const real = await fs.promises.realpath(j.uri.fsPath).catch(() => null);
            return real && roots.some((r) => isInside(real, r)) ? doc.getText() : null;
          }
          const e = await readCandidate(j.uri, roots, j.kind);
          return e ? e.text : null;
        })
      );
      batch.forEach((j, k) => {
        const text = texts[k];
        if (text === null || text === undefined) return;
        if (needsPortWord(j.kind) && !/port/i.test(text)) return;
        out.push({ abs: j.uri.fsPath, rel: j.rel, root: j.root, text });
      });
    }
    for (const k of Array.from(fileCache.keys())) if (!live.has(k)) fileCache.delete(k);
    return out;
  }

  function publish() {
    const byFile = new Map();
    const sev = SEV();
    const linesCache = new Map();
    const lineText = (file, line) => {
      if (!linesCache.has(file)) {
        const doc = vscode.workspace.textDocuments.find((d) => d.uri.scheme === "file" && d.uri.fsPath === file);
        let lines = [];
        if (doc) lines = doc.getText().split(/\r?\n/);
        else if (fileCache.has(file) && fileCache.get(file).text !== null) lines = fileCache.get(file).text.split(/\r?\n/);
        linesCache.set(file, lines);
      }
      return linesCache.get(file)[line] || "";
    };
    for (const f of findings) {
      if (!byFile.has(f.file)) byFile.set(f.file, []);
      const text = lineText(f.file, f.line);
      const start = typeof f.col === "number" ? f.col : text.length - text.trimStart().length;
      const d = new vscode.Diagnostic(new vscode.Range(f.line, start, f.line, Math.max(start + 1, text.length)), f.message, sev[f.severity]);
      d.code = f.code;
      d.source = "PortClash";
      if (f.related && f.related.length) {
        d.relatedInformation = f.related.map((r) => new vscode.DiagnosticRelatedInformation(new vscode.Location(vscode.Uri.file(r.file), new vscode.Position(Math.max(0, r.line), 0)), r.message));
      }
      byFile.get(f.file).push(d);
    }
    diagnostics.clear();
    for (const [file, list] of byFile) diagnostics.set(vscode.Uri.file(file), list);
  }

  function updateStatus() {
    status.text = statusText(model, live);
    const counts = {};
    for (const f of findings) counts[f.code] = (counts[f.code] || 0) + 1;
    status.tooltip = "PortClash - " + plural(model.hostBindCount, "declared host port") + "\nPC001 port clash: " + (counts.PC001 || 0) + "\nPC002 busy/privileged port: " + (counts.PC002 || 0) + "\nPC003 database on 0.0.0.0: " + (counts.PC003 || 0) + "\nPC004 code fallback mismatch: " + (counts.PC004 || 0) + (live ? "\nPC005 in use now: " + (counts.PC005 || 0) + " (" + live.method + (live.partial ? ", partial" : "") + ")" : "") + "\nClick to show the port map.";
    if (enabled && model.sources.length) status.show();
    else status.hide();
  }

  let treeView = null;
  function updateBadge() {
    if (!treeView) return;
    const n = enabled ? model.clashCount : 0;
    treeView.badge = n ? { value: n, tooltip: plural(n, "port clash", "port clashes") } : undefined;
  }

  async function checkLive(force) {
    const declared = declaredPortSet(model);
    const key = Array.from(declared).sort((a, b) => a - b).join(",");
    if (!force && liveCache && liveCache.key === key && Date.now() - liveCache.at < LIVE_REUSE_MS) return liveCache.result;
    let result = null;
    try {
      result = await liveListening(declared);
    } catch (_) {
      result = null;
    }
    liveCache = { key, at: Date.now(), result };
    return result;
  }

  async function scan() {
    const s = readSettings();
    enabled = !!s.enabled;
    if (!s.enabled) {
      model = emptyModel();
      live = null;
      liveCache = null;
      fileCache.clear();
    } else {
      const files = await collectFiles(s);
      if (disposed) return model;
      model = buildModel(files, s);
      live = null;
      if (s.checkListening) {
        live = await checkLive(forceLive);
        forceLive = false;
      } else liveCache = null;
    }
    findings = live ? model.findings.concat(liveFindings(model, live)) : model.findings.slice();
    rows = viewRows(model, findings);
    scanCount++;
    if (disposed) return model;
    publish();
    updateStatus();
    updateBadge();
    treeEmitter.fire(undefined);
    return model;
  }

  /** Scans never overlap: a request during a scan runs one more scan right after it. */
  function rescan() {
    if (scanPromise) {
      dirty = true;
      return scanPromise;
    }
    scanPromise = (async () => {
      do {
        dirty = false;
        try {
          await scan();
        } catch (e) {
          console.error("PortClash scan failed:", e);
        }
      } while (dirty && !disposed);
      return model;
    })().finally(() => {
      scanPromise = null;
    });
    return scanPromise;
  }

  function schedule(ms) {
    if (disposed) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      rescan();
    }, ms === undefined ? 600 : ms);
  }

  // ---- tree ----------------------------------------------------------------------------
  const severityIcon = (sev) =>
    sev === "error"
      ? new vscode.ThemeIcon("error", new vscode.ThemeColor("list.errorForeground"))
      : sev === "warning"
        ? new vscode.ThemeIcon("warning", new vscode.ThemeColor("list.warningForeground"))
        : sev === "info"
          ? new vscode.ThemeIcon("info")
          : null;

  const treeProvider = {
    onDidChangeTreeData: treeEmitter.event,
    getChildren(el) {
      if (!enabled) return [];
      if (!el) return rows.map((r) => ({ type: r.kind, row: r }));
      if (el.type === "port") return el.row.sources.map((s, i) => ({ type: "source", row: el.row, s, i }));
      return [];
    },
    getTreeItem(el) {
      if (el.type === "port") {
        const r = el.row;
        const item = new vscode.TreeItem(r.label, r.findings.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
        item.id = r.key;
        item.description = r.description;
        item.tooltip = r.tooltip;
        item.iconPath = severityIcon(r.severity) || new vscode.ThemeIcon("plug");
        item.contextValue = r.scope === "host" ? (r.code === "PC001" ? "portClashClash" : "portClashPort") : "portClashOther";
        return item;
      }
      if (el.type === "finding") {
        const r = el.row;
        const item = new vscode.TreeItem(r.label, vscode.TreeItemCollapsibleState.None);
        item.id = r.key;
        item.description = r.description;
        item.tooltip = r.tooltip;
        item.iconPath = severityIcon(r.severity);
        item.contextValue = "portClashFinding";
        item.command = { command: "portClash.openSource", title: "Open", arguments: [{ type: "finding", f: r.finding }] };
        return item;
      }
      const s = el.s;
      const fs2 = findings.filter((f) => f.source === s).sort(bySeverity);
      const item = new vscode.TreeItem(s.label, vscode.TreeItemCollapsibleState.None);
      item.id = el.row.key + "|" + el.i + "|" + s.id + "|" + s.file + ":" + s.line;
      item.description = s.rel + ":" + (s.line + 1);
      item.tooltip = s.label + "\n" + s.rel + ":" + (s.line + 1) + (s.ip ? "\nbinds " + s.ip : "") + (fs2.length ? "\n\n" + fs2.map((f) => f.code + ": " + f.message).join("\n") : "");
      item.iconPath = severityIcon(fs2[0] && fs2[0].severity) || new vscode.ThemeIcon("circle-small");
      item.contextValue = "portClashSource";
      item.command = { command: "portClash.openSource", title: "Open", arguments: [{ type: "source", s }] };
      return item;
    },
  };
  treeView = vscode.window.createTreeView(VIEW_ID, { treeDataProvider: treeProvider, showCollapseAll: true });
  context.subscriptions.push(treeView);

  /**
   * Opens a source or finding from the view. The argument must be a live source / finding of
   * the current scan (or a file + line that matches one), and the file's realpath must be inside
   * a workspace folder; anything else is refused.
   */
  async function openSource(arg, lineArg) {
    let target = null;
    if (typeof arg === "string") target = { file: arg, line: lineArg };
    else if (arg && typeof arg === "object") target = arg.s || arg.f || arg;
    if (!target || typeof target.file !== "string" || !Number.isInteger(target.line)) return { status: "invalid" };
    const candidates = model.sources.concat(findings);
    const hit = candidates.find((x) => x === target) || candidates.find((x) => x.file === target.file && x.line === target.line);
    if (!hit) return { status: "not-live" };
    let real;
    try {
      real = await fs.promises.realpath(hit.file);
    } catch (_) {
      return { status: "missing" };
    }
    const roots = await realRoots();
    if (!roots.some((r) => isInside(real, r))) return { status: "outside-workspace" };
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(hit.file));
    const line = Math.max(0, Math.min(hit.line, doc.lineCount - 1));
    const pos = new vscode.Position(line, 0);
    await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos), preview: true });
    return { status: "opened", path: hit.file, line };
  }

  async function showPortMap() {
    if (scanPromise) await scanPromise;
    if (!model.sources.length) {
      ui.info(enabled ? "PortClash: no declared ports were found in this workspace." : "PortClash is turned off (portClash.enabled).");
      return { status: "empty" };
    }
    const m = Object.assign({}, model, { findings });
    const doc = await vscode.workspace.openTextDocument({ language: "markdown", content: markdownMap(m) });
    await vscode.window.showTextDocument(doc, { preview: true });
    return { status: "opened", content: doc.getText() };
  }

  async function findFree(arg) {
    if (scanPromise) await scanPromise;
    let start = null;
    if (typeof arg === "number") start = toPort(arg);
    else if (arg && typeof arg === "object") {
      if (arg.row && typeof arg.row.port === "number") start = toPort(arg.row.port);
      else if (typeof arg.port === "number") start = toPort(arg.port);
    }
    if (!start) {
      const clashes = model.ports.filter((g) => g.scope === "host" && model.findings.some((f) => f.code === "PC001" && g.sources.includes(f.source)));
      const items = clashes.map((g) => ({ label: "$(error) " + portLabel(g.lo, g.hi), description: g.sources.map(ownerName).join(", "), port: g.lo }));
      items.push({ label: "$(edit) Enter a port...", port: 0 });
      const pick = await vscode.window.showQuickPick(items, { placeHolder: "PortClash: find a free port near..." });
      if (!pick) return { status: "cancelled" };
      if (pick.port) start = pick.port;
      else {
        const v = await vscode.window.showInputBox({ prompt: "Find a free port after", validateInput: (x) => (toPort(x) ? null : "Enter a port between 1 and 65535") });
        if (!v) return { status: "cancelled" };
        start = toPort(v);
      }
    }
    const r = await findFreePortRange(start, model);
    if (!r.port) {
      ui.warn(r.from > r.to ? "PortClash: there is no port above " + start + " to suggest." : "PortClash: no free port found in " + r.from + "-" + r.to + " (after " + start + ").");
      return { status: "none", from: r.from, to: r.to };
    }
    const act = await ui.info("PortClash: " + r.port + " is free on this machine and not declared anywhere in the workspace (searched from " + r.from + ").", "Copy");
    if (act === "Copy") await vscode.env.clipboard.writeText(String(r.port));
    return { status: "found", port: r.port };
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("portClash.openSource", (arg, line) => openSource(arg, line)),
    vscode.commands.registerCommand("portClash.refresh", () => {
      forceLive = true;
      return rescan();
    }),
    vscode.commands.registerCommand("portClash.showPortMap", showPortMap),
    vscode.commands.registerCommand("portClash.findFreePort", findFree)
  );

  // ---- change tracking: watcher (fast path), save/edit events, focused-only polling ------
  const watcher = vscode.workspace.createFileSystemWatcher("**/*");
  const relevant = (uri) => uri && uri.scheme === "file" && WATCH_RE.test(uri.fsPath) && !/[\\/](?:node_modules|\.git)[\\/]/.test(uri.fsPath);
  const onFs = (uri) => {
    if (relevant(uri)) schedule();
  };

  function startPolling() {
    if (pollTimer || disposed) return;
    pollTimer = setInterval(() => {
      if (!vscode.window.state.focused) {
        stopPolling();
        return;
      }
      if (enabled) schedule(0);
    }, POLL_MS);
  }
  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  context.subscriptions.push(
    watcher,
    watcher.onDidCreate(onFs),
    watcher.onDidChange(onFs),
    watcher.onDidDelete(onFs),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.contentChanges.length && relevant(e.document.uri)) schedule(800);
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (relevant(doc.uri)) schedule(150);
    }),
    // closing an edited file without saving drops the unsaved text that the last scan used
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (relevant(doc.uri)) schedule();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => schedule()),
    vscode.workspace.onDidGrantWorkspaceTrust(() => schedule(100)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("portClash")) schedule(100);
    }),
    vscode.window.onDidChangeWindowState((w) => {
      if (disposed) return;
      if (w.focused) {
        startPolling();
        schedule(300);
      } else stopPolling();
    }),
    {
      dispose: () => {
        disposed = true;
        clearTimeout(timer);
        stopPolling();
      },
    }
  );
  if (vscode.window.state.focused) startPolling();

  const ready = rescan();
  return {
    ready,
    rescan: () => rescan(),
    getModel: () => model,
    getFindings: () => findings,
    getRows: () => rows,
    getTreeItems: () => treeProvider.getChildren().map((e) => treeProvider.getTreeItem(e)),
    getChildItems: (label) => {
      const top = treeProvider.getChildren().find((e) => e.row.label === label);
      return top ? treeProvider.getChildren(top).map((e) => treeProvider.getTreeItem(e)) : [];
    },
    getTopElements: () => treeProvider.getChildren(),
    getBadge: () => (treeView && treeView.badge ? treeView.badge.value : 0),
    isViewVisible: () => !!(treeView && treeView.visible),
    getStatusText: () => status.text || "",
    getLive: () => live,
    getScanCount: () => scanCount,
    isPolling: () => !!pollTimer,
    openSource,
    findFree,
    showPortMap,
    setUi: (o) => Object.assign(ui, o || {}),
    _tree: treeProvider,
    _status: status,
    _diagnostics: diagnostics,
  };
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
  _internals: {
    buildModel,
    parseShortPort,
    commandPorts,
    interpolate,
    parseDotenv,
    parseJsonc,
    parseProcNetTcp,
    hexToIp,
    liveListening,
    liveFindings,
    findFreePort,
    findFreePortRange,
    probePort,
    bindProbe,
    connectProbe,
    viewRows,
    ownerName,
    statusText,
    declaredPortSet,
    markdownMap,
    classifyFile,
    parseYamlDocuments,
    DEFAULTS,
  },
};
