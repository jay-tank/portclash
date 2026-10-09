<h1 align="center">PortClash</h1>

<p align="center">Find <code>port already in use</code> before you run anything.</p>

`Error: listen EADDRINUSE: address already in use :::3000`. You have seen it this week. Usually
the cause is sitting in the repo already: the compose file publishes `3000`, the admin app's
`vite.config.ts` also says `3000`, and the web app runs `next dev`, which defaults to `3000`.
Nobody wrote the three down side by side, so you only find out when the second one crashes, or
worse, when Vite quietly moves to `3001` and your OAuth callback stops working.

PortClash reads every place a port is declared in your workspace, lines them up, and reports the
conflicts in the Problems panel with links between the clashing lines.

- **PC001** two different sources bind the same host port (Error)
- **PC002** port 5000/7000 (AirPlay on macOS) or a privileged port for a dev server (Information)
- **PC003** a compose database or cache is published on `0.0.0.0` instead of `127.0.0.1` (Warning)
- **PC004** a `PORT` fallback in code disagrees with `.env` / compose (Information)
- **PC005** optional: a declared port is already in use on this machine right now (Information)

Where you see the results:

- **Problems panel**: one diagnostic per finding, with related links to the other lines.
- **Activity bar**: a PortClash view (**Ports**) lists every declared port, findings first. Each
  row is labelled with the code and the exact port (`PC001  3000/tcp`, `PC003  5432/tcp`,
  `6379/tcp`) and described with the rule and its owners (`port clash: next dev
  (apps/web/package.json), service api (compose.yaml)`). Expand a row to see the exact lines that
  claim the port and click one to jump to it. The badge shows the number of clashes; the title bar
  has Find Free Port Near..., Show Port Map and Refresh, and every host port row has an inline
  Find Free Port Near... button.
- **Status bar**: a plug icon with `Ports: 9 · 1 clash`; click it for the full port map.

## Sources

Only documented keys and documented framework defaults are used.

| Source | What is read | Reference |
| :--- | :--- | :--- |
| docker compose (`compose.yaml`, `docker-compose*.yml`, overrides) | `services.*.ports` short syntax (`"8080:80"`, `"127.0.0.1:5432:5432"`, `"3000-3005:3000-3005"`, `"[::1]:6001:6001"`, `/udp`) and long syntax (`published`, `target`, `host_ip`, `protocol`). Container-only entries (`"3000"`) and random host ports are skipped. `network_mode: host` services are skipped. | [Compose `ports`](https://docs.docker.com/reference/compose-file/services/#ports) |
| compose interpolation | `${VAR}`, `${VAR:-default}`, `${VAR-default}`, `$VAR`, resolved against the `.env` next to the compose file | [Compose interpolation](https://docs.docker.com/reference/compose-file/interpolation/) |
| `.env`, `.env.local`, `.env.development(.local)` | `PORT` and `*_PORT` keys. Used to resolve other sources and shown in the map; a `.env` value on its own is never a clash (a `DB_PORT` is usually a port you connect to, not one you bind). `.env.example` is used only when no `.env` exists in that folder. Production/test/CI env files are ignored. | - |
| package.json `scripts` | `next dev` / `next start` (default 3000, `-p`, `--port`, `PORT=`) | [Next.js CLI](https://nextjs.org/docs/app/api-reference/cli/next) |
| | `nuxt dev` / `nuxi dev` (default 3000, `-p`, `--port`, `NUXT_PORT` / `NITRO_PORT` / `PORT`) | [Nuxt dev](https://nuxt.com/docs/4.x/api/commands/dev) |
| | `vite`, `vite dev`, `vite serve` (default 5173, `--port`) | [Vite server.port](https://vite.dev/config/server-options#server-port) |
| | `astro dev` (default 4321, `--port`) | [Astro CLI](https://docs.astro.build/en/reference/cli-reference/) |
| | `ng serve` (default 4200, `--port`) | [ng serve](https://angular.dev/cli/serve) |
| | `webpack serve --port` (no default assumed) | [webpack devServer.port](https://webpack.js.org/configuration/dev-server/) |
| | `manage.py runserver [addr:]port` (default 127.0.0.1:8000) | [Django runserver](https://docs.djangoproject.com/en/stable/ref/django-admin/#runserver) |
| | `flask run` (default 127.0.0.1:5000, `-p`, `--port`, `FLASK_RUN_PORT`) | [Flask CLI](https://flask.palletsprojects.com/en/stable/cli/) |
| | `uvicorn` (default 127.0.0.1:8000, `--port`, `--host`) | [Uvicorn settings](https://uvicorn.dev/settings/) |
| | `docker run -p` / `--publish` (same syntax as compose) | [Compose `ports`](https://docs.docker.com/reference/compose-file/services/#ports) |
| | `kubectl port-forward ... LOCAL:REMOTE` (binds `localhost` unless `--address`) | [kubectl port-forward](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_port-forward/) |
| | any other command with an explicit `--port N` | - |
| `vite.config.*`, `astro.config.*` | `server.port` (also `port: Number(process.env.PORT) \|\| 3000`), Vite `server.strictPort` | [Vite](https://vite.dev/config/server-options#server-port) |
| `webpack*.config.*` | `devServer.port` | [webpack](https://webpack.js.org/configuration/dev-server/) |
| `angular.json` | `projects.*.architect/targets.serve.options.port` | [ng serve](https://angular.dev/cli/serve) |
| Procfile, Makefile recipes, `*.sh` | the same command patterns as package.json scripts | - |
| `.devcontainer/devcontainer.json` | `appPort` (published, can clash) and `forwardPorts` (forwarded from the container, listed but never a clash) | [devcontainer.json reference](https://containers.dev/implementors/json_reference/) |
| `.vscode/launch.json` | `launch` configurations: `env.PORT` / `env.*_PORT` and `args` `--port` | - |
| Kubernetes YAML | Service `nodePort` (clashes across Services), container `hostPort` (clashes across workloads), `containerPort` (listed only) | [Service](https://kubernetes.io/docs/concepts/services-networking/service/) |

Two sources that are really the same service are not reported against each other: scripts in
the same package (for example `next dev` and `next start`), a config file and the scripts next
to it (a `vite.config.ts` and its `vite` script), compose files for the same service, and any
sources that resolve their port through the same `.env` entry.

## Rules

| Code | Severity | Bad | Good |
| :--- | :--- | :--- | :--- |
| PC001 | Error | compose `api` publishes `"${API_PORT:-8080}:8080"` with `API_PORT=3000` in `.env`, and `apps/web` runs `next dev` (default 3000) | give one of them another port, e.g. `next dev -p 3001` |
| PC001 | Error | `grafana` publishes `"3100-3105:3100-3105"` and `loki` publishes `3103` | move `loki` outside the range |
| PC002 | Information | `flask run` (default 5000) or compose `"5000:5000"` - Apple lists TCP 5000 and 7000 for [AirPlay](https://support.apple.com/en-us/103229), so on a Mac with AirPlay Receiver on the port is already taken | use 5001 / 8000, or turn off AirPlay Receiver |
| PC002 | Information | `vite --port 80` as a normal user on Linux (privileged port, needs root or [`CAP_NET_BIND_SERVICE`](https://man7.org/linux/man-pages/man7/capabilities.7.html)) | `--port 8080`; Docker-published ports are not flagged |
| PC003 | Warning | `postgres` with `ports: ["5432:5432"]` - Compose binds all interfaces when no host IP is given, so the database is reachable from your network | `"127.0.0.1:5432:5432"` |
| PC004 | Information | `process.env.PORT \|\| 3000` in `apps/api` while compose sets `PORT: 8080` for that service | make the fallback match, or drop it and fail fast |
| PC005 | Information | (opt-in) `5432` is already listening on this machine | stop the other process, or pick another port |

PC004 recognises `process.env.X || N`, `process.env.X ?? N`, `Number(process.env.X) || N`,
`process.env["X"] || "N"`, `os.getenv("X", "N")` and `os.environ.get("X", N)` for `PORT` and
`*_PORT` variables, and compares them with the nearest `.env` and with the `environment:` of the
compose service whose `build` context contains the file.

## How this differs from existing tools

- **Port managers and killers** (Port Authority, Port Occupancy, Port, "kill port" extensions and
  CLIs) look at what is listening right now and help you stop it. They answer "who holds 3000?".
  PortClash answers the question before that: "which two things in this repo both want 3000?".
  It works without anything running, in a fresh clone or a PR checkout, and never kills
  processes.
- **Compose linters** (for example DCLint's no-duplicate-exported-ports rule) check duplicates
  inside compose files. PortClash also sees the dev servers, framework defaults, `.env`
  interpolation, devcontainer, launch configs and port-forwards that clash with compose.
- **VS Code's own port forwarding** quietly picks another local port when one is busy. That hides
  the clash instead of reporting it.

## Commands

| Command | What it does |
| :--- | :--- |
| `PortClash: Show Port Map` | Opens a Markdown table of every declared port, its scope, source, location and findings. |
| `PortClash: Find Free Port Near...` | Pick a clashing port (or type one) and get the next port that is not declared anywhere in the workspace, is not 5000/7000, and is free on this machine; one click copies it. Only ports 1024 and above are suggested. Also available inline in the Ports view. |
| `PortClash: Refresh` | Rescan now. Scans also run when a port file is saved or changed, and every 30 seconds while the window is focused (unchanged files are not re-read). |

## Settings

| Setting | Default | Description |
| :--- | :--- | :--- |
| `portClash.enabled` | `true` | Turn scanning on or off. |
| `portClash.checkListening` | `false` | Also report declared ports that are in use on this machine (PC005). See Privacy. |
| `portClash.ignorePorts` | `[]` | Ports to ignore completely. |
| `portClash.databasePorts` | `[5432, 3306, 6379, 27017, 9200, 11211, 5984, 1433, 26257, 8086]` | Container ports treated as databases/caches for PC003. |
| `portClash.airPlayNote` | `"always"` | `always`, `macOSOnly` or `off` for the 5000/7000 note. `always` is the default because a teammate on a Mac hits it even when you do not. |
| `portClash.privilegedPortNote` | `true` | Report dev servers on ports below 1024. |
| `portClash.codeFallbacks` | `true` | Run PC004 on JS/TS/Python files. |
| `portClash.exclude` | `node_modules`, `dist`, `build`, `.next`, `.venv`, ... | Globs that are never scanned. |
| `portClash.maxFiles` | `5000` | Maximum candidate files per scan. |

## Privacy

- No telemetry, no requests to any remote host, no child processes. Files are only read, never
  written. The only local connection is the optional live check on macOS and Windows (below).
- The static rules (PC001 to PC004) only read files in the workspace, so PortClash runs in
  untrusted workspaces too.
- The live check (PC005) is **off by default**. When you turn it on:
  - **Linux:** it reads `/proc/net/tcp` and `/proc/net/tcp6` and looks at sockets in the LISTEN
    state. No socket is opened.
  - **macOS and Windows:** for each declared port of 1024 or above, it opens and immediately
    closes a local connection to `127.0.0.1:<port>` only (300 ms timeout); no data is sent. If
    the connection is accepted, the port is in use and nothing is bound. This catches servers
    that listen on all interfaces (`0.0.0.0`), which these systems would otherwise let a
    loopback bind sit next to. If the connection is refused, it creates a server with Node's
    `net` module, calls `listen({ port, host: "127.0.0.1", exclusive: true })`, and closes it
    right away; `EADDRINUSE` means the port is taken. It only binds to loopback, which does not
    normally trigger a firewall prompt. Every socket is closed on every path (free, in use,
    error or timeout), a port below 1024 is never touched, and one check stops after 5 seconds.
    Results are reused for 30 seconds unless you press Refresh.
  - While a workspace is untrusted, `portClash.checkListening` is only honoured from your user
    settings, never from the workspace's `.vscode/settings.json`.
- **Find Free Port Near...** runs only when you invoke it and uses the same method (on Linux,
  `/proc/net/tcp` first, so a port that is already listening is never bound, then the loopback
  listen probe to confirm; on macOS and Windows, the local connection first, then the listen
  probe).
- Files reached through a symlink that leads outside the workspace folders are never read, and
  the view only opens files of the current scan inside the workspace.
- With Remote - SSH, WSL or Dev Containers the extension runs on the remote side, so the live
  check describes that machine.

## Limitations

- Static and best-effort: ports computed at runtime (`port: getPort()`, values from a secrets
  manager, `PORT` injected by a PaaS) are not seen. JS config files are read with patterns, not
  executed.
- Compose files are treated per project folder; `-f` combinations, profiles and `extends` are not
  evaluated, and all services are assumed to run together. Nested interpolation beyond one level
  of default is not resolved.
- Two services that are never started at the same time (for example a Makefile target that runs
  Postgres in `docker run` as an alternative to compose) are still reported; use
  `portClash.ignorePorts` or rename the port.
- Only documented framework defaults are assumed (listed above). `webpack serve` has no assumed
  default; Remix and SvelteKit run through Vite and are covered by the Vite rule.
- Next.js reads `PORT` only from the real environment, not from `.env`, so a `.env` `PORT` does
  not change the `next dev` port.
- The live check on macOS/Windows looks at `127.0.0.1` only: a process that listens on a single
  other interface (not loopback and not all interfaces) may not be detected. Ports below 1024
  are not probed. Ranges are checked for their first 64 ports.
- Kubernetes scopes are separate from the host: a `nodePort` never clashes with a local dev
  server.

## License

MIT - included with the extension.
