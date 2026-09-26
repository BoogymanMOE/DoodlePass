// Doodle Chain — Telegram bot (long polling, no extra deps).
// Receives the recap payload from the mini app via web_app_data, fetches the
// full recap + drawing thumbnail from the game server, and posts it into the
// group chat with an inline "Play again" web_app button.
//
// Env:
//   BOT_TOKEN   — from @BotFather
//   APP_URL     — public HTTPS URL of the mini app (same origin as game server is fine)
//   GAME_SERVER — base URL of the game server (default http://localhost:8080)

const TOKEN = process.env.BOT_TOKEN;
const APP_URL = (process.env.APP_URL || '').replace(/\/$/, '');
const GAME_SERVER = (process.env.GAME_SERVER || 'http://localhost:8080').replace(/\/$/, '');

if (!TOKEN || !APP_URL) {
  console.error('Missing BOT_TOKEN and/or APP_URL env vars. See README.md.');
  process.exit(1);
}

const API = `https://api.telegram.org/bot${TOKEN}`;
let offset = 0;

const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, payload) {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
}

function playAgainKeyboard(chatId) {
  const url = `${APP_URL}${APP_URL.includes('?') ? '&' : '?'}chat=${encodeURIComponent(chatId)}`;
  return { inline_keyboard: [[{ text: 'Play again', web_app: { url } }]] };
}

function captionFor(rc) {
  if (rc.type === 'chain') {
    const seq = (rc.links || []).map((l) => (l.type === 'draw' ? l.word : l.text));
    const board = (rc.board || [])
      .slice(0, 3)
      .map((p) => `${esc(p.name)} ${p.score}`)
      .join(' · ');
    const chain = seq.length ? `Chain: ${seq.map(esc).join(' → ')}` : 'The chain mutated!';
    return `Doodle Chain — chain complete!\n${chain}\n\n${board}`;
  }
  if (rc.type === 'async') {
    const solvers = (rc.solvers || [])
      .map((s) => `${esc(s.name)} +${s.points}`)
      .join('\n');
    const wrong = (rc.wrong || []).slice(-3)
      .map((w) => `"${esc(w.text)}" — ${esc(w.name)}`)
      .join('\n');
    return `Async challenge closed (drawn by ${esc(rc.drawer)})\nWord: <b>${esc(rc.word)}</b>\n\n${solvers || 'Nobody solved it'}${wrong ? `\n\n${wrong}` : ''}`;
  }
  if (rc.type === 'final') {
    const lines = (rc.board || [])
      .slice(0, 5)
      .map((p, i) => `${i + 1}. ${esc(p.name)} — ${p.score} pts`);
    const wrong = (rc.wrongGuesses || []).slice(0, 3)
      .map((w) => `"${esc(w.text)}" — ${esc(w.name)}`)
      .join('\n');
    return `Doodle Chain — final scores (${rc.rounds} rounds)\n\n${lines.join('\n')}${wrong ? `\n\n${wrong}` : ''}`;
  }
  const head = `Doodle Chain · Round ${rc.round}/${rc.rounds}\nWord: <b>${esc(rc.word)}</b>`;
  if (rc.winner) {
    const t = (rc.winner.ms / 1000).toFixed(1);
    const drawer = rc.drawer
      ? `\nDrawer: ${esc(rc.drawer.name)} +${rc.drawer.bonus}`
      : '';
    return `${head}\n<b>${esc(rc.winner.name)}</b> guessed it in ${t}s → +${rc.winner.points} pts${drawer}`;
  }
  if (rc.reason === 'timeout') return `${head}\nTime ran out — nobody guessed it!`;
  return `${head}\nRound interrupted — nobody guessed it.`;
}

async function postRecap(chatId, recapId) {
  const res = await fetch(`${GAME_SERVER}/api/recaps/${encodeURIComponent(recapId)}`);
  if (!res.ok) {
    await call('sendMessage', { chat_id: chatId, text: 'Doodle Chain — the round is over, but the recap expired. Start a new one!' });
    return;
  }
  const rc = await res.json();
  const caption = captionFor(rc);
  const reply_markup = playAgainKeyboard(chatId);

  // prefer the best-of card for final recaps, else the drawing thumbnail
  const image = (rc.type === 'final' && rc.card) || rc.thumb;
  if (image && image.startsWith('data:image')) {
    try {
      const comma = image.indexOf(',');
      const base64 = image.slice(comma + 1);
      const bin = Buffer.from(base64, 'base64');
      const isPng = image.startsWith('data:image/png');
      const fd = new FormData();
      fd.append('chat_id', String(chatId));
      fd.append('photo', new Blob([bin], { type: isPng ? 'image/png' : 'image/jpeg' }),
        isPng ? 'doodle-card.png' : 'doodle.jpg');
      fd.append('caption', caption);
      fd.append('parse_mode', 'HTML');
      fd.append('reply_markup', JSON.stringify(reply_markup));
      const up = await fetch(`${API}/sendPhoto`, { method: 'POST', body: fd });
      const upJson = await up.json();
      if (upJson.ok) return;
      console.warn('sendPhoto failed, falling back to text:', upJson.description);
    } catch (err) {
      console.warn('thumbnail upload failed:', err.message);
    }
  }
  await call('sendMessage', { chat_id: chatId, text: caption, parse_mode: 'HTML', reply_markup });
}

async function handleUpdate(update) {
  const msg = update.message;
  if (!msg || !msg.chat) return;

  if (msg.web_app_data) {
    let data;
    try { data = JSON.parse(msg.web_app_data.data); } catch { data = null; }
    if (data && data.action === 'recap' && data.recapId) {
      await postRecap(msg.chat.id, data.recapId);
    } else {
      await call('sendMessage', { chat_id: msg.chat.id, text: `Received: ${esc(msg.web_app_data.data)}` });
    }
    return;
  }

  if (typeof msg.text === 'string' && (msg.text.startsWith('/start') || msg.text.startsWith('/play') || msg.text === '/newgame')) {
    await call('sendMessage', {
      chat_id: msg.chat.id,
      text: '<b>Doodle Chain</b> — draw it, guess it, chain it.\nOpen the game below',
      parse_mode: 'HTML',
      reply_markup: playAgainKeyboard(msg.chat.id),
    });
    return;
  }
}

async function loop() {
  console.log('Bot polling started.');
  for (;;) {
    try {
      const res = await fetch(`${API}/getUpdates?timeout=30&offset=${offset}`);
      const json = await res.json();
      if (!json.ok) {
        console.error('getUpdates failed:', json.description);
        await sleep(3000);
        continue;
      }
      for (const update of json.result) {
        offset = update.update_id + 1;
        try { await handleUpdate(update); } catch (err) { console.error('update handler error:', err); }
      }
    } catch (err) {
      console.error('poll error:', err.message);
      await sleep(2000);
    }
  }
}

loop();
