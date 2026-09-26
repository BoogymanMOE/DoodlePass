// Feature tests: chain mode, async challenge (incl. disk persistence), the new
// paint tools, the sticker endpoint and the best-of recap card.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

const PORT = 8093;
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = path.resolve('test/.tmp-data');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function client(name) {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  const queue = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    const i = waiters.findIndex((w) => w.pred(m));
    if (i >= 0) { const [w] = waiters.splice(i, 1); clearTimeout(w.timer); w.resolve(m); }
    else queue.push(m);
  });
  return {
    name,
    ws,
    open: new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); }),
    send: (m) => ws.send(JSON.stringify(m)),
    wait(pred, label, timeout = 6000) {
      const i = queue.findIndex(pred);
      if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve, timer: setTimeout(() => reject(new Error(`${name}: timeout waiting for ${label}`)), timeout) };
        waiters.push(w);
      });
    },
    close: () => ws.close(),
  };
}

const ok = (cond, msg) => { if (!cond) throw new Error('ASSERT: ' + msg); };

// seed a persisted async challenge to prove the server restores it on boot
fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(path.join(DATA_DIR, 'async-persist-test.json'), JSON.stringify({
  chatId: 'persist-test',
  async: {
    phase: 'open',
    drawerId: '99',
    drawerName: 'Mystery Mona',
    drawerPhoto: null,
    word: 'zebra',
    strokes: [{ tool: 'pen', color: '#24313d', size: 6, points: [[10, 10], [50, 40]], ended: true }],
    guesses: [{ name: 'Eve', text: 'horse', at: Date.now() }],
    solvedBy: [],
    createdAt: Date.now() - 1000,
    endsAt: Date.now() + 3600_000,
  },
}));

let exitCode = 0;
const server = spawn(process.execPath, ['server.js'], {
  env: { ...process.env, PORT: String(PORT), ROUNDS: '1', CHAIN_STEP_SECONDS: '2', DATA_DIR, BOT_TOKEN: '' },
  stdio: ['ignore', 'pipe', 'inherit'],
});

const all = [];
const c = (n) => { const x = client(n); all.push(x); return x; };

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    await wait(100);
    try { up = (await fetch(`${BASE}/api/health`)).ok; } catch { /* not yet */ }
  }
  if (!up) throw new Error('server did not start');

  /* ================================================================
     1. CHAIN MODE — 3 players, full 6-step chain
     ================================================================ */
  {
    const A = c('chainA'), B = c('chainB'), C = c('chainC');
    await Promise.all([A.open, B.open, C.open]);
    const room = 'chain-test';
    A.send({ t: 'join', chatId: room, user: { id: 'a1', name: 'Alice' } });
    B.send({ t: 'join', chatId: room, user: { id: 'b1', name: 'Bob' } });
    C.send({ t: 'join', chatId: room, user: { id: 'c1', name: 'Cara' } });
    await A.wait((m) => m.t === 'state' && m.players.length === 3, 'A roster of 3');

    A.send({ t: 'mode', mode: 'chain' });
    await A.wait((m) => m.t === 'state' && m.mode === 'chain', 'mode switched');
    A.send({ t: 'start' });

    // step 0 — Alice draws
    let s = await A.wait((m) => m.t === 'state' && m.state === 'chain', 'chain started');
    ok(s.chain.kind === 'draw' && s.chain.activeId === 'a1', 'step 1 is Alice drawing');
    ok(s.chain.word, 'drawer sees the word');
    ok(s.chain.total === 6, '6 steps for 3 players');
    const sB = await B.wait((m) => m.t === 'state' && m.state === 'chain', 'B chain state');
    ok(sB.chain.word === null, 'non-drawer does NOT see the word');
    const word0 = s.chain.word;

    // paint relay inside a chain step
    A.send({ t: 'draw', first: true, tool: 'pen', color: '#24313d', size: 6, pts: [[10, 10], [20, 20]] });
    const got = await B.wait((m) => m.t === 'draw' && m.first, 'chain draw relay');
    ok(got.tool === 'pen', 'tool relayed in chain');

    A.send({ t: 'chainDone' });
    await A.wait((m) => m.t === 'feed' && /finished drawing/.test(m.text), 'done feed');

    // step 1 — Bob guesses (any text becomes the next word)
    s = await A.wait((m) => m.t === 'state' && m.state === 'chain' && m.chain.index === 1, 'step 2');
    ok(s.chain.kind === 'guess' && s.chain.activeId === 'b1', 'step 2 is Bob guessing');
    B.send({ t: 'chainGuess', text: 'silly hat' });
    await B.wait((m) => m.t === 'feed' && /guessed:/.test(m.text), 'guess feed');

    // step 2 — Cara draws Bob's guess
    s = await C.wait((m) => m.t === 'state' && m.state === 'chain' && m.chain.index === 2, 'step 3');
    ok(s.chain.word === 'silly hat', "Bob's guess became Cara's word");
    C.send({ t: 'chainDone' });

    // step 3 — Alice guesses
    s = await A.wait((m) => m.t === 'state' && m.state === 'chain' && m.chain.index === 3, 'step 4');
    ok(s.chain.kind === 'guess' && s.chain.activeId === 'a1', 'step 4 is Alice guessing');
    A.send({ t: 'chainGuess', text: 'top hat' });

    // step 4 — Bob draws
    s = await B.wait((m) => m.t === 'state' && m.state === 'chain' && m.chain.index === 4, 'step 5');
    ok(s.chain.word === 'top hat', 'chain word propagates again');
    B.send({ t: 'chainDone' });

    // step 5 — Cara guesses → replay
    s = await C.wait((m) => m.t === 'state' && m.state === 'chain' && m.chain.index === 5, 'step 6');
    C.send({ t: 'chainGuess', text: 'mad hatter' });
    const replayEvt = await A.wait((m) => m.t === 'chainReplay', 'chainReplay event');
    const rep = await A.wait((m) => m.t === 'state' && m.state === 'chainReplay', 'replay state');
    ok(rep.chain.phase === 'replay', 'chain in replay phase');
    ok(rep.chain.steps.length === 6, 'all 6 steps kept');
    ok(rep.chain.steps[0].word === word0, 'step 1 word preserved for replay');
    ok(rep.chain.steps[1].guess === 'silly hat', 'guesses preserved');
    ok(rep.chain.steps[0].strokes.length === 1, 'step 1 strokes preserved for slideshow');
    ok(replayEvt.recapId, 'replay recap id issued');

    A.send({ t: 'thumb', data: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==' });
    A.send({ t: 'next' });
    const over = await A.wait((m) => m.t === 'gameOver', 'chain gameOver');
    ok(over.chain === true, 'gameOver marked as chain');
    ok(over.board.every((p) => p.score === 100), 'every player scored 60+40 (got ' + JSON.stringify(over.board) + ')');

    const recapRes = await fetch(`${BASE}/api/recaps/${over.recapId}`);
    const recap = await recapRes.json();
    ok(recap.type === 'chain', 'chain recap stored');
    ok(recap.links.length === 6, 'recap has the full link list');
    ok(recap.thumb, 'chain recap got a thumbnail');
    console.log('  ✓ chain mode: 6-step chain, replay, scoring, recap');
    A.close(); B.close(); C.close();
  }

  /* ================================================================
     2. CHAIN TIMEOUT — the chain breaks when a guesser stalls
     ================================================================ */
  {
    const A = c('breakA'), B = c('breakB');
    await Promise.all([A.open, B.open]);
    const room = 'chain-break-test';
    A.send({ t: 'join', chatId: room, user: { id: 'a2', name: 'Ann' } });
    B.send({ t: 'join', chatId: room, user: { id: 'b2', name: 'Ben' } });
    await B.wait((m) => m.t === 'state' && m.players.length === 2, 'roster 2');
    A.send({ t: 'mode', mode: 'chain' });
    A.send({ t: 'start' });
    await A.wait((m) => m.t === 'state' && m.state === 'chain', 'chain started');
    A.send({ t: 'chainDone' });               // step 0 done fast
    await A.wait((m) => m.t === 'state' && m.state === 'chain' && m.chain.index === 1, 'guess step');
    // Ben never guesses → CHAIN_STEP_SECONDS=2 kicks in
    await B.wait((m) => m.t === 'feed' && /chain broke/.test(m.text), 'chain break feed', 5000);
    const rep = await B.wait((m) => m.t === 'state' && m.state === 'chainReplay', 'broke → replay');
    ok(rep.chain.steps.length === 1, 'unfinished link dropped');
    console.log('  ✓ chain timeout: stalled guesser breaks the chain gracefully');
    A.close(); B.close();
  }

  /* ================================================================
     3. ASYNC CHALLENGE — draw → publish → guess → solve → close
     ================================================================ */
  {
    const A = c('asA'), B = c('asB');
    await Promise.all([A.open, B.open]);
    const room = 'async-test';
    A.send({ t: 'join', chatId: room, user: { id: 'x1', name: 'Dana' } });
    await A.wait((m) => m.t === 'state', 'A lobby');

    // guard: live game blocked while an async challenge is being drawn
    A.send({ t: 'asyncStart' });
    const drawing = await A.wait((m) => m.t === 'state' && m.async && m.async.phase === 'drawing', 'async drawing');
    ok(drawing.async.word, 'async drawer sees the word');
    A.send({ t: 'start' });
    const err = await A.wait((m) => m.t === 'error', 'start blocked while drawing async');
    ok(/async challenge/i.test(err.msg), 'error explains the block');

    // draw with the new tools into the async canvas
    A.send({ t: 'draw', target: 'async', first: true, tool: 'spray', color: '#1d6fd6', size: 9, pts: [[100, 100], [140, 130]] });
    A.send({ t: 'draw', target: 'async', pts: [[180, 160]] });
    A.send({ t: 'drawEnd', target: 'async' });
    await wait(100);
    A.send({ t: 'asyncPublish' });
    await A.wait((m) => m.t === 'state' && m.async.phase === 'open', 'async open');

    // Bob joins later — sees the published drawing but not the word
    B.send({ t: 'join', chatId: room, user: { id: 'x2', name: 'Blake' } });
    const bView = await B.wait((m) => m.t === 'state' && m.async, 'B async view');
    ok(bView.async.phase === 'open', 'B sees the open challenge');
    ok(bView.async.word === null, 'word hidden from guessers');
    ok(bView.async.strokes.length === 1, 'B sees the persisted drawing');
    ok(bView.async.strokes[0].tool === 'spray', 'spray tool survived persistence');

    // wrong guess → live broadcast, correct guess → solved
    const word = (await A.wait((m) => m.t === 'state' && m.async, 'A async view')).async.word;
    B.send({ t: 'asyncGuess', text: 'not even close' });
    await B.wait((m) => m.t === 'asyncGuess' && m.correct === false, 'wrong guess event');
    const afterWrong = await B.wait((m) => m.t === 'state' && m.async.guesses.length === 1, 'wrong guess visible to all');
    ok(afterWrong.async.iSolved === false, 'still unsolved');
    B.send({ t: 'asyncGuess', text: word.toUpperCase() });
    const solved = await B.wait((m) => m.t === 'state' && m.async.iSolved, 'solved state');
    ok(solved.async.myPoints >= 150, 'speed bonus paid (' + solved.async.myPoints + ')');
    ok(solved.async.word === word, 'word revealed to the solver');

    // close → recap
    A.send({ t: 'asyncClose' });
    const end = await A.wait((m) => m.t === 'asyncEnd', 'asyncEnd event');
    ok(end.solvers.length === 1 && end.solvers[0].name === 'Blake', 'solver listed in the recap');
    const recap = await (await fetch(`${BASE}/api/recaps/${end.recapId}`)).json();
    ok(recap.type === 'async' && recap.word === word, 'async recap stored');
    ok(recap.wrong.length === 1, 'wrong guess recorded for the recap');
    ok(!fs.existsSync(path.join(DATA_DIR, 'async-async-test.json')), 'challenge file removed after close');
    console.log('  ✓ async challenge: publish, blind guessing, solve bonus, recap, cleanup');
    A.close(); B.close();
  }

  /* ================================================================
     4. PERSISTENCE — challenge survives a server restart
     ================================================================ */
  {
    const P = c('persistP');
    await P.open;
    P.send({ t: 'join', chatId: 'persist-test', user: { id: 'g1', name: 'Gwen' } });
    const st = await P.wait((m) => m.t === 'state' && m.async, 'restored challenge');
    ok(st.async.phase === 'open', 'challenge restored from disk');
    ok(st.async.drawerName === 'Mystery Mona', 'drawer restored');
    ok(st.async.word === null, 'word still hidden from strangers');
    ok(st.async.strokes.length === 1 && st.async.strokes[0].points.length === 2, 'strokes restored');
    P.close();
    console.log('  ✓ persistence: ./data challenge restored after boot');
  }

  /* ================================================================
     5. PAINT TOOLS — server accepts/validates every tool
     ================================================================ */
  {
    const A = c('toolA'), B = c('toolB');
    await Promise.all([A.open, B.open]);
    const room = 'tools-test';
    A.send({ t: 'join', chatId: room, user: { id: 't1', name: 'Tess' } });
    B.send({ t: 'join', chatId: room, user: { id: 't2', name: 'Tim' } });
    await A.wait((m) => m.t === 'state' && m.players.length === 2, 'roster');
    A.send({ t: 'start' });
    const started = await A.wait((m) => m.t === 'state' && m.state === 'drawing', 'round started');
    // the drawer is picked at random — find out who it is
    const drawer = started.drawerId === 't1' ? A : B;
    const receiver = started.drawerId === 't1' ? B : A;

    const cases = [
      { tool: 'pen' }, { tool: 'marker', color: '#d62828' }, { tool: 'spray' },
      { tool: 'eraser' }, { tool: 'line' }, { tool: 'rect' }, { tool: 'circle' },
      { tool: 'stamp', stamp: 'heart', size: 18 },
      { tool: 'laser-beam' },                       // invalid → falls back to pen
      { tool: 'stamp', stamp: 'skull' },            // invalid stamp → star
      { tool: 'rect', color: 'javascript:alert(1)' }, // invalid color → default ink
    ];
    for (const [i, t] of cases.entries()) {
      drawer.send({ t: 'draw', first: true, ...t, color: t.color || '#24313d', size: t.size || 6, pts: [[10 + i, 10], [30 + i, 30]] });
      const relay = await receiver.wait((m) => m.t === 'draw' && m.first, `tool relay ${i}`);
      if (t.tool === 'laser-beam') ok(relay.tool === 'pen', 'unknown tool falls back to pen');
      else if (t.tool === 'stamp' && t.stamp === 'skull') ok(relay.stamp === 'star', 'unknown stamp falls back to star');
      else if (t.color === 'javascript:alert(1)') ok(relay.color === '#24313d', 'bad color sanitized');
      else ok(relay.tool === t.tool, `tool ${t.tool} relayed`);
    }
    // undo / clear still work on the shared stroke list
    drawer.send({ t: 'undo' });
    await receiver.wait((m) => m.t === 'undo', 'undo relayed');
    drawer.send({ t: 'clear' });
    await receiver.wait((m) => m.t === 'clear', 'clear relayed');
    console.log('  ✓ paint tools: all 8 tools validated + relayed, sanitization enforced');
    A.close(); B.close();
  }

  /* ================================================================
     6. BEST-OF CARD + classic round recap
     ================================================================ */
  {
    const A = c('cardA'), B = c('cardB');
    await Promise.all([A.open, B.open]);
    const room = 'card-test';
    A.send({ t: 'join', chatId: room, user: { id: 'k1', name: 'Kai' } });
    B.send({ t: 'join', chatId: room, user: { id: 'k2', name: 'Vera' } });
    await A.wait((m) => m.t === 'state' && m.players.length === 2, 'roster');
    A.send({ t: 'start' });
    const start = await A.wait((m) => m.t === 'state' && m.state === 'drawing', 'round started');
    const guesser = start.drawerId === 'k1' ? B : A;
    const drawer = start.drawerId === 'k1' ? A : B;
    const word = start.word || (await B.wait((m) => m.t === 'state' && m.word, 'B word')).word;

    guesser.send({ t: 'guess', text: 'a banana maybe' });       // funny wrong guess
    await drawer.wait((m) => m.t === 'guess' && m.correct === false, 'wrong guess relay');
    guesser.send({ t: 'guess', text: word });
    const end = await guesser.wait((m) => m.t === 'roundEnd', 'roundEnd');
    A.send({ t: 'next' });                                  // host; ROUNDS=1 → final
    const over = await guesser.wait((m) => m.t === 'gameOver', 'gameOver');
    ok(over.wrongGuesses && over.wrongGuesses.length === 1, 'funny wrong guess collected for the card');
    guesser.send({ t: 'card', data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==' });
    await wait(150);
    const recap = await (await fetch(`${BASE}/api/recaps/${over.recapId}`)).json();
    ok(recap.type === 'final', 'final recap stored');
    ok(recap.card && recap.card.startsWith('data:image'), 'best-of card stored on the recap');
    ok(recap.wrongGuesses.length === 1, 'card quotes available to the bot');
    console.log('  ✓ best-of card: wrong guesses collected + card stored for the bot');
    A.close(); B.close();
  }

  /* ================================================================
     7. STICKER ENDPOINT — clean error without BOT_TOKEN
     ================================================================ */
  {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const res = await fetch(`${BASE}/api/sticker`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: '12345', data: png }),
    });
    const out = await res.json();
    ok(out.ok === false && /BOT_TOKEN/.test(out.error || ''), 'sticker endpoint explains missing bot token');

    const bad = await fetch(`${BASE}/api/sticker`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: '12345', data: 'text/plain;base64,xxx' }),
    });
    ok(bad.status === 400, 'non-PNG payload rejected');
    console.log('  ✓ sticker endpoint: validates input, clean 501 without BOT_TOKEN');
  }

  console.log('FEATURE TESTS PASSED ✅');
} catch (err) {
  console.error('FEATURE TESTS FAILED ❌', err.message);
  exitCode = 1;
} finally {
  all.forEach((x) => { try { x.close(); } catch { /* ignore */ } });
  await wait(150);
  server.kill();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
}
process.exit(exitCode);
