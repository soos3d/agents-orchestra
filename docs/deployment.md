# Running it on a VPS

Orchestra on a remote box is an SSH tunnel, not a wider bind. `orchestra serve` runs on the VPS,
listens on loopback there, and your laptop reaches it through `ssh -L`. Capability is identical to
running it locally; the surface is unchanged.

## Loopback binding is the security model

There is no authentication anywhere in the dashboard, and that is deliberate — the bind is what
stands in for it. `src/web/server.ts` hardcodes `HOST = "127.0.0.1"` and passes it to
`server.listen`, so nothing outside the machine can open a socket at all. The origin check built on
top of that (`isAllowedOrigin`) exists for a narrower hole: WebSocket is a browser API that ignores
the same-origin policy, so any page in any tab could open `ws://127.0.0.1:<port>` and send `approve`
or `panic`. The check refuses any origin whose hostname is not in `LOOPBACK_HOSTS`
(`127.0.0.1`, `localhost`, `[::1]`, `::1`) or whose port is not the one the server bound.

Binding wider turns that check into decoration and leaves nothing behind it. A dashboard socket can
approve an outcome spec, sign off a plan, and start a mission whose every worker holds a real shell
on the box. Exposing that needs auth, TLS and a threat model, which is a different product — so do
not add a `--host` flag, a reverse proxy in front of `serve`, or a `0.0.0.0` bind. Forward the port
instead.

Nothing here is a service. `serve` is one process holding one port; there is no daemon, no queue and
no database inside the package. tmux or `systemd --user` below are the operating system keeping a
foreground command alive, and nothing in the package knows about either.

## Prerequisites on the VPS

- **Node 20 or newer.** `MIN_NODE_MAJOR` in `src/config/doctor.ts` is 20, and `orchestra doctor`
  fails the `node` check below it.
- **git**, if the missions write code. Without a repo `doctor` warns rather than fails — research and
  computer-use missions need none — but `code` tasks are unavailable.
- **`claude` or `codex` on PATH, already logged in.** Log in once interactively over SSH:
  ```bash
  npm i -g @anthropic-ai/claude-code && claude   # log in, then quit
  npm i -g @openai/codex             && codex    # log in, then quit
  ```
  `doctor` reports which transports this machine can actually start.
- **Provider keys exported in the shell that starts `serve`.** There is no dotenv and no env
  validation layer: `process.env` is read in exactly two places, `src/config/discover.ts` and
  `src/index.ts`. `discoverConfig` reads `NEBIUS_API_KEY` and `OLLAMA_API_KEY` through
  `readProviderKeys` (the names come from `PROVIDERS` in `src/providers/openaiCompatible.ts`), plus
  the optional overrides `TARGET_REPO`, `ORCHESTRA_STATE_DIR`, `WORKTREE_ROOT`,
  `ORCHESTRATOR_MODEL`, `MAX_CONCURRENCY`, `ORCHESTRA_CONTAINER_IMAGE` and `ORCHESTRA_GATEWAY_URL`.
  `src/index.ts` reads `ORCHESTRA_DEBUG`. Every one of them is optional; a variable set in some
  other shell than the one `serve` was launched from does not exist as far as the process is
  concerned.

Then, on the box:

```bash
npm i -g @soos3d/orchestra
orchestra doctor
```

Until the package is published, ship the tarball instead — no git remote or registry access needed
on the box:

```bash
npm run build && npm pack                       # on the laptop
scp soos3d-orchestra-*.tgz <vps>:/tmp/
ssh <vps> 'npm i -g /tmp/soos3d-orchestra-*.tgz && orchestra doctor'
```

## Pin the port

`serve` asks the kernel for a free port unless told otherwise — `startWebServer` listens on
`deps.port ?? 0`. A tunnel needs a number that does not move across restarts, so pass one:

```bash
orchestra serve --port 4600
```

`--port` is the only flag `serve` takes. Use the same number on both sides of the tunnel: the origin
check compares the browser's origin port against the port the server bound, so forwarding local 4000
to remote 4600 is refused with `Refused a dashboard socket from origin …` in the server's output.

## Keep it alive past the SSH session

### tmux

```bash
tmux new -s orchestra -d 'orchestra serve --port 4600'
tmux attach -t orchestra     # to watch it; Ctrl-B D to detach
```

`serve` runs until SIGINT, so `Ctrl-C` inside the session is how it stops.

### systemd --user

`~/.config/systemd/user/orchestra.service`:

```ini
[Unit]
Description=orchestra dashboard
After=network.target

[Service]
Type=simple
WorkingDirectory=%h/code/some-repo
Environment=PATH=%h/.nvm/versions/node/v22.11.0/bin:/usr/local/bin:/usr/bin:/bin
Environment=NEBIUS_API_KEY=…
ExecStart=%h/.nvm/versions/node/v22.11.0/bin/node %h/.nvm/versions/node/v22.11.0/lib/node_modules/@soos3d/orchestra/dist/index.js serve --port 4600
Restart=on-failure

[Install]
WantedBy=default.target
```

```bash
loginctl enable-linger "$USER"          # or the unit dies when you log out
systemctl --user daemon-reload
systemctl --user enable --now orchestra
journalctl --user -u orchestra -f
```

Two things the unit has to get right. **`ExecStart` runs `node` on the entry point, not the
`orchestra` shim** — a user unit does not inherit the login shell's PATH, and the shim starts
`#!/usr/bin/env node`, so under nvm it dies with `/usr/bin/env: 'node': No such file or directory`
and `status=127` five times before systemd gives up. Pointing at the binary's absolute path is not
enough; the interpreter has to be absolute too. `command -v node` and
`npm root -g` on the box give both halves (`Environment=PATH=…` in front of the shim works as well).
**`Environment=PATH` is the same trap one layer along, and it fails quietly.** Without it the
server starts, serves the dashboard, and reports `✗ workers — no coding agent on PATH` while
`orchestra doctor` in your SSH session (which sourced nvm) reports `✓ workers claude`. `doctor`
probes what *this process* can start, and a user unit's PATH is `/usr/bin:/bin` — so nvm's `claude`
does not exist to it. The `acp` row goes with it.

And `WorkingDirectory` matters: the directory `serve` starts in becomes the default workspace, the
one the rail labels *where serve was started* and the only one that cannot be removed.

Keys in `Environment=` land in a unit file readable by your user; `EnvironmentFile=%h/.config/orchestra.env`
with mode 0600 keeps them out of `systemctl cat`.

## The tunnel

From the laptop:

```bash
ssh -N -L 4600:127.0.0.1:4600 <vps>
```

Then open `http://127.0.0.1:4600`. `-N` runs no remote command; drop it if you want a shell in the
same connection. `serve` prints its own URL on the box (`dashboard: http://127.0.0.1:4600`) and that
is the same address on your side, which is exactly why the origin check is satisfied.

Add this to `~/.ssh/config` so the forward comes up with the connection:

```
Host vps
  HostName 203.0.113.10
  User you
  LocalForward 4600 127.0.0.1:4600
```

## Adding the repos you want worked on

Once the page is up, the left rail is the workspace list. The directory `serve` started in is
already there. To add another:

1. Open **another directory** on the rail.
2. Type the path — `~/code/ledger` — and press **check**. The server resolves it and reports what it
   found; it is the resolution you were shown, not the string you typed, that gets added.
3. Press **add this directory**, or **create it and add it** when the path does not exist yet.

A workspace you have not been shown cannot be added, which is why the two steps are separate. Each
workspace runs one composed mission at a time; a second compose in the same directory is refused
with the mission id already running there. Workspaces persist under the state directory, so they
survive a restart — the default one is not persisted, because it is the cwd.

Missions themselves are composed from the page: goal, harness, models, budget. Terminal access on
the box stays useful for the two grants a browser deliberately cannot make — `--env NAME` for a
credential and `--scan <name>` for a specialist scanner — both of which are `orchestra run` flags.
