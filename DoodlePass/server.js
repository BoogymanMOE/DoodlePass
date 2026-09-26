// Doodle Chain — realtime game server.
// Static file host for the mini app + WebSocket game layer + recap API
// (the bot fetches /api/recaps/:id to post round recaps into the chat).
//
// Game modes:
//   classic — one drawer, everyone guesses (first correct ends the round)
//   chain   — draw → guess → re-draw steps across the roster, replayed as a slideshow
//   async   — a challenge that survives sessions: draw now, others guess whenever
//             they next open the chat (persisted to ./data as JSON).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { pickWord } from './words.js';

const PORT = Number(process.env.PORT || 8080);
const ROUNDS = Number(process.env.ROUNDS || 3);
const ROUND_SECONDS = Number(process.env.ROUND_SECONDS || 75);
const CHAIN_STEP_SECONDS = Number(process.env.CHAIN_STEP_SECONDS || 45);
const ASYNC_TTL_HOURS = Number(process.env.ASYNC_TTL_HOURS || 24);
const ASYNC_TTL_MS = ASYNC_TTL_HOURS * 3600 * 1000;
// Chain step scoring
const CHAIN_DRAW_POINTS = 60;
const CHAIN_DRAW_TIMEOUT_POINTS = 30;
const CHAIN_GUESS_POINTS = 40;
// Keep disconnected players around this long so brief mobile network blips
// don't kick someone out of a running round.
const GRACE_MS = Number(process.env.DISCONNECT_GRACE_MS || 20000);

const BOARD_W = 800;
const BOARD_H = 600;
const PUBLIC_DIR = path.resolve('public');
const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const TG_API = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : null;
let botUsername = null;

const TOOLS = new Set(['pen', 'marker', 'spray', 'eraser', 'line', 'rect', 'circle', 'stamp']);
const STAMPS = new Set(['star', 'heart', 'smiley']);
const HEX_COLOR = /^#[0-9a-fA-F]{3,8}$/;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/** chatId -> room */
const rooms = new Map();
/** recapId -> recap payload for the bot (bounded) */
const recaps = new Map();
const RECAP_LIMIT = 100;

// ---------------------------------------------------------------- helpers

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const normalizeWord = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const send = (sock, msg) => { try { sock.send(JSON.stringify(msg)); } catch { /* closed */ } };

function push(room, msg, exceptSock) {
  for (const p of room.players.values()) {
    if (p.sock && p.sock.readyState === 1 && p.sock !== exceptSock) send(p.sock, msg);
  }
}

function roomOf(chatId) {
  let r = rooms.get(chatId);
  if (!r) {
    r = {
      chatId,
      players: new Map(),      // id -> { id,name,username,photo,score,drawn,sock,kickTimer }
      hostId: null,
      state: 'lobby',          // lobby | drawing | chain | chainReplay | recap | ended
      mode: 'classic',         // classic | chain   (host's pick for the next game)
      // classic round fields
      round: 0,
      drawerId: null,
      lastDrawerId: null,
      word: null,
      usedWords: [],
      endsAt: 0,
      timer: null,
      strokes: [],
      guessed: new Set(),
      recapId: null,
      wrongGuesses: [],        // funniest wrong guesses for the best-of card
      // chain fields
      chain: null,             // { steps, index, phase, endsAt, timer }
      // async challenge
      async: null,
    };
    rooms.set(chatId, r);
  }
  return r;
}

function playerList(room) {
  return [...room.players.values()].map((p) => ({
    id: p.id, name: p.name, username: p.username, photo: p.photo, score: p.score,
  }));
}

function stateMsg(room, p) {
  return {
    t: 'state',
    state: room.state,
    mode: room.mode,
    players: playerList(room),
    hostId: room.hostId,
    me: p.id,
    round: room.round,
    rounds: ROUNDS,
    seconds: ROUND_SECONDS,
    drawerId: room.drawerId,
    word: p.id === room.drawerId ? room.word : null,
    endsAt: room.endsAt,
    now: Date.now(),
    strokes: room.strokes,
    chain: chainView(room, p),
    async: asyncView(room, p),
  };
}

function chainView(room, p) {
  const c = room.chain;
  if (!c) return null;
  const active = c.phase === 'active' ? c.steps[c.index] : null;
  const view = {
    phase: c.phase,                       // active | replay
    index: c.index,
    total: c.steps.length,
    endsAt: c.endsAt,
    now: Date.now(),
    seconds: CHAIN_STEP_SECONDS,
    kind: active ? active.kind : null,
    activeId: active ? active.playerId : null,
    activeName: active ? active.playerName : null,
    activeIsMe: active ? active.playerId === p.id : false,
    word: active && active.kind === 'draw' && active.playerId === p.id ? active.word : null,
    strokes: active ? active.strokes : null,
  };
  if (c.phase === 'replay') {
    view.steps = c.steps.map((s) => ({
      kind: s.kind, playerName: s.playerName, word: s.word, guess: s.guess,
      points: s.points, strokes: s.strokes,
    }));
  }
  return view;
}

function asyncView(room, p) {
  const a = room.async;
  if (!a) return null;
  if (a.phase === 'open' && a.endsAt <= Date.now()) { clearAsync(room); return null; }
  const isDrawer = a.drawerId === p.id;
  const solved = a.solvedBy.find((s) => s.id === p.id);
  return {
    phase: a.phase,                        // drawing | open
    drawerId: a.drawerId,
    drawerName: a.drawerName,
    drawerPhoto: a.drawerPhoto,
    createdAt: a.createdAt,
    endsAt: a.endsAt,
    now: Date.now(),
    ttl: ASYNC_TTL_MS,
    word: (isDrawer || solved) ? a.word : null,
    strokes: (a.phase === 'open' || isDrawer) ? a.strokes : null,
    guesses: a.guesses.slice(-30),
    solvedBy: a.solvedBy,
    myPoints: solved ? solved.points : null,
    iSolved: !!solved,
    iAmDrawer: isDrawer,
  };
}

function broadcastState(room) {
  for (const p of room.players.values()) if (p.sock) send(p.sock, stateMsg(room, p));
}

function storeRecap(recap) {
  recaps.set(recap.id, recap);
  while (recaps.size > RECAP_LIMIT) {
    const oldest = recaps.keys().next().value;
    recaps.delete(oldest);
  }
  return recap;
}

function feed(room, name, text, extra = {}) {
  push(room, { t: 'feed', name, text, ...extra });
}

// ---------------------------------------------------------------- strokes

function sanitizeStrokeHeader(m) {
  return {
    tool: TOOLS.has(m.tool) ? m.tool : 'pen',
    color: HEX_COLOR.test(String(m.color || '')) ? String(m.color) : '#24313d',
    size: clamp(Number(m.size) || 6, 1, 60),
    stamp: STAMPS.has(m.stamp) ? m.stamp : 'star',
  };
}

function cleanPoints(pts) {
  if (!Array.isArray(pts)) return [];
  return pts
    .slice(0, 400)
    .filter((pt) => Array.isArray(pt) && Number.isFinite(pt[0]) && Number.isFinite(pt[1]))
    .map((pt) => [
      clamp(Math.round(pt[0] * 10) / 10, -BOARD_W, BOARD_W * 2),
      clamp(Math.round(pt[1] * 10) / 10, -BOARD_H, BOARD_H * 2),
    ]);
}

/** Apply a draw message to a stroke list; returns the relay payload or null. */
function applyStroke(arr, m) {
  const pts = cleanPoints(m.pts);
  if (!pts.length) return null;
  const head = sanitizeStrokeHeader(m);
  if (m.first) {
    arr.push({ ...head, points: pts, ended: false });
    if (arr.length > 2000) arr.shift();
    return { t: 'draw', first: true, ...head, pts };
  }
  const s = arr[arr.length - 1];
  if (!s) return null;   // stray segment with no active stroke — drop it
  s.points.push(...pts);
  if (s.points.length > 8000) s.points.length = 8000;
  return { t: 'draw', first: false, pts };
}

/** Resolve which stroke list a draw/undo/clear message targets (or null). */
function strokesTarget(room, p, m) {
  if (m.target === 'async') {
    const a = room.async;
    if (!a || a.phase !== 'drawing' || p.id !== a.drawerId) return null;
    return a.strokes;
  }
  if (room.state === 'chain') {
    const c = room.chain;
    if (!c || c.phase !== 'active') return null;
    const step = c.steps[c.index];
    if (!step || step.kind !== 'draw' || step.playerId !== p.id) return null;
    return step.strokes;
  }
  if (room.state !== 'drawing' || p.id !== room.drawerId) return null;
  return room.strokes;
}

// ---------------------------------------------------------------- classic

function startRound(room) {
  room.round += 1;
  const players = [...room.players.values()];
  if (!players.length) { room.state = 'lobby'; return; }

  // Drawer = player who has drawn the fewest rounds (random tie-break),
  // avoiding the previous drawer while there are alternatives.
  const minDrawn = Math.min(...players.map((x) => x.drawn));
  let candidates = players.filter((x) => x.drawn === minDrawn);
  if (players.length > 1 && room.lastDrawerId) {
    const filtered = candidates.filter((x) => x.id !== room.lastDrawerId);
    if (filtered.length) candidates = filtered;
  }
  const drawer = candidates[Math.floor(Math.random() * candidates.length)];
  drawer.drawn += 1;
  room.lastDrawerId = drawer.id;
  room.drawerId = drawer.id;
  room.word = pickWord(room.usedWords);
  room.usedWords.push(room.word);
  room.strokes = [];
  room.guessed = new Set();
  room.state = 'drawing';
  room.endsAt = Date.now() + ROUND_SECONDS * 1000;
  clearTimeout(room.timer);
  room.timer = setTimeout(() => endRound(room, 'timeout', null), ROUND_SECONDS * 1000);
  broadcastState(room);
}

function endRound(room, reason, winner) {
  if (room.state !== 'drawing') return;
  clearTimeout(room.timer);
  room.timer = null;

  const elapsedMs = clamp(ROUND_SECONDS * 1000 - (room.endsAt - Date.now()), 0, ROUND_SECONDS * 1000);
  let points = 0;
  let drawerBonus = 0;
  if (winner) {
    const timeLeftSec = Math.max(0, (room.endsAt - Date.now()) / 1000);
    points = Math.max(10, Math.round(timeLeftSec)) * 10;   // speed = points
    winner.score += points;
    const drawer = room.players.get(room.drawerId);
    drawerBonus = Math.round(points * 0.25);               // smaller drawer bonus
    if (drawer) drawer.score += drawerBonus;
  }

  room.state = 'recap';
  const drawerP = room.players.get(room.drawerId);
  const reveal = {
    round: room.round,
    rounds: ROUNDS,
    word: room.word,
    reason,                                    // guessed | timeout | drawer_left
    winner: winner ? { id: winner.id, name: winner.name, points, ms: elapsedMs } : null,
    drawer: drawerP ? { id: drawerP.id, name: drawerP.name, bonus: drawerBonus } : null,
    players: playerList(room),
  };
  const recapId = crypto.randomUUID();
  room.recapId = recapId;
  storeRecap({ id: recapId, chatId: room.chatId, type: 'round', ...reveal, thumb: null, card: null, createdAt: Date.now() });

  push(room, { t: 'roundEnd', recapId, ...reveal });
  broadcastState(room);
}

function endGame(room) {
  clearTimeout(room.timer);
  room.timer = null;
  room.state = 'ended';
  room.drawerId = null;
  room.word = null;
  room.endsAt = 0;
  const board = playerList(room).sort((a, b) => b.score - a.score);
  const recapId = crypto.randomUUID();
  room.recapId = recapId;
  storeRecap({
    id: recapId, chatId: room.chatId, type: 'final', board, rounds: ROUNDS,
    wrongGuesses: room.wrongGuesses.slice(0, 8), thumb: null, card: null, createdAt: Date.now(),
  });
  push(room, { t: 'gameOver', recapId, board, wrongGuesses: room.wrongGuesses.slice(0, 8) });
  broadcastState(room);
}

function resetScores(room) {
  for (const p of room.players.values()) { p.score = 0; p.drawn = 0; }
  room.round = 0;
  room.usedWords = [];
  room.lastDrawerId = null;
  room.drawerId = null;
  room.word = null;
}

// ---------------------------------------------------------------- chain

function startChain(room) {
  const players = [...room.players.values()];
  if (players.length < 2) return;
  if (room.chain) clearTimeout(room.chain.timer);
  resetScores(room);
  room.wrongGuesses = [];

  const n = players.length;
  let total = Math.min(8, Math.max(4, n * 2));
  if (total % 2) total += 1;
  const steps = [];
  for (let i = 0; i < total; i++) {
    const player = players[i % n];
    steps.push({
      kind: i % 2 === 0 ? 'draw' : 'guess',
      playerId: player.id,
      playerName: player.name,
      word: null, guess: null, strokes: [], points: 0, endedAt: null,
    });
  }
  steps[0].word = pickWord([]);

  room.chain = { steps, index: 0, phase: 'active', endsAt: 0, timer: null };
  room.state = 'chain';
  armChainStep(room);
}

function armChainStep(room) {
  const c = room.chain;
  const step = c.steps[c.index];
  c.endsAt = Date.now() + CHAIN_STEP_SECONDS * 1000;
  clearTimeout(c.timer);
  c.timer = setTimeout(() => onChainTimeout(room), CHAIN_STEP_SECONDS * 1000);
  if (step.kind === 'draw') feed(room, 'Chain', `Step ${c.index + 1}: ${step.playerName} draws "${step.word}"`, { step: c.index });
  else feed(room, 'Chain', `Step ${c.index + 1}: ${step.playerName} guesses what it is`, { step: c.index });
  broadcastState(room);
}

function advanceChain(room) {
  const c = room.chain;
  clearTimeout(c.timer);
  c.timer = null;
  c.index += 1;
  if (c.index >= c.steps.length) { beginChainReplay(room); return; }
  armChainStep(room);
}

function onChainTimeout(room) {
  const c = room.chain;
  if (!c || c.phase !== 'active') return;
  const step = c.steps[c.index];
  if (step.kind === 'draw') {
    step.points = CHAIN_DRAW_TIMEOUT_POINTS;
    step.endedAt = Date.now();
    const pl = room.players.get(step.playerId);
    if (pl) pl.score += step.points;
    feed(room, 'Time', `Time's up — ${step.playerName}'s drawing stands`, { step: c.index });
    advanceChain(room);
  } else {
    feed(room, 'Chain', `${step.playerName} ran out of time — the chain broke!`, { step: c.index });
    c.steps = c.steps.slice(0, c.index);      // drop the unfinished link
    beginChainReplay(room);
  }
}

function beginChainReplay(room) {
  const c = room.chain;
  clearTimeout(c.timer);
  c.timer = null;
  c.phase = 'replay';
  c.endsAt = 0;
  room.state = 'chainReplay';

  const recapId = crypto.randomUUID();
  room.recapId = recapId;
  const links = c.steps.map((s) => (s.kind === 'draw'
    ? { type: 'draw', by: s.playerName, word: s.word }
    : { type: 'guess', by: s.playerName, text: s.guess }));
  storeRecap({
    id: recapId, chatId: room.chatId, type: 'chain',
    links, steps: c.steps.map((s) => ({ kind: s.kind, playerName: s.playerName, word: s.word, guess: s.guess, points: s.points })),
    board: playerList(room).sort((a, b) => b.score - a.score),
    thumb: null, card: null, createdAt: Date.now(),
  });
  push(room, { t: 'chainReplay', recapId });
  broadcastState(room);
}

function finishChainGame(room) {
  const board = playerList(room).sort((a, b) => b.score - a.score);
  room.state = 'ended';
  const recap = recaps.get(room.recapId);
  if (recap) recap.board = board;
  push(room, { t: 'gameOver', recapId: room.recapId, board, chain: true });
  broadcastState(room);
}

// ---------------------------------------------------------------- async challenge

function asyncFile(chatId) {
  return path.join(DATA_DIR, `async-${String(chatId).replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
}

function persistAsync(room) {
  try {
    if (!room.async) { fs.rmSync(asyncFile(room.chatId), { force: true }); return; }
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(asyncFile(room.chatId), JSON.stringify({ chatId: room.chatId, async: room.async }));
  } catch (err) {
    console.warn('async persist failed:', err.message);
  }
}

function loadAsyncChallenges() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    for (const file of fs.readdirSync(DATA_DIR)) {
      if (!file.startsWith('async-') || !file.endsWith('.json')) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
        if (!data || !data.async || !data.chatId) continue;
        if (data.async.phase === 'open' && data.async.endsAt <= Date.now()) {
          fs.rmSync(path.join(DATA_DIR, file), { force: true });
          continue;
        }
        const room = roomOf(String(data.chatId));
        room.async = data.async;
      } catch { /* skip corrupt file */ }
    }
  } catch (err) {
    console.warn('async load failed:', err.message);
  }
}

function clearAsync(room) {
  room.async = null;
  try { fs.rmSync(asyncFile(room.chatId), { force: true }); } catch { /* ignore */ }
}

// ---------------------------------------------------------------- Telegram (stickers)

async function initBotIdentity() {
  if (!TG_API) return;
  try {
    const res = await fetch(`${TG_API}/getMe`);
    const json = await res.json();
    if (json.ok) botUsername = json.result.username;
  } catch (err) {
    console.warn('getMe failed:', err.message);
  }
}

async function tgMultipart(method, fields, fileBuf) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  if (fileBuf) fd.append('file', new Blob([fileBuf], { type: 'image/png' }), 'sticker.png');
  const res = await fetch(`${TG_API}/${method}`, { method: 'POST', body: fd });
  return res.json();
}

async function createSticker(userId, pngBuf) {
  const raw = String(userId).replace(/\D/g, '');
  if (!raw) return { ok: false, error: 'bad user id' };
  if (!TG_API || !botUsername) return { ok: false, error: 'sticker export needs BOT_TOKEN on the game server', code: 501 };
  const setName = `dc${raw}_by_${botUsername}`;
  const inputSticker = JSON.stringify([{ sticker: 'attach://file', format: 'static', emoji_list: ['✏️'] }]);

  const created = await tgMultipart('createNewStickerSet', {
    user_id: raw,
    name: setName,
    title: 'Doodle Chain',
    stickers: inputSticker,
    sticker_type: 'regular',
  }, pngBuf);
  if (created.ok) return { ok: true, name: setName, url: `https://t.me/addstickers/${setName}` };

  // Set may already exist (or already contain this sticker) — try adding.
  const added = await tgMultipart('addStickerToSet', {
    user_id: raw,
    name: setName,
    sticker: JSON.stringify({ sticker: 'attach://file', format: 'static', emoji_list: ['✏️'] }),
  }, pngBuf);
  if (added.ok) return { ok: true, name: setName, url: `https://t.me/addstickers/${setName}`, existed: true };
  return { ok: false, error: added.description || created.description || 'sticker upload failed' };
}

// ---------------------------------------------------------------- messages

function handleJoin(room, sock, m) {
  const u = m.user || {};
  const id = String(u.id || '').slice(0, 32);
  if (!id) { send(sock, { t: 'error', msg: 'no user id' }); sock.close(); return; }
  sock.chatId = room.chatId;
  sock.userId = id;

  const existing = room.players.get(id);
  if (existing && existing.kickTimer) { clearTimeout(existing.kickTimer); existing.kickTimer = null; }
  const player = existing || {
    id,
    name: String(u.name || 'Player').slice(0, 40),
    username: u.username ? String(u.username).slice(0, 32) : null,
    photo: u.photo ? String(u.photo).slice(0, 512) : null,
    score: 0,
    drawn: 0,
    sock: null,
    kickTimer: null,
  };
  player.name = String(u.name || player.name).slice(0, 40);
  player.photo = u.photo ? String(u.photo).slice(0, 512) : null;
  player.sock = sock;
  room.players.set(id, player);

  if (!room.hostId || !room.players.has(room.hostId)) {
    room.hostId = [...room.players.keys()][0];
  }
  send(sock, stateMsg(room, player));
  // Let everyone else know (their state now has the new roster).
  for (const p of room.players.values()) {
    if (p.sock && p.sock !== sock) send(p.sock, stateMsg(room, p));
  }
}

function handleMessage(sock, m) {
  const room = sock.chatId ? rooms.get(sock.chatId) : null;
  if (m.t === 'join') {
    const chatId = String(m.chatId || '').slice(0, 64);
    if (!chatId) return;
    return handleJoin(roomOf(chatId), sock, m);
  }
  if (!room) return;
  const p = room.players.get(sock.userId);
  if (!p) return;

  switch (m.t) {
    case 'mode': {
      if (p.id !== room.hostId || room.state !== 'lobby') break;
      const mode = m.mode === 'chain' ? 'chain' : 'classic';
      if (mode !== room.mode) {
        room.mode = mode;
        broadcastState(room);
      }
      break;
    }
    case 'start': {
      if (p.id !== room.hostId || room.state !== 'lobby') break;
      if (room.async && room.async.phase === 'drawing') {
        send(sock, { t: 'error', msg: 'Finish the async challenge first (publish or discard it)' });
        break;
      }
      if (room.mode === 'chain') {
        if (room.players.size < 2) { send(sock, { t: 'error', msg: 'Chain mode needs at least 2 players' }); break; }
        startChain(room);
      } else {
        resetScores(room);
        room.wrongGuesses = [];
        startRound(room);
      }
      break;
    }
    case 'next': {
      if (p.id !== room.hostId) break;
      if (room.state === 'recap') {
        if (room.round >= ROUNDS) endGame(room);
        else startRound(room);
      } else if (room.state === 'chainReplay') {
        finishChainGame(room);
      }
      break;
    }
    case 'playAgain': {
      if (p.id !== room.hostId) break;
      if (room.chain) clearTimeout(room.chain.timer);
      resetScores(room);
      room.chain = null;
      room.state = 'lobby';
      room.wrongGuesses = [];
      broadcastState(room);
      break;
    }

    // ---- drawing ----
    case 'draw': {
      const arr = strokesTarget(room, p, m);
      if (!arr) break;
      const payload = applyStroke(arr, m);
      if (payload) push(room, payload, sock);
      break;
    }
    case 'drawEnd': {
      const arr = strokesTarget(room, p, m);
      if (!arr || !arr.length) break;
      arr[arr.length - 1].ended = true;
      push(room, { t: 'drawEnd' }, sock);
      if (m.target === 'async') persistAsync(room);
      break;
    }
    case 'undo': {
      const arr = strokesTarget(room, p, m);
      if (!arr) break;
      arr.pop();
      push(room, { t: 'undo' }, sock);
      if (m.target === 'async') persistAsync(room);
      break;
    }
    case 'clear': {
      const arr = strokesTarget(room, p, m);
      if (!arr) break;
      arr.length = 0;
      push(room, { t: 'clear' }, sock);
      if (m.target === 'async') persistAsync(room);
      break;
    }

    // ---- classic guessing ----
    case 'guess': {
      if (room.state !== 'drawing' || p.id === room.drawerId || room.guessed.has(p.id)) break;
      const text = String(m.text || '').trim().slice(0, 60);
      if (!text) break;
      const correct = normalizeWord(text) === normalizeWord(room.word);
      if (!correct && room.wrongGuesses.length < 40) room.wrongGuesses.push({ name: p.name, text });
      push(room, { t: 'guess', from: p.id, name: p.name, text, correct });
      if (correct) {
        room.guessed.add(p.id);
        endRound(room, 'guessed', p);   // first correct guess ends the round
      }
      break;
    }

    // ---- chain ----
    case 'chainDone': {
      const c = room.chain;
      if (!c || c.phase !== 'active' || room.state !== 'chain') break;
      const step = c.steps[c.index];
      if (step.kind !== 'draw' || step.playerId !== p.id) break;
      step.points = CHAIN_DRAW_POINTS;
      step.endedAt = Date.now();
      p.score += step.points;
      feed(room, 'Done', `${p.name} finished drawing`, { step: c.index });
      advanceChain(room);
      break;
    }
    case 'chainGuess': {
      const c = room.chain;
      if (!c || c.phase !== 'active' || room.state !== 'chain') break;
      const step = c.steps[c.index];
      if (step.kind !== 'guess' || step.playerId !== p.id) break;
      const text = String(m.text || '').trim().slice(0, 40);
      if (!text) break;
      step.guess = text;
      step.points = CHAIN_GUESS_POINTS;
      step.endedAt = Date.now();
      p.score += step.points;
      const next = c.steps[c.index + 1];
      if (next && next.kind === 'draw') next.word = text;
      feed(room, 'Guess', `${p.name} guessed: "${text}"`, { step: c.index, kind: 'chainGuess', from: p.id });
      advanceChain(room);
      break;
    }

    // ---- async challenge ----
    case 'asyncStart': {
      if (room.state !== 'lobby') { send(sock, { t: 'error', msg: 'Finish the current game first' }); break; }
      if (room.async) { send(sock, { t: 'error', msg: 'There is already an open challenge' }); break; }
      room.async = {
        phase: 'drawing',
        drawerId: p.id,
        drawerName: p.name,
        drawerPhoto: p.photo,
        word: pickWord([]),
        strokes: [],
        guesses: [],
        solvedBy: [],
        createdAt: Date.now(),
        endsAt: Date.now() + ASYNC_TTL_MS,
      };
      persistAsync(room);
      broadcastState(room);
      break;
    }
    case 'asyncPublish': {
      const a = room.async;
      if (!a || a.phase !== 'drawing' || p.id !== a.drawerId) break;
      a.phase = 'open';
      a.drawerName = p.name;
      a.endsAt = Date.now() + ASYNC_TTL_MS;
      persistAsync(room);
      feed(room, 'Async', `${p.name} published an async challenge — guesses open!`);
      broadcastState(room);
      break;
    }
    case 'asyncGuess': {
      const a = room.async;
      if (!a || a.phase !== 'open') break;
      if (a.solvedBy.some((s) => s.id === p.id)) break;
      const text = String(m.text || '').trim().slice(0, 60);
      if (!text) break;
      const correct = normalizeWord(text) === normalizeWord(a.word);
      if (correct) {
        const frac = Math.max(0, (a.endsAt - Date.now()) / ASYNC_TTL_MS);
        const points = Math.round(50 + 150 * frac);
        a.solvedBy.push({ id: p.id, name: p.name, points, at: Date.now() });
        p.score += points;
        push(room, { t: 'asyncGuess', from: p.id, name: p.name, text, correct: true, points });
        feed(room, 'Solved', `${p.name} cracked the challenge! +${points}`);
        persistAsync(room);
        broadcastState(room);
      } else {
        if (a.guesses.length < 60) a.guesses.push({ name: p.name, text, at: Date.now() });
        push(room, { t: 'asyncGuess', from: p.id, name: p.name, text, correct: false });
        persistAsync(room);
        broadcastState(room);   // everyone watching sees the wrong guess live
      }
      break;
    }
    case 'asyncClose': {
      const a = room.async;
      if (!a) break;
      if (p.id !== room.hostId && p.id !== a.drawerId) break;
      const recapId = crypto.randomUUID();
      room.recapId = recapId;
      storeRecap({
        id: recapId, chatId: room.chatId, type: 'async',
        word: a.word,
        drawer: a.drawerName,
        solvers: a.solvedBy.map((s) => ({ name: s.name, points: s.points })),
        wrong: a.guesses.slice(-8),
        thumb: null, card: null, createdAt: Date.now(),
      });
      push(room, {
        t: 'asyncEnd', recapId,
        word: a.word, drawer: a.drawerName,
        solvers: a.solvedBy, wrong: a.guesses.slice(-8),
        players: playerList(room),
      });
      clearAsync(room);
      broadcastState(room);
      break;
    }
    case 'asyncDiscard': {
      const a = room.async;
      if (!a) break;
      const isOwner = p.id === a.drawerId && a.phase === 'drawing';
      if (!isOwner && p.id !== room.hostId) break;
      push(room, { t: 'asyncEnd', discarded: true });
      clearAsync(room);
      broadcastState(room);
      break;
    }

    // ---- artifacts ----
    case 'thumb': {
      const recap = room.recapId ? recaps.get(room.recapId) : null;
      if (recap && typeof m.data === 'string' && m.data.startsWith('data:image') && m.data.length < 400000) {
        recap.thumb = m.data;
      }
      break;
    }
    case 'card': {
      const recap = room.recapId ? recaps.get(room.recapId) : null;
      if (recap && typeof m.data === 'string' && m.data.startsWith('data:image') && m.data.length < 400000) {
        recap.card = m.data;
      }
      break;
    }
    case 'ping': send(sock, { t: 'pong', now: Date.now() }); break;
    default: break;
  }
}

function handleDisconnect(sock) {
  const room = sock.chatId ? rooms.get(sock.chatId) : null;
  if (!room) return;
  const p = room.players.get(sock.userId);
  if (!p || p.sock !== sock) return;

  // Mark as disconnected but give them a grace period to reconnect before
  // removing them (and possibly ending their round).
  p.sock = null;
  p.kickTimer = setTimeout(() => {
    if (p.sock) return;                       // rejoined in time
    room.players.delete(p.id);
    if (room.hostId === p.id) room.hostId = [...room.players.keys()][0] || null;
    if (room.drawerId === p.id && room.state === 'drawing') {
      endRound(room, 'drawer_left', null);
    }
    if (room.chain && room.chain.phase === 'active') {
      const step = room.chain.steps[room.chain.index];
      if (step && step.playerId === p.id) {
        feed(room, 'Chain', `${step.playerName} left — the chain broke!`);
        room.chain.steps = room.chain.steps.slice(0, room.chain.index);
        if (room.chain.steps.length) beginChainReplay(room);
        else { clearTimeout(room.chain.timer); room.chain = null; room.state = 'lobby'; broadcastState(room); }
      }
    }
    if (room.players.size === 0) {
      clearTimeout(room.timer);
      if (room.chain) clearTimeout(room.chain.timer);
      if (!room.async) rooms.delete(room.chatId);   // keep the room if an async challenge lives here
      return;
    }
    broadcastState(room);
  }, GRACE_MS);

  if (room.players.size === 0 && !room.async) {
    // nobody else here and no async challenge — room lifetime is handled by the kick timer
    return;
  }
  broadcastState(room);
}

// ---------------------------------------------------------------- HTTP

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req, limit = 900000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/health') return json(res, 200, { ok: true, rooms: rooms.size, bot: botUsername });

    const recapMatch = url.pathname.match(/^\/api\/recaps\/([A-Za-z0-9-]+)$/);
    if (recapMatch) {
      const recap = recaps.get(recapMatch[1]);
      if (!recap) return json(res, 404, { error: 'not found' });
      return json(res, 200, recap);
    }

    if (url.pathname === '/api/sticker' && req.method === 'POST') {
      const body = await readBody(req);
      let payload;
      try { payload = JSON.parse(body); } catch { return json(res, 400, { error: 'bad json' }); }
      if (typeof payload.data !== 'string' || !payload.data.startsWith('data:image/png;base64,')) {
        return json(res, 400, { error: 'expected a PNG data-url' });
      }
      const b64 = payload.data.slice(payload.data.indexOf(',') + 1);
      const buf = Buffer.from(b64, 'base64');
      if (!buf.length) return json(res, 400, { error: 'empty image' });
      if (buf.length > 512 * 1024) return json(res, 400, { error: `sticker too large (${buf.length} bytes, max 512KB)` });
      const out = await createSticker(payload.userId, buf);
      return json(res, out.ok ? 200 : (out.code || 400), out);
    }

    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep) && file !== PUBLIC_DIR) return json(res, 403, { error: 'forbidden' });
    const data = await fs.promises.readFile(file);
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  } catch (err) {
    if (err && err.code === 'ENOENT') return json(res, 404, { error: 'not found' });
    json(res, 500, { error: 'server error' });
  }
});

// ---------------------------------------------------------------- WebSocket

const wss = new WebSocketServer({ server });
wss.on('connection', (sock) => {
  sock.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m && typeof m === 'object') handleMessage(sock, m);
  });
  sock.on('close', () => handleDisconnect(sock));
  sock.on('error', () => { /* close will follow */ });
});

loadAsyncChallenges();
initBotIdentity();
server.listen(PORT, () => {
  console.log(`Doodle Chain server on http://localhost:${PORT} ` +
    `(classic ${ROUND_SECONDS}s ×${ROUNDS}, chain ${CHAIN_STEP_SECONDS}s/step, async ${ASYNC_TTL_HOURS}h, bot=${botUsername || 'none'})`);
});
