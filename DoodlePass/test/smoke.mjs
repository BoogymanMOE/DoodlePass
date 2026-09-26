// Smoke test: boots the server, connects two fake clients, plays one round.
// Verifies lobby → start → drawing relay → wrong/correct guess → scoring →
// recap storage → recap API.
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const PORT = 8791;
const BASE = `http://localhost:${PORT}`;

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

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
    wait(pred, label, timeout = 5000) {
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

let exitCode = 0;
let A = null, B = null;
const server = spawn(process.execPath, ['server.js'], {
  env: { ...process.env, PORT: String(PORT), ROUNDS: '1' },
  stdio: ['ignore', 'pipe', 'inherit'],
});

try {
  // wait for server
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    await wait(100);
    try { up = (await fetch(`${BASE}/api/health`)).ok; } catch { /* not yet */ }
  }
  if (!up) throw new Error('server did not start');

  const a = client('A');
  const b = client('B');
  A = a; B = b;
  await a.open;
  await b.open;

  const chat = 'smoke-test';
  A.send({ t: 'join', chatId: chat, user: { id: '1', name: 'Alice' } });
  B.send({ t: 'join', chatId: chat, user: { id: '2', name: 'Bob' } });

  const stA1 = await A.wait((m) => m.t === 'state' && m.players.length === 2, 'A state with 2 players');
  ok(stA1.hostId === '1', 'A (first joiner) should be host');
  const stB1 = await B.wait((m) => m.t === 'state' && m.players.length === 2, 'B state with 2 players');

  // host starts
  A.send({ t: 'start' });
  const startA = await A.wait((m) => m.t === 'state' && m.state === 'drawing', 'A drawing state');
  const startB = await B.wait((m) => m.t === 'state' && m.state === 'drawing', 'B drawing state');
  const drawerIsA = startA.drawerId === '1';
  ok(drawerIsA ? startA.word : startB.word, 'drawer must receive the word');
  ok(drawerIsA ? startB.word === null : startA.word === null, 'guesser must NOT receive the word');
  const drawer = drawerIsA ? A : B;
  const guesser = drawerIsA ? B : A;
  const word = startA.word || startB.word;
  ok(word, 'somebody received a word');

  // drawer draws a stroke; guesser should receive it live
  drawer.send({ t: 'draw', first: true, color: '#24313d', size: 6, pts: [[100, 100], [150, 150]] });
  drawer.send({ t: 'draw', pts: [[200, 200]] });
  const stroke = await guesser.wait((m) => m.t === 'draw' && m.first, 'draw relay');
  ok(stroke.pts.length === 2, 'first draw message carries initial points');
  const seg = await guesser.wait((m) => m.t === 'draw' && !m.first, 'draw segment');
  ok(seg.pts[0][0] === 200, 'segment relayed');
  drawer.send({ t: 'drawEnd' });

  // wrong guess → broadcast, round continues
  guesser.send({ t: 'guess', text: 'definitely not the word' });
  const wrong = await drawer.wait((m) => m.t === 'guess', 'wrong guess relay');
  ok(wrong.correct === false, 'wrong guess flagged incorrect');

  // guesser must not be able to draw
  guesser.send({ t: 'draw', first: true, color: '#d62828', size: 6, pts: [[5, 5]] });
  await wait(150);
  const notDrawer = await drawer
    .wait((m) => m.t === 'draw' && m.first === true, 'non-drawer draw should be ignored', 400)
    .then(() => false, () => true);
  ok(notDrawer, 'non-drawer draw must be dropped');

  // correct guess → round ends with points
  guesser.send({ t: 'guess', text: `  ${word.toUpperCase()}! ` });
  const roundEnd = await guesser.wait((m) => m.t === 'roundEnd', 'roundEnd');
  ok(roundEnd.reason === 'guessed', 'round ends on first correct guess');
  ok(roundEnd.winner && roundEnd.winner.points > 0, 'winner scored points');
  ok(roundEnd.recapId, 'recap id issued');
  const drawerEnd = await drawer.wait((m) => m.t === 'roundEnd', 'drawer roundEnd');
  ok(drawerEnd.drawer.bonus > 0, 'drawer got a bonus');
  const finalSt = await guesser.wait((m) => m.t === 'state' && m.state === 'recap', 'recap state');
  const winnerScore = finalSt.players.find((p) => p.id === roundEnd.winner.id).score;
  ok(winnerScore === roundEnd.winner.points, 'score persisted to state');

  // thumbnail upload + recap API
  guesser.send({ t: 'thumb', data: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==' });
  await wait(150);
  const recapRes = await fetch(`${BASE}/api/recaps/${roundEnd.recapId}`);
  ok(recapRes.ok, 'recap API responds');
  const recap = await recapRes.json();
  ok(recap.word === word, 'recap stores the word');
  ok(recap.thumb && recap.thumb.startsWith('data:image'), 'recap stores the thumbnail');

  // with ROUNDS=1, host asks for next → final scores
  A.send({ t: 'next' });
  const over = await guesser.wait((m) => m.t === 'gameOver', 'gameOver');
  ok(over.board && over.board.length === 2, 'final board has all players');
  ok(over.recapId, 'final recap id issued');

  // play again → lobby with reset scores
  A.send({ t: 'playAgain' });
  const lobby = await guesser.wait((m) => m.t === 'state' && m.state === 'lobby', 'lobby after playAgain');
  ok(lobby.players.every((p) => p.score === 0), 'scores reset on play again');

  // static file serving
  const page = await fetch(`${BASE}/`);
  ok(page.ok && (await page.text()).includes('Doodle Chain'), 'index.html served');

  console.log('SMOKE TEST PASSED ✅');
} catch (err) {
  console.error('SMOKE TEST FAILED ❌', err.message);
  exitCode = 1;
} finally {
  try { A && A.close(); } catch { /* ignore */ }
  try { B && B.close(); } catch { /* ignore */ }
  await wait(200);
  server.kill();
}
process.exit(exitCode);
