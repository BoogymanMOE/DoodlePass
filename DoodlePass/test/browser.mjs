// Real-time browser E2E test.
// Boots the game server + a result receiver, drives two auto-play scenarios in
// headless Chrome (tools/classic/async and chain), and asserts the structured
// result each harness page POSTs back. Skips cleanly when Chrome is missing.
import { spawn, execSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const GAME_PORT = 8095;
const RESULT_PORT = 8096;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (cond, msg) => { if (!cond) throw new Error('ASSERT: ' + msg); };

function findChrome() {
  const candidates = [process.env.CHROME_PATH];
  if (process.platform === 'win32') {
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = process.env.LOCALAPPDATA || '';
    candidates.push(
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      local && path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      process.env.CHROME_PATH,
    );
  } else {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
    );
  }
  return candidates.filter(Boolean).find((p) => { try { return fs.existsSync(p); } catch { return false; } });
}

function killTree(proc) {
  if (!proc || proc.exitCode !== null) return;
  try {
    if (process.platform === 'win32') execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' });
    else proc.kill('SIGKILL');
  } catch { /* already gone */ }
}

const chrome = findChrome();
if (!chrome) {
  console.log('BROWSER TEST SKIPPED ⏭️ (no Chrome found — set CHROME_PATH to enable)');
  process.exit(0);
}

/* ---- result receiver ---- */
const results = {};
const receiver = http.createServer((req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type');
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method === 'POST' && req.url === '/result') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try {
        const r = JSON.parse(body);
        results[r.scenario] = r;
        console.log(`  ← received result for "${r.scenario}" (${r.log.length} log lines)`);
      } catch { /* ignore malformed */ }
      res.writeHead(200); res.end('ok');
    });
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => receiver.listen(RESULT_PORT, r));

/* ---- game server ---- */
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-browser-data-'));
const server = spawn(process.execPath, ['server.js'], {
  env: { ...process.env, PORT: String(GAME_PORT), ROUNDS: '1', DATA_DIR: dataDir, BOT_TOKEN: '' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
let up = false;
for (let i = 0; i < 50 && !up; i++) {
  await wait(100);
  try { up = (await fetch(`http://localhost:${GAME_PORT}/api/health`)).ok; } catch { /* not yet */ }
}
if (!up) throw new Error('server did not start');

/* ---- build the harness page (injected into a copy of index.html) ---- */
const harnessSrc = fs.readFileSync(path.resolve('test/harness-src.js'), 'utf8');
let indexHtml = fs.readFileSync(path.resolve('public/index.html'), 'utf8');
// strip the external Telegram SDK: outside Telegram it would route the primary
// action through MainButton, which the fallback button the harness clicks hides
indexHtml = indexHtml.replace('<script src="https://telegram.org/js/telegram-web-app.js"></script>', '');
const harnessPath = path.resolve('public/__browsertest.html');
fs.writeFileSync(harnessPath, indexHtml.replace('</body>', `<script>\n${harnessSrc}\n</script>\n</body>`));

/* ---- launch both scenarios ---- */
const scenarios = [
  { name: 'tools', profile: fs.mkdtempSync(path.join(os.tmpdir(), 'dc-chrome-tools-')) },
  { name: 'chain', profile: fs.mkdtempSync(path.join(os.tmpdir(), 'dc-chrome-chain-')) },
];
const chromeProcs = scenarios.map((s) => spawn(chrome, [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  `--user-data-dir=${s.profile}`,
  '--window-size=520,900',
  `http://localhost:${GAME_PORT}/__browsertest.html?scenario=${s.name}&chat=${s.name}run`,
], { stdio: 'ignore' }));

let exitCode = 0;
try {
  // wait for both results (or generous timeout)
  const deadline = Date.now() + 75000;
  while ((!results.tools || !results.chain) && Date.now() < deadline) await wait(500);

  const t = results.tools;
  const c = results.chain;

  ok(t, 'tools scenario posted a result');
  ok(c, 'chain scenario posted a result');

  console.log('--- tools scenario ---');
  ok(!t.errors.length, 'tools: no page errors (' + t.errors.join('; ') + ')');
  ok(t.painted === 8 && t.strokes === 8, `tools: painted all 8 tools (painted=${t.painted} strokes=${t.strokes})`);
  ok(t.fakeHist === 8, `tools: late joiner received full stroke history (fakeHist=${t.fakeHist})`);
  ok(t.reveal && t.reveal.word && t.reveal.winner === 'Mona', 'tools: round reveal (word + winner) rendered');
  ok(t.reveal.rows >= 3, `tools: reveal rows rendered (${t.reveal.rows})`);
  ok(t.final && t.final.rows === 2, `tools: final scoreboard rows (${t.final.rows})`);
  ok(t.final.card > 5000, `tools: best-of card rendered (${t.final.card} bytes)`);
  ok(t.final.bestof === true, 'tools: best-of card shown in final panel');
  ok(t.asyncPainted === 1, `tools: async canvas stroke (${t.asyncPainted})`);
  ok(t.asyncOpen === true, 'tools: async challenge opened');
  ok(t.asyncWrong >= 1, `tools: wrong guess visible (${t.asyncWrong})`);
  ok(t.asyncSolved >= 1, 'tools: solver listed');
  ok(t.sticker && /BOT_TOKEN/.test(t.sticker), `tools: sticker error surfaced ("${t.sticker}")`);
  ok(t.asyncReveal && t.asyncReveal.word === t.asyncWord && t.asyncReveal.solvers >= 1, 'tools: async reveal rendered');
  ok(t.backLobby === true && t.complete === true, 'tools: returned to lobby after Done');
  console.log('  ✓ classic tools → reveal → card → async → sticker → close');

  console.log('--- chain scenario ---');
  ok(!c.errors.length, 'chain: no page errors (' + c.errors.join('; ') + ')');
  ok(c.mode === 'chain', 'chain: mode switched');
  ok(c.chainSteps === 4, `chain: 4 steps for 2 players (${c.chainSteps})`);
  ok(c.chainWord === 'banana peel', `chain: guess became the next drawing word ("${c.chainWord}")`);
  ok(c.replay && c.replay.visible === true && c.replay.label === '1/4', `chain: replay visible at 1/4 ("${c.replay && c.replay.label}")`);
  ok(c.replay2 && c.replay2.label === '2/4' && /banana peel/.test(c.replay2.badge), `chain: slide 2 shows the guess ("${c.replay2.badge}")`);
  ok(c.chainFinal && c.chainFinal.length === 2, 'chain: final scoreboard');
  const joined = c.chainFinal.join(' | ');
  ok(/120 pts/.test(joined) && /80 pts/.test(joined), `chain: scores 120/80 (${joined})`);
  ok(c.complete === true, 'chain: scenario completed');
  console.log('  ✓ chain steps → word propagation → slideshow → final scores');

  console.log('BROWSER TESTS PASSED ✅');
} catch (err) {
  console.error('BROWSER TESTS FAILED ❌', err.message);
  if (results.tools) console.error('tools log tail:', results.tools.log.slice(-25).join(' | '));
  else console.error('tools scenario posted nothing');
  if (results.chain) console.error('chain log tail:', results.chain.log.slice(-25).join(' | '));
  else console.error('chain scenario posted nothing');
  exitCode = 1;
} finally {
  chromeProcs.forEach(killTree);
  server.kill();
  receiver.close();
  try { fs.rmSync(harnessPath, { force: true }); } catch { /* ignore */ }
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  scenarios.forEach((s) => { try { fs.rmSync(s.profile, { recursive: true, force: true }); } catch { /* ignore */ } });
}
process.exit(exitCode);
