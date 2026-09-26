'use strict';

/* ============================================================
   Doodle Chain — mini app client
   Views: lobby | classic | chainActive | chainReplay | reveal | final
          | asyncDraw | asyncOpen
   ============================================================ */

const tg = window.Telegram && window.Telegram.WebApp;
if (tg) {
  try { tg.ready(); tg.expand(); } catch { /* ignore */ }
  try { tg.disableVerticalSwipes && tg.disableVerticalSwipes(); } catch { /* ignore */ }
}

const BOARD_W = 800;
const BOARD_H = 600;

const COLORS = [
  { name: 'Pencil', hex: '#24313d' },
  { name: 'Red',    hex: '#d62828' },
  { name: 'Blue',   hex: '#1d6fd6' },
  { name: 'Green',  hex: '#2a9d3f' },
  { name: 'Honey',  hex: '#e8a200' },
];
const SIZES = [
  { name: 'Fine',   v: 4 },
  { name: 'Medium', v: 9 },
  { name: 'Bold',   v: 18 },
];
const TOOLS = [
  { id: 'pen',    icon: '<svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>', name: 'pen' },
  { id: 'marker', icon: '<svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round"><path d="M4 20l4-1 10-10-3-3L5 16l-1 4z"/><path d="M14 6l3 3"/><rect x="15.5" y="2.5" width="4" height="4" rx="1"/></svg>', name: 'marker' },
  { id: 'spray',  icon: '<svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="13" r="4"/><path d="M9 5v.01M13 3v.01M6 8v.01M17 6v.01M19 10v.01"/></svg>', name: 'spray' },
  { id: 'line',   icon: '<svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round"><path d="M4 20L20 4"/></svg>', name: 'line' },
  { id: 'rect',   icon: '<svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round"><rect x="4" y="6" width="16" height="12" rx="1"/></svg>', name: 'rect' },
  { id: 'circle', icon: '<svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="8"/></svg>', name: 'circle' },
  { id: 'eraser', icon: '<svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round"><path d="M18 13l-7 7H7l-4-4a2 2 0 0 1 0-3l9-9a2 2 0 0 1 3 0l3 3a2 2 0 0 1 0 3Z"/><path d="M7 20h13"/></svg>', name: 'erase' },
  { id: 'stamp',  icon: '<svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round"><path d="M12 2l2.5 5L20 8l-4 4 1 6-5-3-5 3 1-6-4-4 5.5-1z"/></svg>', name: 'stamp' },
];
const SHAPE_TOOLS = new Set(['line', 'rect', 'circle']);
const STAMPS = [
  { id: 'star',   label: '*' },
  { id: 'heart',  label: '<3' },
  { id: 'smiley', label: ':)' },
];

/* ---------------- identity & chat ---------------- */

const params = new URLSearchParams(location.search);
const tgUser = (tg && tg.initDataUnsafe && tg.initDataUnsafe.user) || null;
const me = {
  id: String(tgUser ? tgUser.id : 'g' + Math.floor(Math.random() * 1e6)),
  name: tgUser
    ? [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ')
    : 'Guest' + Math.floor(Math.random() * 90 + 10),
  username: tgUser && tgUser.username ? tgUser.username : null,
  photo: tgUser && tgUser.photo_url ? tgUser.photo_url : null,
};
// Room key: explicit ?chat= > Telegram start_param > private DM room.
const chatId = (params.get('chat') || (tg && tg.initDataUnsafe && tg.initDataUnsafe.start_param) || 'dm:' + me.id).slice(0, 64);

/* ---------------- state ---------------- */

let ws = null;
let st = null;                          // last server snapshot
const live = {
  timeline: [],                        // {type:'guess'|'feed', ...}
  timelineKey: '',
  reveal: null,                        // classic round reveal payload
  asyncReveal: null,                   // async challenge end payload
  final: null,                         // gameOver payload
  card: null,                          // best-of card dataURL
  slide: 0,                            // chain replay slide
};
let strokes = [];                      // strokes currently shown on the canvas
let myColor = COLORS[0].hex;
let mySize = SIZES[1].v;
let currentTool = 'pen';
let currentStamp = 'star';
let drawSeq = [];                      // outgoing draw batch
let drawing = false;
let activeStroke = null;
let timerHandle = null;
let mainAction = null;
let mainText = '';

/* ---------------- dom ---------------- */

const $ = (id) => document.getElementById(id);
const lobbyEl = $('lobby'), gameEl = $('game'), revealEl = $('reveal'), finalEl = $('final');
const lobbyPlayers = $('lobbyPlayers'), lobbyHint = $('lobbyHint');
const modeClassic = $('modeClassic'), modeChain = $('modeChain'), modeDesc = $('modeDesc');
const asyncBanner = $('asyncBanner'), asyncBannerText = $('asyncBannerText'), asyncStartBtn = $('asyncStartBtn');
const roundLabel = $('roundLabel');
const timerWrap = $('timerWrap'), timerText = $('timerText'), timerFill = $('timerFill');
const board = $('board'), ctx = board.getContext('2d');
const wordBadge = $('wordBadge'), turnWho = $('turnWho'), chips = $('chips'), gameInfo = $('gameInfo');
const replayCtl = $('replayCtl'), slideLabel = $('slideLabel');
const toolbar = $('toolbar'), toolsRow = $('toolsRow'), stampRow = $('stampRow');
const swatches = $('swatches'), sizesEl = $('sizes');
const guessesEl = $('guesses'), guessInput = $('guessInput'), inputrow = $('inputrow');
const gameActions = $('gameActions'), asyncCloseBtn = $('asyncCloseBtn'), asyncStartLiveBtn = $('asyncStartLiveBtn');
const stickerOpenBtn = $('stickerOpenBtn'), stickerOpenOut = $('stickerOpenOut');
const revealTitle = $('revealTitle'), revealWord = $('revealWord'), revealResults = $('revealResults');
const shareBtn = $('shareBtn'), stickerBtn = $('stickerBtn'), stickerOut = $('stickerOut'), revealDone = $('revealDone');
const boardList = $('boardList'), bestof = $('bestof'), cardImg = $('cardImg'), cardDownload = $('cardDownload');
const shareFinalBtn = $('shareFinalBtn'), stickerFinalBtn = $('stickerFinalBtn'), stickerFinalOut = $('stickerFinalOut');
const fallbackMain = $('fallbackMain'), toastEl = $('toast');

/* ---------------- websocket ---------------- */

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => send({ t: 'join', chatId, user: me });
  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    handle(m);
  };
  ws.onclose = () => {
    roundLabel.textContent = 'Reconnecting…';
    setTimeout(connect, 1200);
  };
  ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
}

let toastTimer = null;
function toast(msg) {
  if (!toastEl) return;
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2800);
}

function handle(m) {
  switch (m.t) {
    case 'state': onState(m); break;
    case 'guess':
      live.timeline.push({ type: 'guess', from: m.from, name: m.name, text: m.text, correct: m.correct });
      break;
    case 'feed':
      if (currentView().indexOf('chain') === 0) live.timeline.push({ type: 'feed', name: m.name, text: m.text });
      break;
    case 'draw': onRemoteDraw(m); break;
    case 'drawEnd':
      if (strokes.length) strokes[strokes.length - 1].ended = true;
      repaint();
      break;
    case 'undo':
      strokes.pop();
      repaint();
      break;
    case 'clear':
      strokes = [];
      repaint();
      break;
    case 'roundEnd':
      live.reveal = m;
      live.timeline = [];
      sendThumb(strokes);
      break;
    case 'chainReplay':
      live.slide = 0;
      live.chainThumbSent = false;   // thumb sent once the replay state arrives
      break;
    case 'gameOver':
      live.final = m;
      live.reveal = null;
      sendThumb(finalArt());
      if (m.chain) buildChainCard();
      else if (m.wrongGuesses && m.wrongGuesses.length) buildBestOfCard(m.board, m.wrongGuesses);
      break;
    case 'asyncEnd':
      if (m.discarded) {
        toast('Challenge discarded');
      } else {
        live.asyncReveal = m;
        const art = (st && st.async && st.async.strokes) || [];
        sendThumb(art);
      }
      break;
    case 'error':
      toast(m.msg || 'Something went wrong');
      break;
    default: break;
  }
  render();
}

/* ---------------- views ---------------- */

function currentView() {
  if (!st) return 'lobby';
  const s = st.state;
  if (s === 'drawing') return 'classic';
  if (s === 'chain') return 'chainActive';
  if (s === 'chainReplay') return 'chainReplay';
  if (s === 'recap') return 'reveal';
  if (s === 'ended') return 'final';
  // lobby-based views
  if (live.asyncReveal) return 'reveal';
  if (st.async) {
    if (st.async.phase === 'open') return 'asyncOpen';
    if (st.async.phase === 'drawing' && st.async.iAmDrawer) return 'asyncDraw';
  }
  return 'lobby';
}

function timelineKey() {
  if (!st) return '';
  let chainPart = '';
  if (st.chain) chainPart = '|chain-' + (st.chain.phase === 'replay' ? 'replay' : 'active');
  const asyncPart = st.async ? '|async-' + st.async.createdAt : '';
  return [st.state, st.state === 'drawing' ? st.round : '', chainPart, asyncPart].join('|');
}

function onState(m) {
  st = m;
  const key = timelineKey();
  if (key !== live.timelineKey) {
    live.timelineKey = key;
    live.timeline = [];
    live.slide = 0;
  }
  if (st.state !== 'lobby') live.asyncReveal = null;
  else { live.final = null; live.card = null; }
  if (st.state !== 'recap') live.reveal = null;

  // chain recap thumbnail: needs the replay state (carries the steps)
  if (st.state === 'chainReplay' && st.chain && st.chain.steps && st.chain.steps.length && !live.chainThumbSent) {
    live.chainThumbSent = true;
    sendThumb(st.chain.steps[st.chain.steps.length - 1].strokes);
  }

  // pick the canvas content for the active view
  const v = currentView();
  let next = [];
  if ((v === 'asyncDraw' || v === 'asyncOpen') && st.async) next = st.async.strokes || [];
  else if (v === 'chainActive' && st.chain) next = st.chain.strokes || [];
  else if (v === 'chainReplay' && st.chain && st.chain.steps) next = st.chain.steps[live.slide].strokes || [];
  else next = st.strokes || [];
  strokes = next;
  repaint();

  // countdowns
  if (v === 'classic' && st.endsAt && st.now) {
    startTimer(st.endsAt - st.now, st.seconds * 1000);
  } else if (v === 'chainActive' && st.chain && st.chain.endsAt && st.chain.phase === 'active') {
    startTimer(st.chain.endsAt - st.chain.now, st.chain.seconds * 1000);
  } else {
    stopTimer();
  }
  if (v !== 'classic' && v !== 'chainActive' && drawing) { drawing = false; activeStroke = null; }
  render();
}

/* ---------------- render ---------------- */

function render() {
  if (!st) return;
  const v = currentView();
  const state = st.state;

  lobbyEl.classList.toggle('hidden', v !== 'lobby');
  gameEl.classList.toggle('hidden', !['classic', 'chainActive', 'chainReplay', 'asyncDraw', 'asyncOpen'].includes(v));
  revealEl.classList.toggle('hidden', v !== 'reveal');
  finalEl.classList.toggle('hidden', v !== 'final');
  timerWrap.classList.toggle('hidden', v !== 'classic' && v !== 'chainActive');

  renderRoundLabel(v);
  if (v === 'lobby') renderLobby();
  else if (v === 'classic') renderClassic();
  else if (v === 'chainActive') renderChainActive();
  else if (v === 'chainReplay') renderChainReplay();
  else if (v === 'asyncDraw') renderAsyncDraw();
  else if (v === 'asyncOpen') renderAsyncOpen();
  else if (v === 'reveal') renderReveal();
  else if (v === 'final') renderFinal();

  renderMainButton(v);
}

function renderRoundLabel(v) {
  if (v === 'lobby') roundLabel.textContent = 'Lobby';
  else if (v === 'classic') roundLabel.textContent = `Round ${st.round}/${st.rounds}`;
  else if (v === 'chainActive') roundLabel.textContent = `Step ${st.chain.index + 1}/${st.chain.total}`;
  else if (v === 'chainReplay') roundLabel.textContent = `Chain replay`;
  else if (v === 'asyncDraw') roundLabel.textContent = 'Your challenge';
  else if (v === 'asyncOpen') roundLabel.textContent = 'Challenge open';
  else if (v === 'reveal') roundLabel.textContent = st.state === 'recap' ? `Round ${st.round} done` : 'Challenge closed';
  else if (v === 'final') roundLabel.textContent = 'Game over';
}

/* ----- lobby ----- */

function renderLobby() {
  const iAmHost = st.hostId === st.me;

  modeClassic.classList.toggle('on', st.mode !== 'chain');
  modeChain.classList.toggle('on', st.mode === 'chain');
  modeClassic.disabled = !iAmHost;
  modeChain.disabled = !iAmHost;
  modeDesc.textContent = st.mode === 'chain'
    ? `Chain: draw -> guess -> re-draw · ${st.rounds}… steps across the roster · needs 2+ players`
    : `${st.rounds} rounds · draw it, race to guess it`;

  const hasAsync = !!st.async;
  asyncStartBtn.classList.toggle('hidden', hasAsync);
  if (hasAsync && st.async.phase === 'drawing' && !st.async.iAmDrawer) {
    asyncBannerText.textContent = `Async: ${st.async.drawerName} is drawing an async challenge…`;
    asyncBanner.classList.remove('hidden');
  } else {
    asyncBanner.classList.add('hidden');
  }

  lobbyPlayers.innerHTML = '';
  st.players.forEach((p) => {
    const li = document.createElement('li');
    li.appendChild(avatarNode(p));
    const name = document.createElement('span');
    name.className = 'pname';
    name.textContent = p.name + (p.id === me.id ? ' (you)' : '');
    li.appendChild(name);
    if (p.id === st.hostId) {
      const star = document.createElement('span');
      star.className = 'host-star';
      star.textContent = 'host ★';
      li.appendChild(star);
    }
    lobbyPlayers.appendChild(li);
  });

  lobbyHint.textContent = st.players.length < 2
    ? (iAmHost ? 'You are the host — open the app from the group chat so friends can join, then tap Start.'
      : 'Waiting for more players…')
    : (iAmHost ? 'Everyone is in — tap Start when ready!' : 'Waiting for the host to start…');
}

/* ----- classic ----- */

function renderClassic() {
  const drawer = st.players.find((p) => p.id === st.drawerId);
  const isDrawer = st.drawerId === st.me;
  turnWho.textContent = drawer ? `${drawer.name} is drawing…` : '…';
  wordBadge.textContent = isDrawer ? `Draw: ${st.word}` : 'Guess the word!';
  gameInfo.classList.add('hidden');
  replayCtl.classList.add('hidden');
  gameActions.classList.add('hidden');
  toolbar.classList.remove('hidden');
  toolbar.classList.toggle('disabled', !isDrawer);
  board.classList.toggle('locked', !isDrawer);
  inputrow.classList.remove('hidden');
  guessInput.disabled = isDrawer;
  guessInput.maxLength = 60;
  guessInput.placeholder = isDrawer ? 'You are drawing this round' : 'Type your guess…';
  renderChips(st.drawerId);
  renderTimeline();
}

/* ----- chain ----- */

function renderChainActive() {
  const c = st.chain;
  const kindWord = c.kind === 'draw' ? 'drawing' : 'guessing';
  turnWho.textContent = `Step ${c.index + 1}/${c.total} — ${c.activeName} is ${kindWord}…`;
  if (c.activeIsMe && c.kind === 'draw') wordBadge.textContent = `Draw: ${c.word}`;
  else if (c.activeIsMe && c.kind === 'guess') wordBadge.textContent = 'What is it?';
  else wordBadge.textContent = c.kind === 'draw' ? 'Watch the drawing…' : 'Watch them guess…';
  gameInfo.textContent = 'Chain mode — whatever the guesser types becomes the next drawing';
  gameInfo.classList.remove('hidden');
  replayCtl.classList.add('hidden');
  gameActions.classList.add('hidden');
  toolbar.classList.remove('hidden');
  const canDraw = c.activeIsMe && c.kind === 'draw';
  toolbar.classList.toggle('disabled', !canDraw);
  board.classList.toggle('locked', !canDraw);
  inputrow.classList.remove('hidden');
  guessInput.disabled = !(c.activeIsMe && c.kind === 'guess');
  guessInput.maxLength = 40;
  guessInput.placeholder = 'What did they draw? (your answer becomes the next word!)';
  renderChips(c.activeId);
  renderTimeline();
}

function renderChainReplay() {
  const steps = (st.chain && st.chain.steps) || [];
  if (!steps.length) return;
  live.slide = Math.max(0, Math.min(live.slide, steps.length - 1));
  const step = steps[live.slide];
  turnWho.textContent = `Replay: ${step.playerName}'s ${step.kind === 'draw' ? 'drawing' : 'guess'}`;
  wordBadge.textContent = step.kind === 'draw' ? `“${step.word}”` : `guessed “${step.guess}”`;
  gameInfo.textContent = 'How the idea mutated — step through the whole chain';
  gameInfo.classList.remove('hidden');
  replayCtl.classList.remove('hidden');
  slideLabel.textContent = `${live.slide + 1}/${steps.length}`;
  gameActions.classList.add('hidden');
  toolbar.classList.add('hidden');
  inputrow.classList.add('hidden');
  board.classList.remove('locked');
  chips.classList.add('hidden');

  strokes = steps[live.slide].strokes || [];
  repaint();

  // history up to the current slide
  guessesEl.innerHTML = '';
  steps.slice(0, live.slide + 1).forEach((s) => {
    const line = document.createElement('div');
    line.className = 'feedline';
    line.textContent = s.kind === 'draw'
      ? `${s.playerName} drew “${s.word}”`
      : `${s.playerName} guessed “${s.guess}”`;
    guessesEl.appendChild(line);
  });
  guessesEl.scrollTop = guessesEl.scrollHeight;
}

/* ----- async ----- */

function renderAsyncDraw() {
  const a = st.async;
  turnWho.textContent = 'Your async challenge';
  wordBadge.textContent = `Draw: ${a.word}`;
  gameInfo.textContent = 'Nobody is watching live — hit Publish when you are done, friends guess it whenever they open the chat.';
  gameInfo.classList.remove('hidden');
  replayCtl.classList.add('hidden');
  gameActions.classList.add('hidden');
  toolbar.classList.remove('hidden');
  toolbar.classList.remove('disabled');
  board.classList.remove('locked');
  inputrow.classList.remove('hidden');
  guessInput.disabled = true;
  guessInput.placeholder = 'Publish to let friends guess…';
  chips.classList.add('hidden');
  renderTimeline();
}

function renderAsyncOpen() {
  const a = st.async;
  turnWho.textContent = `Challenge from ${a.drawerName}`;
  if (a.iSolved) wordBadge.textContent = `Solved! +${a.myPoints}`;
  else if (a.iAmDrawer) wordBadge.textContent = 'You drew this one';
  else wordBadge.textContent = 'Guess the drawing!';
  const left = Math.max(0, a.endsAt - a.now);
  gameInfo.textContent = `${fmtRemaining(left)} left · ${a.solvedBy.length} solved it · host can close anytime`;
  gameInfo.classList.remove('hidden');
  replayCtl.classList.add('hidden');
  toolbar.classList.add('hidden');
  board.classList.add('locked');
  chips.classList.add('hidden');
  inputrow.classList.remove('hidden');
  guessInput.disabled = a.iSolved || a.iAmDrawer;
  guessInput.maxLength = 60;
  guessInput.placeholder = a.iSolved ? 'You already solved it'
    : a.iAmDrawer ? 'You know the word 😉' : 'Type your guess…';

  // host / drawer actions + sticker
  const iAmHost = st.hostId === st.me;
  gameActions.classList.remove('hidden');
  asyncCloseBtn.classList.toggle('hidden', !(iAmHost || a.iAmDrawer));
  asyncStartLiveBtn.classList.toggle('hidden', !iAmHost);
  stickerOpenBtn.classList.remove('hidden');
  stickerOpenOut.classList.add('hidden');

  // solvers + wrong guesses
  guessesEl.innerHTML = '';
  if (!a.solvedBy.length && !a.guesses.length) {
    const empty = document.createElement('div');
    empty.className = 'guess-empty';
    empty.textContent = a.iAmDrawer ? 'Waiting for your friends to open the chat…' : 'No guesses yet — be the first!';
    guessesEl.appendChild(empty);
  }
  a.solvedBy.forEach((s) => {
    const line = document.createElement('div');
    line.className = 'feedline';
    line.textContent = `Solved: ${s.name} solved it · +${s.points}`;
    guessesEl.appendChild(line);
  });
  a.guesses.forEach((g) => {
    const b = document.createElement('div');
    b.className = 'bubble' + (g.name === me.name ? ' mine' : '');
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = g.name === me.name ? 'you' : g.name;
    const txt = document.createElement('span');
    txt.className = 'txt';
    txt.textContent = g.text;
    b.append(who, txt);
    guessesEl.appendChild(b);
  });
  guessesEl.scrollTop = guessesEl.scrollHeight;
}

function fmtRemaining(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/* ----- reveal ----- */

function renderReveal() {
  const ar = live.asyncReveal;
  revealResults.innerHTML = '';

  if (ar) {
    // async challenge recap
    revealTitle.textContent = 'Challenge closed';
    revealWord.textContent = ar.word;
    revealResults.appendChild(resultRow('', `${ar.drawer} drew it`, '', 'the word'));
    if (ar.solvers && ar.solvers.length) {
      ar.solvers.forEach((s, i) => revealResults.appendChild(resultRow(['1st', '2nd', '3rd'][i] || 'Solved', `${s.name} solved it`, `+${s.points}`, '')));
    } else {
      const note = document.createElement('p');
      note.className = 'result-note';
      note.textContent = 'Nobody solved this one';
      revealResults.appendChild(note);
    }
    if (ar.wrong && ar.wrong.length) {
      const note = document.createElement('p');
      note.className = 'result-note';
      note.textContent = 'Wrong guesses: ' + ar.wrong.map((w) => `“${w.text}” (${w.name})`).join(' · ');
      revealResults.appendChild(note);
    }
    shareBtn.classList.remove('hidden');
    shareBtn.textContent = 'Share challenge result to chat';
    stickerBtn.classList.add('hidden');
    revealDone.classList.remove('hidden');
    return;
  }

  revealDone.classList.add('hidden');
  stickerBtn.classList.remove('hidden');
  shareBtn.textContent = 'Share recap to chat';
  const r = live.reveal;
  if (!r) {
    revealTitle.textContent = 'Round over';
    revealWord.textContent = '—';
    const note = document.createElement('p');
    note.className = 'result-note';
    note.textContent = 'Waiting for the host to start the next round…';
    revealResults.appendChild(note);
    return;
  }
  revealTitle.textContent = r.reason === 'guessed' ? 'Nailed it! 🎉'
    : r.reason === 'drawer_left' ? 'Drawer left the game'
      : "Time's up";
  revealWord.textContent = r.word;
  if (r.winner) {
    revealResults.appendChild(resultRow('Winner', `${r.winner.name} guessed it`, `+${r.winner.points}`, `${(r.winner.ms / 1000).toFixed(1)}s`));
    if (r.drawer) revealResults.appendChild(resultRow('Drawer', `${r.drawer.name} drew it`, `+${r.drawer.bonus}`, 'drawer bonus'));
  } else {
    const note = document.createElement('p');
    note.className = 'result-note';
    note.textContent = r.reason === 'timeout'
      ? 'Nobody guessed it — the word stays a secret... until now.'
      : 'The drawing session was interrupted.';
    revealResults.appendChild(note);
    if (r.drawer) revealResults.appendChild(resultRow('Drawer', `${r.drawer.name} drew it`, '—', r.word));
  }
  const scoreList = document.createElement('p');
  scoreList.className = 'result-note';
  scoreList.textContent = 'Scores: ' + r.players.slice().sort((a, b) => b.score - a.score)
    .map((p) => `${p.name.split(' ')[0]} ${p.score}`).join(' · ');
  revealResults.appendChild(scoreList);
}

/* ----- final ----- */

function renderFinal() {
  const boardData = (live.final && live.final.board) || st.players.slice().sort((a, b) => b.score - a.score);
  boardList.innerHTML = '';
  boardData.forEach((p, i) => {
    const li = document.createElement('li');
    const rank = document.createElement('span');
    rank.className = 'rank';
    rank.textContent = ['1st', '2nd', '3rd'][i] || `${i + 1}.`;
    li.appendChild(rank);
    const nm = document.createElement('span');
    nm.textContent = p.name + (p.id === me.id ? ' (you)' : '');
    li.appendChild(nm);
    const pts = document.createElement('span');
    pts.className = 'pts';
    pts.textContent = `${p.score} pts`;
    li.appendChild(pts);
    boardList.appendChild(li);
  });

  if (live.card) {
    cardImg.src = live.card;
    cardDownload.href = live.card;
    bestof.classList.remove('hidden');
  } else {
    bestof.classList.add('hidden');
  }

  const classicArt = st.mode !== 'chain' && strokes.length > 0;
  stickerFinalBtn.classList.toggle('hidden', !classicArt);
  stickerFinalOut.classList.add('hidden');
}

/* ----- shared bits ----- */

function avatarNode(p) {
  const el = document.createElement('span');
  el.className = 'avatar';
  const initials = (p.name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  if (p.photo) {
    const img = document.createElement('img');
    img.src = p.photo;
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.onerror = () => { el.textContent = initials; };
    el.appendChild(img);
  } else {
    el.textContent = initials;
  }
  return el;
}

function renderChips(activeId) {
  chips.classList.remove('hidden');
  chips.innerHTML = '';
  st.players.forEach((p) => {
    const chip = document.createElement('span');
    chip.className = 'chip' + (p.id === activeId ? ' drawing' : '');
    chip.appendChild(avatarNode(p));
    const nm = document.createElement('span');
    nm.textContent = p.name.split(' ')[0];
    chip.appendChild(nm);
    const sc = document.createElement('b');
    sc.textContent = p.score;
    chip.appendChild(sc);
    chips.appendChild(chip);
  });
}

function renderTimeline() {
  guessesEl.innerHTML = '';
  if (!live.timeline.length) {
    const empty = document.createElement('div');
    empty.className = 'guess-empty';
    empty.textContent = currentView() === 'chainActive'
      ? 'Play-by-play appears here…'
      : (st.drawerId === me.id ? 'Watch the guesses roll in…' : 'No guesses yet — be the first!');
    guessesEl.appendChild(empty);
  } else {
    live.timeline.forEach((g) => {
      if (g.type === 'feed') {
        const line = document.createElement('div');
        line.className = 'feedline';
        line.textContent = g.text;
        guessesEl.appendChild(line);
        return;
      }
      const b = document.createElement('div');
      b.className = 'bubble' + (g.from === me.id ? ' mine' : '') + (g.correct ? ' correct' : '');
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = g.from === me.id ? 'you' : g.name;
      const txt = document.createElement('span');
      txt.className = 'txt';
      txt.textContent = g.text;
      b.append(who, txt);
      guessesEl.appendChild(b);
    });
    guessesEl.scrollTop = guessesEl.scrollHeight;
  }
}

function resultRow(emoji, label, pts, note) {
  const row = document.createElement('div');
  row.className = 'result-row';
  const medal = document.createElement('span');
  medal.className = 'medal';
  medal.textContent = emoji;
  const text = document.createElement('span');
  text.textContent = note ? `${label} · ${note}` : label;
  row.append(medal, text);
  if (pts) {
    const p = document.createElement('span');
    p.className = 'pts';
    p.textContent = pts;
    row.appendChild(p);
  }
  return row;
}

/* ---------------- main button ---------------- */

function renderMainButton(v) {
  if (!st) return;
  const iAmHost = st.hostId === st.me;
  let text = null, action = null;

  if (v === 'lobby') {
    if (iAmHost) {
      text = st.mode === 'chain' ? 'Start chain' : 'Start game';
      action = () => send({ t: 'start' });
    }
  } else if (v === 'classic') {
    if (st.drawerId !== st.me) { text = 'Send guess ⏎'; action = submitGuess; }
  } else if (v === 'reveal') {
    if (live.reveal && iAmHost) {
      text = st.round >= st.rounds ? 'See final scores →' : 'Next round →';
      action = () => send({ t: 'next' });
    }
  } else if (v === 'final') {
    if (iAmHost) { text = 'Play again'; action = () => send({ t: 'playAgain' }); }
  } else if (v === 'asyncDraw') {
    text = 'Publish challenge';
    action = () => send({ t: 'asyncPublish' });
  } else if (v === 'asyncOpen') {
    const a = st.async;
    if (!a.iSolved && !a.iAmDrawer) { text = 'Submit guess ⏎'; action = submitAsyncGuess; }
  } else if (v === 'chainActive') {
    const c = st.chain;
    if (c.activeIsMe) {
      if (c.kind === 'draw') { text = 'Done'; action = () => send({ t: 'chainDone' }); }
      else { text = 'Lock it in'; action = submitChainGuess; }
    }
  } else if (v === 'chainReplay') {
    if (iAmHost) { text = 'See final scores →'; action = () => send({ t: 'next' }); }
  }

  if (tg && tg.MainButton) {
    if (text) tg.MainButton.setParams({ text: text.toUpperCase(), isVisible: true });
    else tg.MainButton.setParams({ isVisible: false });
  }
  if (fallbackMain) {
    fallbackMain.classList.toggle('hidden', !text);
    fallbackMain.textContent = text || '';
    fallbackMain.disabled = !action;
  }
  mainText = text;
  mainAction = action;
}

if (tg && tg.MainButton) tg.MainButton.onClick(() => { if (mainAction) mainAction(); });
if (fallbackMain) fallbackMain.addEventListener('click', () => { if (mainAction) mainAction(); });

/* ---------------- guessing ---------------- */

function submitGuess() {
  if (!st || st.state !== 'drawing' || st.drawerId === st.me) return;
  const v = guessInput.value.trim();
  if (!v) return;
  send({ t: 'guess', text: v });
  guessInput.value = '';
}

function submitChainGuess() {
  if (!st || !st.chain || st.chain.kind !== 'guess' || !st.chain.activeIsMe) return;
  const v = guessInput.value.trim();
  if (!v) return;
  send({ t: 'chainGuess', text: v });
  guessInput.value = '';
}

function submitAsyncGuess() {
  if (!st || !st.async || st.async.phase !== 'open') return;
  const v = guessInput.value.trim();
  if (!v) return;
  send({ t: 'asyncGuess', text: v });
  guessInput.value = '';
}

guessInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const v = currentView();
  if (v === 'classic') submitGuess();
  else if (v === 'chainActive') submitChainGuess();
  else if (v === 'asyncOpen') submitAsyncGuess();
});

/* ---------------- timer ---------------- */

function startTimer(remainingMs, totalMs) {
  stopTimer();
  const deadline = Date.now() + remainingMs;
  const total = totalMs || remainingMs;
  const tickFn = () => {
    const left = Math.max(0, deadline - Date.now());
    renderTimer(left, total);
    if (left <= 0) stopTimer();
  };
  tickFn();
  timerHandle = setInterval(tickFn, 250);
}

function stopTimer() {
  if (timerHandle) { clearInterval(timerHandle); timerHandle = null; }
}

function renderTimer(leftMs, totalMs) {
  const secs = Math.ceil(leftMs / 1000);
  timerText.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  const frac = Math.max(0, Math.min(1, leftMs / totalMs));
  timerFill.style.transform = `scaleX(${frac})`;
  const cls = frac > 0.5 ? 'green' : frac > 0.25 ? 'amber' : 'red';
  timerText.className = 'timer ' + cls + (secs <= 5 ? ' pulse' : '');
  timerFill.className = 'timerfill ' + cls;
}

// keep the async "time left" line fresh
setInterval(() => { if (currentView() === 'asyncOpen') render(); }, 60000);

/* ============================================================
   Canvas — stroke rendering for every tool
   ============================================================ */

function toLogical(e) {
  const r = board.getBoundingClientRect();
  return [
    Math.round(((e.clientX - r.left) * (BOARD_W / r.width)) * 10) / 10,
    Math.round(((e.clientY - r.top) * (BOARD_H / r.height)) * 10) / 10,
  ];
}

function strokePath(x, pts, width) {
  x.lineWidth = width;
  x.lineCap = 'round';
  x.lineJoin = 'round';
  if (pts.length === 1) {
    x.beginPath();
    x.arc(pts[0][0], pts[0][1], width / 2, 0, Math.PI * 2);
    x.fill();
    return;
  }
  x.beginPath();
  x.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) x.lineTo(pts[i][0], pts[i][1]);
  x.stroke();
}

function sprayAt(x, pts, size) {
  const radius = Math.max(7, size * 2.4);
  const dotR = Math.max(0.7, size * 0.18);
  for (let i = 0; i < pts.length; i++) {
    const [px, py] = pts[i];
    // deterministic scatter — reseeded per point so every client replays identically
    let h = (Math.round(px) * 73856093) ^ (Math.round(py) * 19349663) ^ ((i + 1) * 83492791);
    for (let k = 0; k < 10; k++) {
      h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
      const a = ((h >>> 8) % 65536) / 65536 * Math.PI * 2;
      const rad = Math.sqrt(((h >>> 16) % 65536) / 65535) * radius;
      x.beginPath();
      x.arc(px + Math.cos(a) * rad, py + Math.sin(a) * rad, dotR, 0, Math.PI * 2);
      x.fill();
    }
  }
}

function drawStamp(x, kind, cx, cy, r) {
  x.beginPath();
  if (kind === 'heart') {
    x.moveTo(cx, cy + r * 0.75);
    x.bezierCurveTo(cx - r * 1.4, cy - r * 0.1, cx - r * 0.7, cy - r * 1.1, cx, cy - r * 0.35);
    x.bezierCurveTo(cx + r * 0.7, cy - r * 1.1, cx + r * 1.4, cy - r * 0.1, cx, cy + r * 0.75);
    x.fill();
  } else if (kind === 'smiley') {
    x.arc(cx, cy, r, 0, Math.PI * 2);
    x.lineWidth = Math.max(1.5, r * 0.16);
    x.stroke();
    x.beginPath();
    x.arc(cx - r * 0.35, cy - r * 0.2, r * 0.1, 0, Math.PI * 2);
    x.arc(cx + r * 0.35, cy - r * 0.2, r * 0.1, 0, Math.PI * 2);
    x.fill();
    x.beginPath();
    x.arc(cx, cy + r * 0.1, r * 0.5, 0.25 * Math.PI, 0.75 * Math.PI);
    x.lineWidth = Math.max(1.5, r * 0.14);
    x.stroke();
  } else {
    // star
    const spikes = 5;
    for (let i = 0; i < spikes * 2; i++) {
      const rad = i % 2 === 0 ? r : r * 0.45;
      const a = (i * Math.PI) / spikes - Math.PI / 2;
      const px = cx + Math.cos(a) * rad;
      const py = cy + Math.sin(a) * rad;
      if (i === 0) x.moveTo(px, py); else x.lineTo(px, py);
    }
    x.closePath();
    x.fill();
  }
}

/** Render one stroke onto context x (BOARD_W×H coordinate space). */
function renderStroke(s, x) {
  const pts = s.points;
  if (!pts || !pts.length) return;
  x.save();
  x.strokeStyle = s.color;
  x.fillStyle = s.color;
  const size = s.size || 6;
  switch (s.tool) {
    case 'eraser':
      x.globalCompositeOperation = 'destination-out';
      x.strokeStyle = 'rgba(0,0,0,1)';
      x.fillStyle = 'rgba(0,0,0,1)';
      strokePath(x, pts, size * 2.2);
      break;
    case 'marker':
      x.globalAlpha = 0.35;
      strokePath(x, pts, size * 1.8);
      break;
    case 'spray':
      sprayAt(x, pts, size);
      break;
    case 'line':
      if (pts.length >= 2) {
        x.lineWidth = size; x.lineCap = 'round';
        x.beginPath();
        x.moveTo(pts[0][0], pts[0][1]);
        x.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
        x.stroke();
      }
      break;
    case 'rect':
      if (pts.length >= 2) {
        const [x0, y0] = pts[0], [x1, y1] = pts[pts.length - 1];
        x.lineWidth = size; x.lineJoin = 'round';
        x.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      }
      break;
    case 'circle':
      if (pts.length >= 2) {
        const [x0, y0] = pts[0], [x1, y1] = pts[pts.length - 1];
        x.lineWidth = size;
        x.beginPath();
        x.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, 0, 0, Math.PI * 2);
        x.stroke();
      }
      break;
    case 'stamp':
      drawStamp(x, s.stamp || 'star', pts[0][0], pts[0][1], size * 2.6);
      break;
    default:   // pen
      strokePath(x, pts, size);
  }
  x.restore();
}

/** Paint only the tail of a stroke (cheap live update for path tools). */
function paintTail(s, from) {
  const pts = s.points;
  if (pts.length < 2 || from < 1) { renderStroke(s, ctx); return; }
  if (s.tool === 'spray') {
    sprayAt(ctx, pts.slice(from), s.size);
    return;
  }
  if (SHAPE_TOOLS.has(s.tool)) { repaint(); return; }
  ctx.save();
  ctx.strokeStyle = s.tool === 'eraser' ? 'rgba(0,0,0,1)' : s.color;
  ctx.fillStyle = s.tool === 'eraser' ? 'rgba(0,0,0,1)' : s.color;
  if (s.tool === 'marker') ctx.globalAlpha = 0.35;
  ctx.lineWidth = s.tool === 'eraser' ? s.size * 2.2 : s.tool === 'marker' ? s.size * 1.8 : s.size;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (s.tool === 'eraser') ctx.globalCompositeOperation = 'destination-out';
  if (s.tool === 'stamp') { ctx.restore(); return; }
  ctx.beginPath();
  const a = pts[Math.max(0, from - 1)];
  ctx.moveTo(a[0], a[1]);
  for (let i = Math.max(1, from); i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.stroke();
  ctx.restore();
}

function repaint() {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, BOARD_W, BOARD_H);
  strokes.forEach((s) => renderStroke(s, ctx));
}

/** Paint strokes scaled into a w×h target (thumbs, cards, stickers). */
function paintArt(x, arr, w, h, bg) {
  x.save();
  if (bg) { x.fillStyle = bg; x.fillRect(0, 0, w, h); }
  const scale = Math.min(w / BOARD_W, h / BOARD_H);
  x.translate((w - BOARD_W * scale) / 2, (h - BOARD_H * scale) / 2);
  x.scale(scale, scale);
  arr.forEach((s) => renderStroke(s, x));
  x.restore();
}

/* ---------------- drawing input ---------------- */

function canDraw() {
  if (!st) return false;
  const v = currentView();
  if (v === 'classic') return st.drawerId === st.me;
  if (v === 'chainActive') {
    const c = st.chain;
    return !!(c && c.phase === 'active' && c.activeIsMe && c.kind === 'draw');
  }
  if (v === 'asyncDraw') return !!(st.async && st.async.iAmDrawer);
  return false;
}

function drawTarget() {
  return currentView() === 'asyncDraw' ? { target: 'async' } : {};
}

board.addEventListener('pointerdown', (e) => {
  if (!canDraw()) return;
  e.preventDefault();
  try { board.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  drawing = true;
  const p = toLogical(e);
  activeStroke = { tool: currentTool, color: myColor, size: mySize, stamp: currentStamp, points: [p], ended: false };
  strokes.push(activeStroke);
  repaint();
  send({ t: 'draw', first: true, tool: currentTool, color: myColor, size: mySize, stamp: currentStamp, pts: [p], ...drawTarget() });
});

board.addEventListener('pointermove', (e) => {
  if (!drawing || !activeStroke) return;
  if (currentTool === 'stamp') return;         // one stamp per tap
  const p = toLogical(e);
  const last = activeStroke.points[activeStroke.points.length - 1];
  if (Math.abs(p[0] - last[0]) + Math.abs(p[1] - last[1]) < 1.5) return;
  const from = activeStroke.points.length;
  activeStroke.points.push(p);
  if (SHAPE_TOOLS.has(currentTool)) repaint();  // rubber-band preview
  else paintTail(activeStroke, from);
  drawSeq.push(p);
  if (drawSeq.length >= 12) flushDraw();
});

function flushDraw() {
  if (!drawSeq.length) return;
  const pts = drawSeq;
  drawSeq = [];
  send({ t: 'draw', pts, ...drawTarget() });
}

function endStroke() {
  if (!drawing) return;
  drawing = false;
  flushDraw();
  send({ t: 'drawEnd', ...drawTarget() });
  activeStroke = null;
  repaint();   // normalize (marker overlap, shape commit)
}

board.addEventListener('pointerup', endStroke);
board.addEventListener('pointercancel', endStroke);
board.addEventListener('pointerleave', endStroke);

$('undoBtn').addEventListener('click', () => {
  if (!canDraw() || drawing) return;
  strokes.pop();
  repaint();
  send({ t: 'undo', ...drawTarget() });
});

$('clearBtn').addEventListener('click', () => {
  if (!canDraw() || drawing) return;
  strokes = [];
  repaint();
  send({ t: 'clear', ...drawTarget() });
});

/* ---------------- toolbar ---------------- */

TOOLS.forEach((t) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'toolbtn' + (t.id === currentTool ? ' on' : '');
  b.title = t.name;
  b.innerHTML = `${t.icon}<small>${t.name}</small>`;
  b.addEventListener('click', () => {
    currentTool = t.id;
    toolsRow.querySelectorAll('.toolbtn').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    stampRow.classList.toggle('hidden', t.id !== 'stamp');
  });
  toolsRow.appendChild(b);
});

STAMPS.forEach((s) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'stampbtn' + (s.id === currentStamp ? ' on' : '');
  b.textContent = s.label;
  b.title = s.id;
  b.addEventListener('click', () => {
    currentStamp = s.id;
    stampRow.querySelectorAll('.stampbtn').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
  });
  stampRow.appendChild(b);
});

COLORS.forEach((c) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'swatch' + (c.hex === myColor ? ' on' : '');
  b.style.background = c.hex;
  b.title = c.name;
  b.addEventListener('click', () => {
    myColor = c.hex;
    swatches.querySelectorAll('.swatch').forEach((s) => s.classList.remove('on'));
    b.classList.add('on');
  });
  swatches.appendChild(b);
});

const customColorLabel = document.createElement('label');
customColorLabel.className = 'swatch swatch-custom';
customColorLabel.id = 'customColorLabel';
customColorLabel.title = 'More colors';
customColorLabel.htmlFor = 'customColorInput';
customColorLabel.innerHTML = '<input type="color" id="customColorInput" value="#3a6ff0" style="opacity:0;position:absolute;width:1px;height:1px;">';
swatches.appendChild(customColorLabel);

document.getElementById('customColorInput').addEventListener('input', (e) => {
  myColor = e.target.value;
  swatches.querySelectorAll('.swatch').forEach((s) => s.classList.remove('on'));
  customColorLabel.classList.add('on');
});

SIZES.forEach((s, i) => {
  if (i === 0) {
    sizesEl.innerHTML = '';
    const label = document.createElement('label');
    label.textContent = 'Size';
    const range = document.createElement('input');
    range.type = 'range';
    range.id = 'sizeRange';
    range.min = SIZES[0].v;
    range.max = SIZES[SIZES.length - 1].v;
    range.step = 1;
    range.value = mySize;
    const value = document.createElement('span');
    value.className = 'size-value';
    value.id = 'sizeValue';
    value.textContent = mySize + 'px';
    label.appendChild(range);
    label.appendChild(value);
    sizesEl.appendChild(label);

    range.addEventListener('input', (e) => {
      mySize = parseInt(e.target.value, 10);
      document.getElementById('sizeValue').textContent = mySize + 'px';
    });
  }
});

/* ---------------- lobby / replay / async actions ---------------- */

modeClassic.addEventListener('click', () => { if (!modeClassic.disabled) send({ t: 'mode', mode: 'classic' }); });
modeChain.addEventListener('click', () => { if (!modeChain.disabled) send({ t: 'mode', mode: 'chain' }); });
asyncStartBtn.addEventListener('click', () => send({ t: 'asyncStart' }));
asyncCloseBtn.addEventListener('click', () => send({ t: 'asyncClose' }));
asyncStartLiveBtn.addEventListener('click', () => send({ t: 'start' }));
revealDone.addEventListener('click', () => { live.asyncReveal = null; render(); });

$('slidePrev').addEventListener('click', () => { live.slide = Math.max(0, live.slide - 1); render(); });
$('slideNext').addEventListener('click', () => {
  const max = ((st.chain && st.chain.steps) || []).length - 1;
  live.slide = Math.min(max, live.slide + 1);
  render();
});

/* ---------------- artifacts: thumb, best-of card, sticker ---------------- */

function sendThumb(art) {
  if (!art || !art.length) return;
  try {
    const c = document.createElement('canvas');
    c.width = 400; c.height = 300;
    paintArt(c.getContext('2d'), art, 400, 300, '#fffdf5');
    send({ t: 'thumb', data: c.toDataURL('image/jpeg', 0.62) });
  } catch { /* ignore */ }
}

function finalArt() {
  if (st.mode === 'chain' && st.chain && st.chain.steps && st.chain.steps.length) {
    return st.chain.steps[st.chain.steps.length - 1].strokes || [];
  }
  return strokes;
}

function wrapLines(x, text, maxWidth) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  words.forEach((w) => {
    const test = line ? line + ' ' + w : w;
    if (x.measureText(test).width > maxWidth && line) { lines.push(line); line = w; }
    else line = test;
  });
  if (line) lines.push(line);
  return lines;
}

function makeCard({ title, subtitle, rows, quotes, art }) {
  const c = document.createElement('canvas');
  c.width = 800; c.height = 600;
  const x = c.getContext('2d');
  x.fillStyle = '#f7f1e0';
  x.fillRect(0, 0, 800, 600);
  x.strokeStyle = '#d8c9a8';
  x.lineWidth = 6;
  x.strokeRect(14, 14, 772, 572);

  x.fillStyle = '#3a3126';
  x.font = '700 44px "Segoe Print", "Bradley Hand", "Comic Sans MS", cursive';
  x.fillText(title, 44, 78);
  x.font = '400 22px -apple-system, "Segoe UI", Roboto, sans-serif';
  x.fillStyle = '#7a6c57';
  x.fillText(subtitle, 46, 112);

  let y = 168;
  x.font = '700 30px "Segoe Print", "Bradley Hand", cursive';
  rows.forEach((r) => {
    x.fillStyle = '#3a3126';
    x.fillText(r.label, 46, y);
    x.fillStyle = '#c2410c';
    const val = String(r.value);
    x.fillText(val, 754 - x.measureText(val).width, y);
    y += 44;
  });

  if (quotes && quotes.length) {
    y += 14;
    x.fillStyle = '#3a3126';
    x.font = '700 26px "Segoe Print", "Bradley Hand", cursive';
    x.fillText('Best of', 46, y);
    y += 34;
    x.font = 'italic 23px -apple-system, "Segoe UI", Roboto, sans-serif';
    x.fillStyle = '#5a5040';
    quotes.slice(0, 4).forEach((q) => {
      wrapLines(x, q, art ? 470 : 700).forEach((line) => {
        x.fillText(line, 50, y);
        y += 30;
      });
      y += 6;
    });
  }

  if (art && art.length) {
    x.fillStyle = '#fffdf5';
    x.fillRect(534, 372, 230, 180);
    x.strokeStyle = '#b9a97f';
    x.lineWidth = 3;
    x.strokeRect(534, 372, 230, 180);
    drawArtInto(x, art, 540, 378, 218, 168);
  }
  return c.toDataURL('image/png');
}
function drawArtInto(x, art, ox, oy, w, h) {
  x.save();
  x.translate(ox, oy);
  const scale = Math.min(w / BOARD_W, h / BOARD_H);
  x.translate((w - BOARD_W * scale) / 2, (h - BOARD_H * scale) / 2);
  x.scale(scale, scale);
  art.forEach((s) => renderStroke(s, x));
  x.restore();
}

function buildBestOfCard(boardData, wrongGuesses) {
  try {
    const rows = boardData.slice(0, 3).map((p, i) => ({ label: `${['1st', '2nd', '3rd'][i]} ${p.name}`, value: `${p.score} pts` }));
    const quotes = wrongGuesses.slice(0, 4).map((w) => `“${w.text}” — ${w.name}`);
    live.card = makeCard({
      title: 'Doodle Chain — best of',
      subtitle: new Date().toLocaleDateString() + ' · draw • guess • giggle',
      rows,
      quotes,
      art: strokes.length ? strokes : null,
    });
    send({ t: 'card', data: live.card });
  } catch (err) { console.warn('card failed', err); }
}

function buildChainCard() {
  try {
    const c = st.chain && st.chain.steps ? st.chain.steps : [];
    const boardData = (live.final && live.final.board) || [];
    const rows = boardData.slice(0, 3).map((p, i) => ({ label: `${['1st', '2nd', '3rd'][i]} ${p.name}`, value: `${p.score} pts` }));
    const quotes = c.map((s) => (s.kind === 'draw' ? `${s.playerName} drew "${s.word}"` : `${s.playerName} guessed "${s.guess}"`));
    live.card = makeCard({
      title: 'The chain',
      subtitle: quotes[0] ? 'and it mutated into...' : '',
      rows,
      quotes,
      art: c.length ? c[c.length - 1].strokes : null,
    });
    send({ t: 'card', data: live.card });
  } catch (err) { console.warn('chain card failed', err); }
}

/* ----- sticker export ----- */

function stickerPNG(art) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 512;
  drawArtInto(c.getContext('2d'), art, 0, 0, 512, 512);
  return c.toDataURL('image/png');
}

async function makeSticker(art, outEl, btn) {
  if (!art || !art.length) { showSticker(outEl, { ok: false, error: 'Nothing to turn into a sticker yet' }); return; }
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Making sticker…';
  showSticker(outEl, null);
  try {
    const res = await fetch('/api/sticker', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: me.id, data: stickerPNG(art) }),
    });
    const out = await res.json();
    showSticker(outEl, out);
  } catch (err) {
    showSticker(outEl, { ok: false, error: 'Could not reach the server' });
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

function showSticker(outEl, out) {
  if (!outEl) return;
  if (!out) { outEl.classList.add('hidden'); outEl.classList.remove('err'); return; }
  outEl.classList.remove('hidden');
  if (out.ok) {
    outEl.classList.remove('err');
    outEl.textContent = '';
    const msg = document.createElement('div');
    msg.textContent = out.existed ? 'Already in your pack — added this one too! ' : 'Added to your sticker pack! ';
    const a = document.createElement('a');
    a.href = out.url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = out.url;
    a.addEventListener('click', (e) => {
      if (tg && typeof tg.openTelegramLink === 'function') { e.preventDefault(); tg.openTelegramLink(out.url); }
    });
    msg.appendChild(a);
    outEl.appendChild(msg);
  } else {
    outEl.classList.add('err');
    outEl.textContent = 'Sticker failed: ' + (out.error || 'unknown error');
  }
}

stickerBtn.addEventListener('click', () => makeSticker(strokes, stickerOut, stickerBtn));
stickerFinalBtn.addEventListener('click', () => makeSticker(finalArt(), stickerFinalOut, stickerFinalBtn));
stickerOpenBtn.addEventListener('click', () => {
  const art = (st.async && st.async.strokes) || [];
  makeSticker(art, stickerOpenOut, stickerOpenBtn);
});

/* ---------------- share recap (sendData) ---------------- */

function share(recapId, jsonEl) {
  const payload = JSON.stringify({ action: 'recap', recapId });
  if (tg && typeof tg.sendData === 'function') {
    tg.sendData(payload);   // closes the app; bot posts the recap into the chat
  } else if (jsonEl) {
    jsonEl.textContent = 'Not inside Telegram — payload would be:\n' + payload;
    jsonEl.classList.remove('hidden');
  }
}

shareBtn.addEventListener('click', () => {
  const id = (live.reveal && live.reveal.recapId) || (live.asyncReveal && live.asyncReveal.recapId);
  if (id) share(id, $('shareJson'));
});
shareFinalBtn.addEventListener('click', () => {
  if (live.final && live.final.recapId) share(live.final.recapId, $('shareFinalJson'));
});

/* ---------------- boot ---------------- */

guessesEl.innerHTML = '<div class="guess-empty">Waiting for the game to start…</div>';
repaint();
connect();
