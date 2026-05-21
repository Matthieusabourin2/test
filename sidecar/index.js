#!/usr/bin/env node
// Claude Dashboard sidecar
//
// Surfaces Claude Code, Claude Cowork, and Claude Chat sessions in one unified
// view and lets the dashboard open any of them in Claude Desktop on the right
// conversation.
//
// Sources of truth:
//   Code   - ~/.claude/projects/*/<id>.jsonl     (title + project + cwd)
//          - ~/.claude/dashboard-events.jsonl    (live status from hook events)
//   Cowork - ~/Library/Application Support/Claude/local-agent-mode-sessions/
//            <account>/<workspace>/local_*.json   (title + lastActivityAt)
//   Chat   - lecture de la sidebar Claude Desktop via macOS Accessibility
//            (script JXA dans applescript/read-claude-sidebar.js)
//
// Open-session: AppleScript that activates Claude Desktop and AXPress the row
// whose title matches (applescript/open-session.applescript).

import { createServer } from 'node:http';
import { readFile, readdir, stat, open as openFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { watch, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const HOME = homedir();

const PROJECTS_DIR    = path.join(HOME, '.claude', 'projects');
const APP_SUPPORT_DIR = path.join(HOME, 'Library', 'Application Support', 'Claude');
const COWORK_DIR      = path.join(APP_SUPPORT_DIR, 'local-agent-mode-sessions');
const HOOK_LOG        = path.join(HOME, '.claude', 'dashboard-events.jsonl');

const OPEN_SCRIPT     = path.join(__dirname, 'applescript', 'open-session.applescript');
const READ_AX_SCRIPT  = path.join(__dirname, 'applescript', 'read-claude-sidebar.js');

const PORT = parseInt(process.env.PORT || '8765', 10);

const POLL_MS           = 3000;
const AX_POLL_MS        = 12000;
const AX_TIMEOUT_MS     = 25000;
const CODE_RECENT_MS    = 7 * 24 * 60 * 60 * 1000;
const COWORK_RECENT_MS  = 30 * 24 * 60 * 60 * 1000;
const COWORK_CAP        = 100;
const WORKING_TIMEOUT_MS = 5 * 60 * 1000;
const HEAD_BYTES = 8 * 1024;
const TAIL_BYTES = 32 * 1024;

const sessions  = new Map();   // key -> session record
const sseClients = new Set();
const hookStatus = new Map();  // sessionId -> { event, ts, toolName }
let hookLogOffset = 0;
let lastSnapshotJson = '';
let axCache = { items: [], error: null, ts: 0, parsed: [] };

// ============================================================================
// helpers
// ============================================================================

async function safeStat(p) { try { return await stat(p); } catch { return null; } }
async function safeReaddir(p) { try { return await readdir(p, { withFileTypes: true }); } catch { return []; } }
async function safeReadFile(p, enc = 'utf-8') { try { return await readFile(p, enc); } catch { return null; } }

async function readHead(filePath) {
  const fh = await openFile(filePath, 'r');
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, bytesRead).toString('utf-8');
  } finally { await fh.close(); }
}

async function readTail(filePath, totalSize) {
  const fh = await openFile(filePath, 'r');
  try {
    const start = Math.max(0, totalSize - TAIL_BYTES);
    const len = totalSize - start;
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, start);
    return { text: buf.toString('utf-8'), startedAtZero: start === 0 };
  } finally { await fh.close(); }
}

function parseJsonLines(text, dropFirst) {
  const lines = text.split('\n').filter(Boolean);
  if (dropFirst && lines.length) lines.shift();
  const out = [];
  for (const l of lines) { try { out.push(JSON.parse(l)); } catch {} }
  return out;
}

// ============================================================================
// Code scanner
// ============================================================================

async function listCodeJsonl(dir, out = []) {
  for (const e of await safeReaddir(dir)) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'memory' || e.name === 'subagents' || e.name === 'tool-results') continue;
      await listCodeJsonl(p, out);
    } else if (e.isFile() && e.name.endsWith('.jsonl')) {
      const st = await safeStat(p);
      if (!st || Date.now() - st.mtimeMs > CODE_RECENT_MS) continue;
      out.push({ path: p, mtimeMs: st.mtimeMs, size: st.size });
    }
  }
  return out;
}

function extractUserText(ev) {
  const c = ev?.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    for (const chunk of c) {
      if (chunk && chunk.type === 'text' && typeof chunk.text === 'string') return chunk.text;
    }
  }
  return null;
}

async function scanHeadByLines(filePath, maxLines = 40) {
  // Stream the file line-by-line until we have enough info or hit maxLines.
  // Lines can be huge (base64 image content) so byte-based slicing won't work.
  const stream = createReadStream(filePath, { encoding: 'utf-8', highWaterMark: 64 * 1024 });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  const result = { aiTitle: null, userText: null, cwd: null, gitBranch: null, sessionId: null };
  let count = 0;
  try {
    for await (const line of rl) {
      count++;
      if (count > maxLines) break;
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === 'ai-title' && ev.aiTitle) result.aiTitle = ev.aiTitle;
      if (!result.userText && ev.type === 'user') {
        const t = extractUserText(ev);
        if (t && t.trim()) result.userText = t.trim();
      }
      if (!result.cwd && ev.cwd) result.cwd = ev.cwd;
      if (!result.gitBranch && ev.gitBranch) result.gitBranch = ev.gitBranch;
      if (!result.sessionId && ev.sessionId) result.sessionId = ev.sessionId;
      if (result.aiTitle && result.userText && result.cwd && result.sessionId) break;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return result;
}

async function scanCodeFile({ path: filePath, mtimeMs, size }) {
  let aiTitle = null, userMsg = null, cwd = null, gitBranch = null, sessionId = null;
  try {
    const head = await scanHeadByLines(filePath);
    aiTitle = head.aiTitle;
    userMsg = head.userText;
    cwd = head.cwd;
    gitBranch = head.gitBranch;
    sessionId = head.sessionId;
  } catch {}

  let lastEvent = null;
  try {
    const tail = await readTail(filePath, size);
    const evs = parseJsonLines(tail.text, !tail.startedAtZero);
    lastEvent = evs[evs.length - 1] || null;
    for (const ev of evs.slice().reverse()) {
      if (!cwd && ev.cwd) cwd = ev.cwd;
      if (!gitBranch && ev.gitBranch) gitBranch = ev.gitBranch;
      if (cwd && gitBranch) break;
    }
  } catch {}

  if (!sessionId) sessionId = path.basename(filePath, '.jsonl');
  const lastEventTime = lastEvent?.timestamp ? Date.parse(lastEvent.timestamp) : mtimeMs;
  const eventTime = Math.max(lastEventTime || 0, mtimeMs);

  const isWorktree = /claude-worktrees/i.test(filePath);
  const project = cwd ? path.basename(cwd) : path.basename(path.dirname(filePath));

  let title = aiTitle;
  if (!title && userMsg) title = userMsg.trim().slice(0, 70);
  if (!title) title = `Session ${sessionId.slice(0, 8)}…`;

  return {
    key: `code:${sessionId}`,
    kind: 'code',
    sessionId, title, project, cwd, gitBranch, isWorktree,
    lastEventTime: eventTime,
    mtime: mtimeMs,
    filePath,
  };
}

async function scanCode() {
  const files = await listCodeJsonl(PROJECTS_DIR);
  const map = new Map();
  for (const f of files) {
    const data = await scanCodeFile(f);
    if (data) map.set(data.key, data);
  }
  return map;
}

// ============================================================================
// Cowork scanner
// ============================================================================

async function scanCowork() {
  const candidates = [];
  for (const acct of await safeReaddir(COWORK_DIR)) {
    if (!acct.isDirectory()) continue;
    const acctPath = path.join(COWORK_DIR, acct.name);
    for (const ws of await safeReaddir(acctPath)) {
      if (!ws.isDirectory()) continue;
      const wsPath = path.join(acctPath, ws.name);
      for (const f of await safeReaddir(wsPath)) {
        if (!f.isFile() || !f.name.startsWith('local_') || !f.name.endsWith('.json')) continue;
        const fp = path.join(wsPath, f.name);
        const st = await safeStat(fp);
        if (!st) continue;
        if (Date.now() - st.mtimeMs > COWORK_RECENT_MS) continue;
        candidates.push({ fp, mtime: st.mtimeMs });
      }
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  candidates.length = Math.min(candidates.length, COWORK_CAP);

  const map = new Map();
  for (const { fp, mtime } of candidates) {
    const txt = await safeReadFile(fp);
    if (!txt) continue;
    let obj;
    try { obj = JSON.parse(txt); } catch { continue; }
    if (obj.isArchived) continue;
    const sessionId = obj.sessionId || path.basename(fp, '.json');
    const title = obj.title || obj.initialMessage?.slice(0, 70) || `Cowork ${sessionId.slice(6, 14)}…`;
    const lastActivity = typeof obj.lastActivityAt === 'number' ? obj.lastActivityAt : mtime;
    map.set(`cowork:${sessionId}`, {
      key: `cowork:${sessionId}`,
      kind: 'cowork',
      sessionId,
      title,
      project: obj.processName || null,
      cwd: obj.cwd || null,
      lastEventTime: lastActivity,
      mtime,
    });
  }
  return map;
}

// ============================================================================
// Chat via AX
// ============================================================================

let axInFlight = null;
function runAxRead() {
  if (process.platform !== 'darwin') return Promise.resolve({ error: 'not_darwin', items: [] });
  if (axInFlight) return axInFlight;
  axInFlight = new Promise((resolve) => {
    const proc = spawn('osascript', [READ_AX_SCRIPT], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    let done = false;
    const finish = (r) => { if (done) return; done = true; axInFlight = null; resolve(r); };
    const t = setTimeout(() => { try { proc.kill(); } catch {} finish({ error: 'timeout', items: [] }); }, AX_TIMEOUT_MS);
    proc.stdout.on('data', d => out += d.toString());
    proc.stderr.on('data', d => err += d.toString());
    proc.on('close', () => {
      clearTimeout(t);
      try {
        const parsed = JSON.parse(out.trim());
        if (parsed.error) finish({ error: parsed.error, message: parsed.message, items: [] });
        else finish({ items: parsed.items || [], truncated: !!parsed.truncated });
      } catch (e) {
        finish({ error: 'parse_failed', stderr: err.trim().slice(0, 300), raw: out.slice(0, 300), items: [] });
      }
    });
    proc.on('error', e => { clearTimeout(t); finish({ error: 'spawn_failed', message: e.message, items: [] }); });
  });
  return axInFlight;
}

const EXCLUDE_TITLES_RE = /^(new chat|new code|new cowork|new project|settings|search|account|sign in|sign out|share|export|delete|cancel|ok|close|claude|home|menu|filter|sort|today|yesterday|this week|earlier|previous|loading|untitled|chat|cowork|code|chats|conversations?|history|projects?|files?|preview|view|edit|copy|paste|select|all|done|next|back|forward|refresh|reload|stop|continue|retry|send|attach|upload|download|save|open|recent|starred|starred chats|pinned|recents?)$/i;

function parseAxSessions(items) {
  if (!items?.length) return [];

  const SECTION_RE = {
    chat:   /^(chat|chats|recent chats|conversations?)$/i,
    cowork: /^cowork(s)?$/i,
    code:   /^code(s)?$/i,
    recent: /^(recents?|today|yesterday|this week|earlier|pinned|starred)$/i,
  };
  const sections = [];
  items.forEach((it, idx) => {
    const t = (it.t || '').trim();
    for (const [name, re] of Object.entries(SECTION_RE)) {
      if (re.test(t)) { sections.push({ name, idx }); break; }
    }
  });

  const SESSION_ROLES = new Set(['AXButton', 'AXRow', 'AXStaticText', 'AXCell', 'AXMenuItem', 'AXLink']);
  const out = [];
  const seen = new Set();
  items.forEach((it, idx) => {
    const t = (it.t || '').trim();
    if (!t || t.length < 5 || t.length > 200) return;
    if (EXCLUDE_TITLES_RE.test(t)) return;
    if (!SESSION_ROLES.has(it.r) && it.r !== '?') return;

    let section = 'chat';
    for (let j = sections.length - 1; j >= 0; j--) {
      if (sections[j].idx < idx) {
        section = sections[j].name === 'recent' ? 'chat' : sections[j].name;
        break;
      }
    }
    const dedupKey = `${section}:${t.toLowerCase()}`;
    if (seen.has(dedupKey)) return;
    seen.add(dedupKey);
    out.push({ kind: section, title: t, role: it.r, depth: it.d });
  });
  return out;
}

async function refreshAxCache() {
  if (Date.now() - axCache.ts < AX_POLL_MS) return;
  const res = await runAxRead();
  axCache = { ...res, ts: Date.now(), parsed: parseAxSessions(res.items || []) };
  if (res.error && axCache.lastErr !== res.error) {
    console.warn(`[sidecar] AX read: ${res.error}${res.message ? ' — ' + res.message : ''}`);
    axCache.lastErr = res.error;
  } else if (!res.error && axCache.lastErr) {
    console.log('[sidecar] AX read recovered');
    axCache.lastErr = null;
  }
}

// ============================================================================
// Hook log tailer
// ============================================================================

const TERMINAL_EVENTS = new Set(['Stop', 'SessionEnd', 'PostToolUse']);
const WORKING_EVENTS  = new Set(['PreToolUse', 'UserPromptSubmit', 'SessionStart', 'SubagentStart']);
const ATTENTION_EVENT = 'PermissionRequest';

async function readHookLogIncremental() {
  const st = await safeStat(HOOK_LOG);
  if (!st) return;
  if (st.size < hookLogOffset) hookLogOffset = 0; // file rotated
  if (st.size === hookLogOffset) return;

  const fh = await openFile(HOOK_LOG, 'r');
  try {
    const len = st.size - hookLogOffset;
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, hookLogOffset);
    hookLogOffset = st.size;
    const lines = buf.toString('utf-8').split('\n').filter(Boolean);
    for (const line of lines) {
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (!ev.session_id) continue;
      hookStatus.set(ev.session_id, {
        event: ev.event,
        ts: ev.ts ? Date.parse(ev.ts) : Date.now(),
        toolName: ev.tool_name || null,
      });
    }
  } finally { await fh.close(); }
}

function deriveStatusForCode(sessionId, fallbackMtime) {
  const h = hookStatus.get(sessionId);
  if (h) {
    const age = Date.now() - h.ts;
    if (h.event === ATTENTION_EVENT) return 'needs_action';
    if (h.event === 'SessionEnd') return 'finished';
    if (TERMINAL_EVENTS.has(h.event)) return 'ready';
    if (WORKING_EVENTS.has(h.event)) {
      if (age < WORKING_TIMEOUT_MS) return 'working';
      return 'ready';
    }
  }
  // fallback: mtime
  const age = Date.now() - fallbackMtime;
  if (age < 60 * 1000) return 'working';
  if (age < 24 * 60 * 60 * 1000) return 'ready';
  return 'idle';
}

function deriveStatusForCowork(s) {
  const age = Date.now() - s.lastEventTime;
  if (age < 60 * 1000) return 'working';
  if (age < 24 * 60 * 60 * 1000) return 'ready';
  return 'idle';
}

// ============================================================================
// snapshot aggregation
// ============================================================================

async function buildSnapshot() {
  await readHookLogIncremental();
  const [codeMap, coworkMap] = await Promise.all([scanCode(), scanCowork()]);

  const next = new Map();
  for (const s of codeMap.values()) {
    s.status = deriveStatusForCode(s.sessionId, s.mtime);
    next.set(s.key, s);
  }
  for (const s of coworkMap.values()) {
    s.status = deriveStatusForCowork(s);
    next.set(s.key, s);
  }

  // Chat sessions from AX — only ones not already present in another kind
  const axByTitle = new Map();
  for (const ax of axCache.parsed || []) {
    if (ax.kind !== 'chat' && ax.kind !== 'cowork' && ax.kind !== 'code') continue;
    const k = ax.title.toLowerCase().slice(0, 60);
    if (!axByTitle.has(k)) axByTitle.set(k, ax);
  }
  // If AX surfaces a chat title, add it
  for (const ax of axByTitle.values()) {
    if (ax.kind !== 'chat') continue;
    // dedup against existing sessions by title
    let dupe = false;
    for (const v of next.values()) {
      if (v.title && v.title.toLowerCase().slice(0, 40) === ax.title.toLowerCase().slice(0, 40)) {
        dupe = true; break;
      }
    }
    if (dupe) continue;
    const key = `chat:ax:${ax.title.toLowerCase().slice(0, 50).replace(/[^a-z0-9]+/g, '-')}`;
    next.set(key, {
      key,
      kind: 'chat',
      sessionId: key,
      title: ax.title,
      project: null,
      cwd: null,
      lastEventTime: Date.now(),
      mtime: Date.now(),
      status: 'idle',
      fromAx: true,
    });
  }

  sessions.clear();
  for (const [k, v] of next) sessions.set(k, v);

  maybeBroadcast();
}

function snapshotArray() {
  const order = { working: 0, needs_action: 1, ready: 2, idle: 3, finished: 4 };
  return Array.from(sessions.values()).sort((a, b) => {
    const oa = order[a.status] ?? 99, ob = order[b.status] ?? 99;
    if (oa !== ob) return oa - ob;
    return b.lastEventTime - a.lastEventTime;
  });
}

function currentPayload() {
  return {
    sessions: snapshotArray(),
    ax: {
      ok: !axCache.error,
      error: axCache.error || null,
      message: axCache.message || null,
      itemCount: (axCache.items || []).length,
      sessionCount: (axCache.parsed || []).length,
      lastReadTs: axCache.ts || 0,
    },
  };
}

function maybeBroadcast() {
  const payload = currentPayload();
  const json = JSON.stringify(payload);
  if (json === lastSnapshotJson) return;
  lastSnapshotJson = json;
  const msg = `data: ${JSON.stringify({ type: 'snapshot', ...payload })}\n\n`;
  for (const res of sseClients) { try { res.write(msg); } catch {} }
}

// ============================================================================
// AppleScript open-session
// ============================================================================

function openSessionByTitle(title) {
  return new Promise((resolve) => {
    if (!title) return resolve({ ok: false, error: 'no_title' });
    const proc = spawn('osascript', [OPEN_SCRIPT, title], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    let done = false;
    const finish = (r) => { if (done) return; done = true; resolve(r); };
    const t = setTimeout(() => { try { proc.kill(); } catch {} finish({ ok: false, error: 'timeout' }); }, 25000);
    proc.stdout.on('data', d => out += d.toString());
    proc.stderr.on('data', d => err += d.toString());
    proc.on('close', () => {
      clearTimeout(t);
      const trimmed = out.trim();
      if (trimmed.startsWith('ok')) finish({ ok: true, message: trimmed });
      else finish({ ok: false, error: trimmed || 'unknown', stderr: err.trim().slice(0, 300) });
    });
    proc.on('error', e => { clearTimeout(t); finish({ ok: false, error: e.message }); });
  });
}

// ============================================================================
// HTTP server
// ============================================================================

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

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/sessions' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
    res.end(JSON.stringify(currentPayload()));
    return;
  }

  if (url.pathname === '/api/events' && req.method === 'GET') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
    });
    res.write(`data: ${JSON.stringify({ type: 'snapshot', ...currentPayload() })}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (url.pathname === '/api/open' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const result = await openSessionByTitle(body.title);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  if (url.pathname === '/api/debug/ax' && req.method === 'GET') {
    try {
      axCache.ts = 0;
      await refreshAxCache();
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        error: axCache.error || null,
        message: axCache.message || null,
        rawItemCount: (axCache.items || []).length,
        identifiedSessions: axCache.parsed || [],
        rawSample: (axCache.items || []).slice(0, 200),
      }, null, 2));
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    await serveStatic(res, path.join(REPO_ROOT, 'index.html'));
    return;
  }

  res.writeHead(404).end('not found');
});

// ============================================================================
// main
// ============================================================================

(async () => {
  console.log('[sidecar] starting...');
  if (!(await safeStat(PROJECTS_DIR))) {
    console.error(`[sidecar] ${PROJECTS_DIR} not found — have you run Claude Code at least once?`);
    process.exit(1);
  }
  // initial hook log position: start of file (read everything once)
  const st = await safeStat(HOOK_LOG);
  hookLogOffset = 0;
  if (st) await readHookLogIncremental();

  await refreshAxCache();
  await buildSnapshot();

  // Watch hook log for incremental updates
  if (st) {
    try {
      watch(HOOK_LOG, async () => {
        await readHookLogIncremental();
        await buildSnapshot();
      });
    } catch (e) { console.warn('[sidecar] hook log watch failed:', e.message); }
  }

  setInterval(buildSnapshot, POLL_MS);
  setInterval(async () => { await refreshAxCache(); await buildSnapshot(); }, AX_POLL_MS);

  server.listen(PORT, '127.0.0.1', () => {
    const counts = { code: 0, cowork: 0, chat: 0 };
    for (const s of sessions.values()) counts[s.kind] = (counts[s.kind] || 0) + 1;
    console.log(`[sidecar] ready → http://localhost:${PORT}/`);
    console.log(`[sidecar]   code: ${counts.code}, cowork: ${counts.cowork}, chat: ${counts.chat}`);
    console.log(`[sidecar]   ax: ${axCache.error ? 'failed (' + axCache.error + ')' : 'ok (' + (axCache.items?.length || 0) + ' items)'}`);
    console.log(`[sidecar]   hook events tracked: ${hookStatus.size}`);
  });
})();
