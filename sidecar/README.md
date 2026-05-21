# Sidecar

Local Node.js service that watches Claude on your Mac and exposes a unified
view of Claude Code, Claude Cowork, and (best-effort) Claude Chat sessions
to the dashboard in real time.

## Setup (one time)

```bash
cd sidecar
npm install          # pulls classic-level for LevelDB reads
node index.js
```

Then open the printed URL (default `http://localhost:8765/`).

## What it reads

| Source | Path | Format |
|---|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` | JSONL, plain text |
| Cowork | `~/Library/Application Support/Claude/local-agent-mode-sessions/<account>/<session>/local_*.json` | JSON |
| Chat conversations | `~/Library/Application Support/Claude/IndexedDB/https_claude.ai_0.indexeddb.leveldb/` | LevelDB + Blink serialization |
| Desktop "viewed" state | `~/Library/Application Support/Claude/shared_proto_db/` | LevelDB + protobuf |

For LevelDB sources, Claude Desktop holds an exclusive lock while it runs,
so the sidecar copies the directory to `$TMPDIR/claude-dashboard-leveldb/`
before opening. The copy is refreshed every 15 seconds.

## What you get

- 🔵 **en cours** — file activity in the last 60 seconds
- 🟢 **pas encore lu** — Claude finished something and Desktop hasn't recorded
  that you opened it. If `viewedAt` couldn't be extracted from `shared_proto_db`,
  the sidecar falls back to "unread" by default.
- 🟢 **lu** — `viewedAt >= lastEventTime` from Desktop's own state
- ⚪ **inactive** — > 24h since last activity (kept up to 7d then dropped)

Click a session to open it in Claude Desktop:
- **CODE** → tries `claude://code/<id>` and copies `claude --resume <id>` to clipboard
- **COWORK** → `claude://cowork/<id>`
- **CHAT** → `claude://claude.ai/chat/<id>`

## Caveats

- **Chat / Cowork / desktop-state are best-effort**. LevelDB itself is read
  reliably, but the *values* inside use Chromium-specific binary encodings
  (Blink structured-clone for IndexedDB, protobuf for shared_proto_db). We
  extract UUIDs, plausible UTF-8 strings, and 64-bit ms timestamps via
  pattern matching — not by decoding the full schema. Titles may show as
  partial strings or fallback to UUID prefixes.
- If `npm install` hasn't been run, the sidecar still works for Claude Code
  only and prints a warning.

## Configuration

- `PORT` env var (default `8765`)
