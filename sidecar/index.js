#!/usr/bin/env node
// Claude Dashboard sidecar — local-only, hook-driven.
//
// Architecture (everything on this Mac, no cloud):
//
//   Claude Code (CLI + Desktop)
//        │  emits lifecycle events
//        ▼
//   ~/.claude/dashboard/hook.py  →  appends to  ~/.claude/dashboard-events.jsonl
//        │
//        ▼
//   sidecar tails the log, builds a per-session state machine
//        │
//        ▼
//   /api/sessions  +  /api/events (SSE)  →  dashboard
//
// Click-to-open uses osascript (macOS Accessibility) to focus Claude Desktop
// and click the matching sidebar row — no terminal, no URL scheme.

import { createServer } from 'node:http';
import { readFile, readdir, stat, writeFile, mkdir, copyFile, appendFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { watch } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const HOME = homedir();

const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');
const EVENTS_LOG = path.join(HOME, '.claude', 'dashboard-events.jsonl');
const SETTINGS_FILE = path.join(HOME, '.claude', 'settings.json');
const HOOK_INSTALL_DIR = path.join(HOME, '.claude', 'dashboard');
const HOOK_INSTALL_PATH = path.join(HOOK_INSTALL_DIR, 'hook.py');
const HOOK_SOURCE_PATH = path.resolve(REPO_ROOT, 'hooks', 'dashboard-event.py');
const OPEN_APPLESCRIPT = path.join(__dirname, 'applescript', 'open-session.applescript');

const PORT = parseInt(process.env.PORT || '8765', 10);

// Status timing
const STALE_MS = 24 * 60 * 60 * 1000;        // session disappears after 24h idle
const WORKING_TIMEOUT_MS = 10 * 60 * 1000;   // if no Stop event after 10min, assume hung

// Hook events we wire up
const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'Notification',
  'Stop',
  'SessionEnd',
  'SubagentStart',
  'SubagentStop',
];

// ----- state -----

// sessionId -> { sessionId, title, cwd, project, lastEventTime, status, lastEvent, transcriptPath }
const sessions = new Map();
const sseClients = new Set();
let lastBroadcast = '';
let hooksInstalled = false;

// ----- file utilities -----

async function safeStat(p) {
  try { return await stat(p); } catch { return null; }
}

async function safeReaddir(p) {
  try { return await readdir(p, { withFileTypes: true }); } catch { return []; }
}

// ----- Code project metadata (titles, cwd) from JSONL files -----
//
// The event log gives us state transitions, but titles and project info live
// in ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl. We read just enough
// of the head of each file to grab cwd, gitBranch and aiTitle.

async function indexCodeMetadata() {
  const meta = new Map();
  const dirs = await safeReaddir(PROJECTS_DIR);
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dirPath = path.join(PROJECTS_DIR, d.name);
    const files = await safeReaddir(dirPath);
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      const sessionId = f.name.slice(0, -'.jsonl'.length);
      const filePath = path.join(dirPath, f.name);
      const st = await safeStat(filePath);
      if (!st) continue;
      const info = { sessionId, filePath, mtime: st.mtimeMs };
      try {
        const buf = await readFile(filePath);
        const text = buf.subarray(0, Math.min(buf.length, 8 * 1024)).toString('utf-8');
        for (const line of text.split('\n').filter(Boolean).slice(0, 50)) {
          try {
            const ev = JSON.parse(line);
            if (ev.cwd && !info.cwd) info.cwd = ev.cwd;
            if (ev.gitBranch && !info.gitBranch) info.gitBranch = ev.gitBranch;
            if (ev.type === 'ai-title' && ev.aiTitle) { info.title = ev.aiTitle; break; }
          } catch {}
        }
      } catch {}
      info.project = info.cwd ? path.basename(info.cwd) : d.name;
      meta.set(sessionId, info);
    }
  }
  return meta;
}

// ----- hook event log -----
//
// We tail ~/.claude/dashboard-events.jsonl. Each line is a JSON record:
//   { ts, event, session_id, cwd, transcript_path, matcher, ... }
//
// We track byte position and re-read on file change. New sessions are added
// the first time we see a SessionStart (or any event with their id); state
// is derived by combining the most recent few events per session.

let eventLogPosition = 0;
let eventsBySession = new Map(); // sessionId -> array of recent events (cap 30)

function pushEvent(rec) {
  if (!rec || !rec.session_id) return;
  const arr = eventsBySession.get(rec.session_id) || [];
  arr.push(rec);
  if (arr.length > 30) arr.shift();
  eventsBySession.set(rec.session_id, arr);
}

async function readEventLogIncremental() {
  const st = await safeStat(EVENTS_LOG);
  if (!st) return;
  if (st.size < eventLogPosition) {
    // log was rotated/truncated
    eventLogPosition = 0;
    eventsBySession.clear();
  }
  if (st.size === eventLogPosition) return;

  const buf = await readFile(EVENTS_LOG);
  const slice = buf.subarray(eventLogPosition).toString('utf-8');
  eventLogPosition = buf.length;

  for (const line of slice.split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      pushEvent(rec);
    } catch {}
  }
}

// ----- state derivation -----
//
// Status meaning:
//   working      — Claude is processing (UserPromptSubmit observed, no Stop yet)
//   needs_action — Claude is waiting for the user (PermissionRequest pending, or
//                  a Notification with matcher=permission_prompt/idle_prompt)
//   ready        — Claude finished (Stop observed) and you haven't started a
//                  new turn since; the "unread / brown done" state
//   idle         — Nothing recent, session not finished
//   finished     — SessionEnd received

function deriveSessionStatus(events) {
  if (!events || events.length === 0) return { status: 'idle', lastEventTime: 0 };

  let status = 'idle';
  let lastEventTime = 0;
  let pendingPermission = false;
  let working = false;
  let ended = false;

  // walk in chronological order so transitions update state
  for (const ev of events) {
    const t = Date.parse(ev.ts) || 0;
    if (t > lastEventTime) lastEventTime = t;

    switch (ev.event) {
      case 'SessionStart':
        working = false;
        pendingPermission = false;
        break;
      case 'UserPromptSubmit':
        working = true;
        pendingPermission = false;
        break;
      case 'PreToolUse':
      case 'PostToolUse':
        working = true;
        break;
      case 'PermissionRequest':
        pendingPermission = true;
        break;
      case 'Notification':
        if (ev.matcher === 'permission_prompt' || ev.matcher === 'idle_prompt' || ev.matcher === 'elicitation_dialog') {
          pendingPermission = true;
        }
        break;
      case 'Stop':
        working = false;
        pendingPermission = false;
        break;
      case 'SessionEnd':
        working = false;
        pendingPermission = false;
        ended = true;
        break;
    }
  }

  if (ended) status = 'finished';
  else if (pendingPermission) status = 'needs_action';
  else if (working) {
    // safety net: if a working session is silent > timeout, mark idle
    if (Date.now() - lastEventTime > WORKING_TIMEOUT_MS) status = 'idle';
    else status = 'working';
  } else if (lastEventTime > 0) {
    status = 'ready';
  }

  return { status, lastEventTime };
}

// ----- aggregate snapshot -----

async function buildSnapshot() {
  await readEventLogIncremental();
  const meta = await indexCodeMetadata();

  const next = new Map();
  const seenIds = new Set([...eventsBySession.keys(), ...meta.keys()]);

  for (const sessionId of seenIds) {
    const events = eventsBySession.get(sessionId) || [];
    const info = meta.get(sessionId) || {};
    const derived = deriveSessionStatus(events);
    const lastEventTime = Math.max(derived.lastEventTime || 0, info.mtime || 0);

    // Drop sessions with no recent activity at all
    if (lastEventTime === 0) continue;
    if (Date.now() - lastEventTime > STALE_MS && derived.status !== 'needs_action') continue;

    // If we have file metadata but no event log entries, we can't derive a
    // real status — mark "unknown" so the UI can show this honestly.
    const hasHookData = events.length > 0;
    const status = hasHookData ? derived.status : 'unknown';

    next.set(sessionId, {
      sessionId,
      title: info.title || `Session ${sessionId.slice(0, 8)}…`,
      project: info.project || null,
      cwd: info.cwd || null,
      gitBranch: info.gitBranch || null,
      lastEventTime,
      status,
      hasHookData,
    });
  }

  sessions.clear();
  for (const [k, v] of next) sessions.set(k, v);

  maybeBroadcast();
}

function snapshotArray() {
  const order = { working: 0, needs_action: 1, ready: 2, idle: 3, unknown: 4, finished: 5 };
  return Array.from(sessions.values()).sort((a, b) => {
    const oa = order[a.status] ?? 99;
    const ob = order[b.status] ?? 99;
    if (oa !== ob) return oa - ob;
    return b.lastEventTime - a.lastEventTime;
  });
}

function maybeBroadcast() {
  const sessionsArr = snapshotArray();
  const payload = { sessions: sessionsArr, hooksInstalled };
  const json = JSON.stringify(payload);
  if (json === lastBroadcast) return;
  lastBroadcast = json;
  const data = `data: ${JSON.stringify({ type: 'snapshot', ...payload })}\n\n`;
  for (const res of sseClients) {
    try { res.write(data); } catch {}
  }
}

// ----- hook installation -----
//
// Writes the hook script into ~/.claude/dashboard/hook.py and registers it
// in ~/.claude/settings.json for every relevant event. We back up the
// existing settings.json before modifying.

async function checkHooksInstalled() {
  try {
    const settingsRaw = await readFile(SETTINGS_FILE, 'utf-8').catch(() => '{}');
    const settings = JSON.parse(settingsRaw || '{}');
    const startHooks = settings?.hooks?.SessionStart || [];
    for (const matcher of startHooks) {
      for (const hook of (matcher.hooks || [])) {
        if (typeof hook.command === 'string' && hook.command.includes('dashboard/hook.py')) {
          return true;
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

async function installHooks() {
  // 1. copy hook script
  await mkdir(HOOK_INSTALL_DIR, { recursive: true });
  await copyFile(HOOK_SOURCE_PATH, HOOK_INSTALL_PATH);
  // chmod 755
  await import('node:fs').then(fs => fs.promises.chmod(HOOK_INSTALL_PATH, 0o755));

  // 2. merge into settings.json
  await mkdir(path.dirname(SETTINGS_FILE), { recursive: true });
  let settings = {};
  let backupPath = null;
  try {
    const raw = await readFile(SETTINGS_FILE, 'utf-8');
    settings = JSON.parse(raw || '{}');
    backupPath = `${SETTINGS_FILE}.dashboard-backup.${Date.now()}`;
    await writeFile(backupPath, raw);
  } catch {}

  settings.hooks = settings.hooks || {};
  for (const eventName of HOOK_EVENTS) {
    settings.hooks[eventName] = settings.hooks[eventName] || [];
    // remove any prior dashboard entry to keep this idempotent
    settings.hooks[eventName] = settings.hooks[eventName].filter(matcher => {
      return !(matcher.hooks || []).some(h => typeof h.command === 'string' && h.command.includes('dashboard/hook.py'));
    });
    settings.hooks[eventName].push({
      hooks: [
        {
          type: 'command',
          command: `/usr/bin/python3 ${HOOK_INSTALL_PATH} ${eventName}`,
        },
      ],
    });
  }

  await writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n');
  hooksInstalled = true;
  return { ok: true, hookPath: HOOK_INSTALL_PATH, settingsPath: SETTINGS_FILE, backup: backupPath };
}

// ----- open session in Claude Desktop via Accessibility -----

function openInDesktop(title) {
  return new Promise((resolve) => {
    const proc = spawn('osascript', [OPEN_APPLESCRIPT, title], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    proc.stdout.on('data', d => out += d.toString());
    proc.stderr.on('data', d => err += d.toString());
    proc.on('close', code => {
      resolve({ ok: code === 0 && out.startsWith('ok:'), out: out.trim(), err: err.trim(), exitCode: code });
    });
    proc.on('error', e => resolve({ ok: false, out: '', err: e.message, exitCode: -1 }));
  });
}

// ----- file watching for live updates -----

function watchEventLog() {
  // Tail the log: when it changes, re-read incrementally.
  let timer = null;
  const trigger = () => {
    if (timer) return;
    timer = setTimeout(async () => {
      timer = null;
      try { await buildSnapshot(); } catch {}
    }, 150);
  };
  try {
    watch(path.dirname(EVENTS_LOG), { persistent: true }, (_evt, filename) => {
      if (filename === path.basename(EVENTS_LOG)) trigger();
    });
  } catch {}
  // also a periodic refresh in case fs.watch misses something (or for mtime
  // changes on Code JSONL files)
  setInterval(trigger, 4000);
}

// ----- HTTP server -----

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
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404).end('not found');
  }
}

async function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}')); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/sessions') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
    res.end(JSON.stringify({ sessions: snapshotArray(), hooksInstalled }));
    return;
  }

  if (url.pathname === '/api/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
    });
    res.write(`data: ${JSON.stringify({ type: 'snapshot', sessions: snapshotArray(), hooksInstalled })}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (url.pathname === '/api/install-hooks' && req.method === 'POST') {
    try {
      const result = await installHooks();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  if (url.pathname === '/api/open' && req.method === 'POST') {
    try {
      const body = await readJson(req);
      if (!body.title) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'title required' }));
        return;
      }
      const result = await openInDesktop(body.title);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    await serveStatic(res, path.join(REPO_ROOT, 'index.html'));
    return;
  }

  res.writeHead(404).end('not found');
});

// ----- main -----

(async () => {
  console.log('[sidecar] starting…');
  hooksInstalled = await checkHooksInstalled();

  if (!(await safeStat(PROJECTS_DIR))) {
    console.warn(`[sidecar] note: ${PROJECTS_DIR} not found — fine if you haven't used Claude Code yet.`);
  }

  // Initial scan
  await buildSnapshot();

  watchEventLog();

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[sidecar] ready → http://localhost:${PORT}/`);
    console.log(`[sidecar]   hooks installed: ${hooksInstalled ? 'yes' : 'no — click "Installer les hooks" in the dashboard'}`);
    console.log(`[sidecar]   tracking ${sessions.size} session(s)`);
  });
})();
