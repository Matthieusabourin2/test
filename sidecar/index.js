#!/usr/bin/env node
// Claude Dashboard sidecar
//
// Surfaces Claude Code, Claude Cowork, and (best-effort) Claude Chat sessions
// from local disk state so the dashboard can show one unified, live view.
//
// Layout:
//   - scanCode()     reads ~/.claude/projects/**/*.jsonl
//   - scanCowork()   reads ~/Library/Application Support/Claude/
//                          local-agent-mode-sessions/<account>/<session>/*.json
//   - scanDesktopState() reads Claude Desktop's shared_proto_db (LevelDB) for
//                          per-session lastViewedAt timestamps. The DB is
//                          held under an exclusive lock while Claude Desktop
//                          is running, so we copy it to /tmp before opening.
//   - scanChat()     same idea for IndexedDB (Chromium claude.ai cache).
//                    Keys are LevelDB-readable but values are encoded with
//                    Blink's structured-clone format; we only pull what we
//                    can recognize textually for now.
//
// All scanners feed the same in-memory sessions Map. The HTTP server exposes
// snapshots over /api/sessions and pushes diffs over /api/events (SSE).

import { createServer } from 'node:http';
import { readFile, readdir, stat, mkdir, cp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let ClassicLevel = null;
try {
  ({ ClassicLevel } = await import('classic-level'));
} catch {
  console.warn('[sidecar] classic-level not installed — Chat and Desktop state will be skipped.');
  console.warn('[sidecar]   run `npm install` inside the sidecar/ directory to enable them.');
}

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT  = path.resolve(__dirname, '..');
const HOME       = homedir();
const PROJECTS_DIR     = path.join(HOME, '.claude', 'projects');
const APP_SUPPORT_DIR  = path.join(HOME, 'Library', 'Application Support', 'Claude');
const COWORK_DIR       = path.join(APP_SUPPORT_DIR, 'local-agent-mode-sessions');
const SHARED_DB_DIR    = path.join(APP_SUPPORT_DIR, 'shared_proto_db');
const INDEXEDDB_DIR    = path.join(APP_SUPPORT_DIR, 'IndexedDB', 'https_claude.ai_0.indexeddb.leveldb');
const SNAPSHOT_TMP     = path.join(tmpdir(), 'claude-dashboard-leveldb');

const PORT = parseInt(process.env.PORT || '8765', 10);

const VERY_RECENT_MS = 60 * 1000;
const IDLE_MS        = 24 * 60 * 60 * 1000;
const HIDDEN_MS      = 7 * 24 * 60 * 60 * 1000;
const POLL_INTERVAL_MS = 3000;
const LEVELDB_POLL_MS  = 15000;
const TAIL_BYTES = 32 * 1024;
const HEAD_BYTES = 8 * 1024;

const sessions = new Map();       // key -> session record
const sseClients = new Set();
let lastSnapshot = '';
let viewedAt = new Map();         // sessionId/conversationId -> ms (from Desktop state, best-effort)

// ---------- helpers ----------

async function safeStat(p) { try { return await stat(p); } catch { return null; } }
async function safeReaddir(p) {
  try { return await readdir(p, { withFileTypes: true }); } catch { return []; }
}
async function readHead(file) {
  const buf = await readFile(file);
  return buf.subarray(0, Math.min(HEAD_BYTES, buf.length)).toString('utf-8');
}
async function readTail(file) {
  const buf = await readFile(file);
  const start = Math.max(0, buf.length - TAIL_BYTES);
  return { text: buf.subarray(start).toString('utf-8'), startedAtZero: start === 0 };
}
function parseLines(text, dropFirst) {
  const lines = text.split('\n').filter(Boolean);
  if (dropFirst && lines.length) lines.shift();
  const out = [];
  for (const l of lines) { try { out.push(JSON.parse(l)); } catch {} }
  return out;
}

function deriveStatus({ lastEventTime, mtimeMs }) {
  const ref = Math.max(lastEventTime || 0, mtimeMs || 0);
  const age = Date.now() - ref;
  if (age > IDLE_MS) return 'idle';
  if (age < VERY_RECENT_MS) return 'working';
  return 'awaiting';
}

// ---------- Claude Code scanner ----------

async function scanCodeFile(filePath) {
  const st = await safeStat(filePath);
  if (!st || !st.isFile()) return null;

  let aiTitle = null, cwd = null, gitBranch = null, sessionId = null;
  try {
    const head = await readHead(filePath);
    for (const ev of parseLines(head, false)) {
      if (ev.type === 'ai-title' && ev.aiTitle) aiTitle = ev.aiTitle;
      if (!cwd && ev.cwd) cwd = ev.cwd;
      if (!gitBranch && ev.gitBranch) gitBranch = ev.gitBranch;
      if (!sessionId && ev.sessionId) sessionId = ev.sessionId;
    }
  } catch {}

  let lastEvent = null;
  try {
    const tail = await readTail(filePath);
    const evs = parseLines(tail.text, !tail.startedAtZero);
    lastEvent = evs[evs.length - 1] || null;
    for (const ev of evs.slice().reverse()) {
      if (!cwd && ev.cwd) cwd = ev.cwd;
      if (!gitBranch && ev.gitBranch) gitBranch = ev.gitBranch;
      if (cwd && gitBranch) break;
    }
  } catch {}

  if (!sessionId) sessionId = path.basename(filePath, '.jsonl');
  const lastEventTime = lastEvent?.timestamp ? Date.parse(lastEvent.timestamp) : st.mtimeMs;
  const eventTime = Math.max(lastEventTime || 0, st.mtimeMs);

  // Worktree heuristic: parent directory contains "claude-worktrees"
  const isWorktree = /claude-worktrees/i.test(filePath);

  return {
    key: `code:${sessionId}`,
    type: 'code',
    sessionId,
    title: aiTitle,
    project: cwd ? path.basename(cwd) : path.basename(path.dirname(filePath)),
    cwd,
    gitBranch,
    isWorktree,
    filePath,
    lastEventTime: eventTime,
    mtime: st.mtimeMs,
    status: deriveStatus({ lastEventTime: eventTime, mtimeMs: st.mtimeMs }),
  };
}

async function listRecentJsonl(dir, out = []) {
  for (const e of await safeReaddir(dir)) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'memory' || e.name === 'subagents' || e.name === 'tool-results') continue;
      await listRecentJsonl(p, out);
    } else if (e.isFile() && e.name.endsWith('.jsonl')) {
      const st = await safeStat(p);
      if (!st || Date.now() - st.mtimeMs > HIDDEN_MS) continue;
      out.push(p);
    }
  }
  return out;
}

async function scanCode() {
  const files = await listRecentJsonl(PROJECTS_DIR);
  const found = new Map();
  for (const f of files) {
    const data = await scanCodeFile(f);
    if (data) found.set(data.key, data);
  }
  return found;
}

// ---------- Cowork scanner ----------

async function scanCowork() {
  const out = new Map();
  const accountDirs = await safeReaddir(COWORK_DIR);
  for (const acct of accountDirs) {
    if (!acct.isDirectory()) continue;
    const acctPath = path.join(COWORK_DIR, acct.name);
    const sessionDirs = await safeReaddir(acctPath);
    for (const sess of sessionDirs) {
      if (!sess.isDirectory()) continue;
      const sessPath = path.join(acctPath, sess.name);
      // Each session dir contains one or more local_<task>.json files
      const files = await safeReaddir(sessPath);
      let latestMtime = 0, latestEvent = 0, title = null;
      let taskCount = 0;
      for (const f of files) {
        if (!f.isFile() || !f.name.startsWith('local_') || !f.name.endsWith('.json')) continue;
        taskCount++;
        const fp = path.join(sessPath, f.name);
        const st = await safeStat(fp);
        if (!st) continue;
        if (st.mtimeMs > latestMtime) latestMtime = st.mtimeMs;
        // Best-effort field extraction — we don't know the exact schema yet.
        try {
          const txt = await readFile(fp, 'utf-8');
          const obj = JSON.parse(txt);
          for (const key of ['title', 'name', 'displayName', 'taskTitle', 'description', 'summary']) {
            if (!title && typeof obj?.[key] === 'string' && obj[key].length < 200) {
              title = obj[key]; break;
            }
          }
          for (const key of ['updatedAt', 'updated_at', 'modifiedAt', 'lastUpdate', 'timestamp']) {
            const v = obj?.[key];
            if (typeof v === 'string') {
              const t = Date.parse(v);
              if (!Number.isNaN(t) && t > latestEvent) latestEvent = t;
            } else if (typeof v === 'number') {
              const t = v > 1e12 ? v : v * 1000;
              if (t > latestEvent) latestEvent = t;
            }
          }
        } catch {}
      }
      if (taskCount === 0 || Date.now() - latestMtime > HIDDEN_MS) continue;
      const eventTime = Math.max(latestEvent, latestMtime);
      out.set(`cowork:${sess.name}`, {
        key: `cowork:${sess.name}`,
        type: 'cowork',
        sessionId: sess.name,
        title: title || `Cowork ${sess.name.slice(0, 8)}…`,
        project: `${taskCount} task${taskCount > 1 ? 's' : ''}`,
        lastEventTime: eventTime,
        mtime: latestMtime,
        status: deriveStatus({ lastEventTime: eventTime, mtimeMs: latestMtime }),
      });
    }
  }
  return out;
}

// ---------- LevelDB readers (Desktop state, Chat) ----------

async function snapshotLevelDb(srcDir, label) {
  const dest = path.join(SNAPSHOT_TMP, label);
  try { await rm(dest, { recursive: true, force: true }); } catch {}
  await mkdir(dest, { recursive: true });
  try { await cp(srcDir, dest, { recursive: true, errorOnExist: false, force: true }); }
  catch (e) { return null; }
  return dest;
}

async function openLevel(srcDir, label) {
  if (!ClassicLevel) return null;
  const snap = await snapshotLevelDb(srcDir, label);
  if (!snap) return null;
  try {
    const db = new ClassicLevel(snap, { valueEncoding: 'view' });
    await db.open();
    return db;
  } catch (e) {
    console.warn(`[sidecar] couldn't open LevelDB at ${srcDir}:`, e.message);
    return null;
  }
}

// shared_proto_db keys look like protobuf-encoded blobs. We scan all keys and
// look for UUID-shaped strings within them — those are likely sessionIds — and
// keep the most recent millisecond-scale timestamp we can find paired with each.
// This is best-effort. It does not require knowing the proto schema.
async function scanDesktopState() {
  const db = await openLevel(SHARED_DB_DIR, 'shared_proto');
  if (!db) return new Map();
  const next = new Map();
  const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
  try {
    for await (const [key, value] of db.iterator()) {
      const keyStr = Buffer.isBuffer(key) ? key.toString('utf-8') : String(key);
      const valStr = Buffer.isBuffer(value) ? value.toString('binary') : String(value);
      const blob = keyStr + '\x00' + valStr;
      const uuids = blob.match(uuidRe);
      if (!uuids) continue;
      // Extract little-endian 8-byte timestamps that look like ms since epoch
      // (between 2023 and 2030)
      let bestTs = 0;
      const buf = Buffer.from(valStr, 'binary');
      for (let i = 0; i + 8 <= buf.length; i++) {
        const v = Number(buf.readBigUInt64LE(i));
        if (v > 1_700_000_000_000 && v < 1_900_000_000_000) {
          if (v > bestTs) bestTs = v;
        }
      }
      if (bestTs === 0) continue;
      for (const u of new Set(uuids)) {
        const prev = next.get(u) || 0;
        if (bestTs > prev) next.set(u, bestTs);
      }
    }
  } catch (e) {
    console.warn('[sidecar] desktop state iteration failed:', e.message);
  } finally {
    try { await db.close(); } catch {}
  }
  return next;
}

// Chat scanner: iterate IndexedDB keys, surface anything that looks like a
// conversation entry. The values are Blink-serialized so we can't fully parse,
// but conversation titles are stored as UTF-16 strings inside — we recover them
// with a simple decoder pass.
async function scanChat() {
  const db = await openLevel(INDEXEDDB_DIR, 'idb');
  if (!db) return new Map();
  const out = new Map();
  try {
    for await (const [key, value] of db.iterator()) {
      const keyStr = Buffer.isBuffer(key) ? key.toString('utf-8', 0) : String(key);
      // IndexedDB keys typically embed the object-store id; we look for the
      // conversation pattern heuristically.
      if (!/conversation/i.test(keyStr) && !/chat/i.test(keyStr)) continue;
      const buf = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'binary');

      // Find a UUID in the key or value
      const uuidMatch = (keyStr + '\x00' + buf.toString('binary')).match(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
      );
      if (!uuidMatch) continue;
      const conversationId = uuidMatch[0];

      // Pull printable ASCII / UTF-8 runs from the value, hope one of them
      // is the title. Take the first plausible one (length 5..120).
      let title = null;
      const ascii = buf.toString('utf-8');
      const runs = ascii.match(/[ -~][ -~ -￿]{4,120}/g) || [];
      for (const r of runs) {
        if (!/^[A-Za-zÀ-ſ]/.test(r)) continue;
        title = r.trim(); break;
      }

      // Pull a 64-bit LE ms timestamp if present (likely updated_at)
      let bestTs = 0;
      for (let i = 0; i + 8 <= buf.length; i++) {
        const v = Number(buf.readBigUInt64LE(i));
        if (v > 1_700_000_000_000 && v < 1_900_000_000_000) {
          if (v > bestTs) bestTs = v;
        }
      }
      const eventTime = bestTs || Date.now();
      if (Date.now() - eventTime > HIDDEN_MS) continue;

      // De-dup: keep the one with the most recent timestamp per conversationId
      const prev = out.get(`chat:${conversationId}`);
      if (prev && prev.lastEventTime >= eventTime) continue;
      out.set(`chat:${conversationId}`, {
        key: `chat:${conversationId}`,
        type: 'chat',
        sessionId: conversationId,
        title: title || `Conversation ${conversationId.slice(0, 8)}…`,
        project: null,
        lastEventTime: eventTime,
        mtime: eventTime,
        status: deriveStatus({ lastEventTime: eventTime, mtimeMs: eventTime }),
      });
    }
  } catch (e) {
    console.warn('[sidecar] chat iteration failed:', e.message);
  } finally {
    try { await db.close(); } catch {}
  }
  return out;
}

// ---------- aggregation ----------

async function fullScan() {
  const [code, cowork] = await Promise.all([scanCode(), scanCowork()]);
  const next = new Map([...code, ...cowork]);

  // Apply viewedAt from desktop state if we have any
  for (const s of next.values()) {
    const v = viewedAt.get(s.sessionId);
    if (v) s.viewedAt = v;
  }

  sessions.clear();
  for (const [k, v] of next) sessions.set(k, v);

  const snap = JSON.stringify(snapshot());
  if (snap !== lastSnapshot) {
    lastSnapshot = snap;
    broadcast({ type: 'snapshot', sessions: snapshot() });
  }
}

async function refreshLevelDbState() {
  if (!ClassicLevel) return;
  const [vMap, chatMap] = await Promise.all([scanDesktopState(), scanChat()]);
  viewedAt = vMap;

  // Merge chat sessions into the live map
  for (const s of chatMap.values()) sessions.set(s.key, s);

  const snap = JSON.stringify(snapshot());
  if (snap !== lastSnapshot) {
    lastSnapshot = snap;
    broadcast({ type: 'snapshot', sessions: snapshot() });
  }
}

function snapshot() {
  const order = { working: 0, awaiting: 1, idle: 2 };
  return Array.from(sessions.values()).sort((a, b) => {
    const oa = order[a.status] ?? 99, ob = order[b.status] ?? 99;
    if (oa !== ob) return oa - ob;
    return b.lastEventTime - a.lastEventTime;
  });
}

function broadcast(msg) {
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  for (const res of sseClients) { try { res.write(data); } catch {} }
}

// ---------- HTTP server ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};
async function serveStatic(res, filePath) {
  try {
    const data = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  } catch {
    res.writeHead(404).end('not found');
  }
}

const server = createServer(async (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/sessions') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
    res.end(JSON.stringify({ sessions: snapshot() }));
    return;
  }
  if (url.pathname === '/api/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
    });
    res.write(`data: ${JSON.stringify({ type: 'snapshot', sessions: snapshot() })}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    await serveStatic(res, path.join(REPO_ROOT, 'index.html'));
    return;
  }
  res.writeHead(404).end('not found');
});

// ---------- main ----------

(async () => {
  console.log('[sidecar] starting...');
  if (!(await safeStat(PROJECTS_DIR))) {
    console.error(`[sidecar] ${PROJECTS_DIR} not found — have you run Claude Code at least once?`);
    process.exit(1);
  }
  await fullScan();
  if (ClassicLevel) await refreshLevelDbState();
  const counts = { code: 0, cowork: 0, chat: 0 };
  for (const s of sessions.values()) counts[s.type] = (counts[s.type] || 0) + 1;
  console.log(`[sidecar] ready → http://localhost:${PORT}/`);
  console.log(`[sidecar]   code: ${counts.code} sessions, cowork: ${counts.cowork}, chat: ${counts.chat}`);

  setInterval(fullScan, POLL_INTERVAL_MS);
  if (ClassicLevel) setInterval(refreshLevelDbState, LEVELDB_POLL_MS);
  server.listen(PORT, '127.0.0.1');
})();
