# Sidecar

Local-only Node.js service backing the Claude Dashboard. Surfaces Claude Code,
Claude Cowork, and Claude Chat sessions in one unified view, and opens any of
them in Claude Desktop on the correct conversation via AppleScript.

## How it works

```
~/.claude/projects/<encoded-path>/<id>.jsonl       (Code, with ai-title + first-user-message fallback)
~/Library/Application Support/Claude/
  local-agent-mode-sessions/.../local_*.json       (Cowork, title field directly)
Claude Desktop's sidebar via macOS Accessibility   (Chat, via JXA osascript)

~/.claude/dashboard-events.jsonl                   (live status from hook script)
        │
        ▼
sidecar aggregates → /api/sessions  +  /api/events (SSE)  →  dashboard
        │
        ▼ (on click)
POST /api/open → osascript activates Claude Desktop, AXPress the matching row
```

## Start it

```bash
cd sidecar
node index.js
# → http://localhost:8765/
```

Open the URL in your browser. Code + Cowork show up immediately.

### Chat needs two things

1. **Claude Desktop must have its main window open** (not just running in the dock).
   If you closed the window with the red X, click the Dock icon to reopen.
2. **The terminal that runs the sidecar must have macOS Accessibility permission**.
   First time you click a session in the dashboard, macOS asks. Approve in
   *System Settings → Privacy & Security → Accessibility*.

When Claude Desktop has no visible window, the dashboard shows a yellow banner
saying so — Code and Cowork stay functional.

## Status values (Code only — derived from `~/.claude/dashboard-events.jsonl`)

| Status         | Trigger                                                              |
|----------------|----------------------------------------------------------------------|
| `working`      | recent `PreToolUse` / `UserPromptSubmit` / `SubagentStart` (< 5 min) |
| `needs_action` | last event = `PermissionRequest` (Claude is waiting on you)          |
| `ready`        | last event = `Stop` / `PostToolUse`                                  |
| `idle`         | nothing recent, or last event > 24h ago                              |
| `finished`     | last event = `SessionEnd`                                            |

Cowork sessions use mtime-based heuristics. Chat sessions have no status
(Claude Desktop's AX tree doesn't expose it).

## API

| Endpoint            | Method | Description                                                     |
|---------------------|--------|-----------------------------------------------------------------|
| `/`                 | GET    | Serves the dashboard                                            |
| `/api/sessions`     | GET    | Current snapshot (sessions + AX state)                          |
| `/api/events`       | GET    | Server-Sent Events — pushes snapshots on every change           |
| `/api/open`         | POST   | `{ "title": "..." }` — focus Claude Desktop and click that row  |
| `/api/debug/ax`     | GET    | Raw AX tree dump — useful when Chat parsing misses sessions     |

## Files

```
sidecar/
├── index.js                          # server
├── package.json
├── applescript/
│   ├── open-session.applescript      # click-by-title via AXPress
│   └── read-claude-sidebar.js        # JXA AX dumper for Chat list

hooks/
└── dashboard-event.py                # installed at ~/.claude/dashboard/hook.py,
                                       # wired into ~/.claude/settings.json
                                       # → writes events to dashboard-events.jsonl
```

## What does NOT work and why

- **Chat via LevelDB** — Claude Desktop's IndexedDB contains only
  editor drafts (`tipTapEditorState`), starred IDs, and ~12 internal UUIDs.
  No chat list, no titles, no metadata. The chat history is fetched from
  claude.ai on-demand, not persisted locally.
- **`claude://chat/<id>` deep links** — silently ignored by Claude Desktop
  on this version. Opening goes through AppleScript instead.
- **Status for Chat sessions** — AX doesn't expose "Claude is currently
  generating" or "needs your input" for individual chat rows.

## Configuration

- `PORT` env var (default `8765`)
