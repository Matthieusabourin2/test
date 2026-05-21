# Sidecar

Local-only Node.js service backing the Claude Tasks Dashboard. Reads Claude
Code's lifecycle hooks (no cloud, no terminal, no LevelDB parsing) and uses
macOS Accessibility to open existing sessions in Claude Desktop.

## How it works

```
Claude Code (CLI + Desktop)
        │  emits SessionStart / Stop / PermissionRequest / Notification / …
        ▼
~/.claude/dashboard/hook.py  →  appends to  ~/.claude/dashboard-events.jsonl
        │
        ▼
sidecar tails the log, derives per-session status
        │
        ▼
/api/sessions  +  /api/events (SSE)  →  dashboard (http://localhost:8765)
```

## Setup (one time)

```bash
cd sidecar
node index.js
```

Open the URL it prints (default `http://localhost:8765/`), then click
**Installer les hooks** in the banner. That:

1. Writes the hook script to `~/.claude/dashboard/hook.py`
2. Registers it for every lifecycle event in `~/.claude/settings.json`
   (your existing settings are backed up to `settings.json.dashboard-backup.<ts>`)

From then on, every Claude Code session — CLI or Claude Desktop — fires the
hook, the sidecar sees the event in real time, and the dashboard updates.

### Opening sessions in Claude Desktop

Clicking a session in the dashboard runs `osascript` against Claude Desktop
via the macOS Accessibility API. On first use macOS will prompt you to grant
Accessibility permission to whatever ran the sidecar (Terminal / iTerm / your
shell). Open **System Settings → Privacy & Security → Accessibility** and
enable the prompted app. One-time setup.

## Status values

| Status         | Derived from                                                   |
|----------------|----------------------------------------------------------------|
| `working`      | `UserPromptSubmit` seen, no matching `Stop` yet                |
| `needs_action` | `PermissionRequest`, or `Notification` with permission/idle matcher |
| `ready`        | `Stop` received, nothing since                                 |
| `idle`         | No events for 10+ min while working, or just no activity       |
| `finished`     | `SessionEnd`                                                   |
| `unknown`      | Session JSONL exists but the dashboard never saw any hook event (e.g. session ran before hooks were installed) |

Sessions with no activity for 24h are dropped from the list (unless they
are in `needs_action`).

## API

| Endpoint                 | Method | Description                                          |
|--------------------------|--------|------------------------------------------------------|
| `/`                      | GET    | Serves the dashboard                                 |
| `/api/sessions`          | GET    | Current snapshot of all tracked sessions             |
| `/api/events`            | GET    | Server-Sent Events stream — pushes snapshots on change |
| `/api/install-hooks`     | POST   | Idempotent: installs the hook script and updates settings.json |
| `/api/open`              | POST   | `{ "title": "..." }` — asks Claude Desktop to focus and click that sidebar row |

## Files

```
sidecar/
├── index.js                      # the server
├── package.json
└── applescript/
    └── open-session.applescript  # AX click-by-title used by /api/open

hooks/
└── dashboard-event.py            # installed at ~/.claude/dashboard/hook.py
```

## Notes & limits

- **Claude Code sessions only.** Hooks fire for Claude Code sessions (CLI and
  Desktop Code mode). Cowork and Chat sessions don't go through this hook
  pipeline; they're not surfaced by this version.
- **No cloud.** The sidecar only reads local files; no network calls leave
  your machine.
- **No terminal.** Opening a session goes through Accessibility into Claude
  Desktop, not via a terminal command.
- **Idempotent install.** Running the install endpoint twice is safe — the
  dashboard's hook entry is removed and re-added rather than duplicated, and
  the previous `settings.json` is always backed up first.

## Configuration

- `PORT` env var (default `8765`)
