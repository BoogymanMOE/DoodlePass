// Temporary browser harness — injected into a copy of public/index.html by
// test/browser.mjs (and removed again afterwards). Runs the scenario machine
// in real time and POSTs a structured result to http://localhost:8096/result.
(function () {
  const qs = new URLSearchParams(location.search);
  const scenario = qs.get('scenario') || 'tools';
  const chat = qs.get('chat') || 'brtest';

  const R = { scenario, errors: [], log: [] };
  const note = (s) => R.log.push(s);
  let posted = false;
  function post() {
    if (posted) return;
    posted = true;
    try {
      fetch('http://localhost:8096/result', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(R),
      }).catch(() => {});
    } catch (e) { /* ignore */ }
  }
  setTimeout(post, 50000);          // fallback: report whatever we have
  window.addEventListener('error', (e) => R.errors.push(e.message));

  // ---- fake second player on a pre-opened socket ----
  const preWs = new WebSocket((location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host);
  let fake = null;
  function openFake() {
    if (fake) return;
    fake = preWs;
    const joinMsg = JSON.stringify({ t: 'join', chatId: chat, user: { id: 'fake01', name: 'Mona' } });
    window.__fakeJoin = () => { if (fake.readyState === 1) fake.send(joinMsg); };
    if (fake.readyState === 1) window.__fakeJoin();
    else fake.addEventListener('open', window.__fakeJoin);
    fake.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.t === 'state' && m.strokes && m.strokes.length && !R.fakeHist) {
        R.fakeHist = m.strokes.length;
      }
    });
  }
  const fakeSend = (m) => { if (fake && fake.readyState === 1) fake.send(JSON.stringify(m)); };

  // ---- helpers into app.js's global scope ----
  const TOOLS_ORDER = ['pen', 'line', 'rect', 'circle', 'marker', 'spray', 'eraser', 'stamp'];
  function paintWith(tool) {
    currentTool = tool;
    if (tool === 'stamp') currentStamp = 'star';
    const r = board.getBoundingClientRect();
    const mk = (t, x, y) => new PointerEvent(t, { bubbles: true, pointerId: 1, buttons: 1, clientX: x, clientY: y });
    const x0 = r.left + 70, y0 = r.top + 70;
    board.dispatchEvent(mk('pointerdown', x0, y0));
    for (let k = 1; k <= 6; k++) board.dispatchEvent(mk('pointermove', x0 + k * 20, y0 + k * 13));
    board.dispatchEvent(mk('pointerup', x0 + 120, y0 + 78));
  }
  function mainLabel() {
    const fb = document.getElementById('fallbackMain');
    return (fb && !fb.classList.contains('hidden')) ? fb.textContent : '';
  }
  function clickMain(t) {
    const fb = document.getElementById('fallbackMain');
    if (fb && !fb.classList.contains('hidden') && !fb.disabled && (!t || fb.textContent.indexOf(t) !== -1)) fb.click();
  }

  const S = { started: false, painted: 0, gstage: 0, nexted: false, again: false, aStage: 0, cStage: 0, complete: false };

  function tick() {
    try {
      if (!st) return;
      const v = currentView();
      if (scenario === 'tools') toolsTick(v);
      else chainTick(v);
    } catch (e) { R.errors.push(e.message); }
    setTimeout(tick, 100);
  }

  function toolsTick(v) {
    const twoPlayers = st.players.length >= 2;

    if (v === 'classic') {
      if (canDraw() && S.painted < TOOLS_ORDER.length) {
        const t = TOOLS_ORDER[S.painted];
        paintWith(t);
        S.painted++;
        R.painted = S.painted;
        R.strokes = strokes.length;
        return;
      }
      if (S.painted >= TOOLS_ORDER.length && !fake) { openFake(); return; }
      if (twoPlayers && S.gstage === 0) { S.gstage = 1; fakeSend({ t: 'guess', text: 'utter nonsense' }); return; }
      if (S.gstage === 1 && st.word) { S.gstage = 2; fakeSend({ t: 'guess', text: st.word }); return; }
      return;
    }

    if (v === 'lobby' && !S.started) {
      if (mainLabel().indexOf('Start game') !== -1) { S.started = true; clickMain('Start game'); }
      return;
    }

    if (v === 'reveal' && !S.nexted && live.reveal) {
      S.nexted = true;
      R.reveal = {
        word: live.reveal.word,
        winner: live.reveal.winner ? live.reveal.winner.name : null,
        rows: document.getElementById('revealResults').children.length,
      };
      clickMain('See final scores');
      return;
    }

    if (v === 'final' && !S.again) {
      R.final = {
        rows: document.getElementById('boardList').children.length,
        card: live.card ? live.card.length : 0,
        bestof: !document.getElementById('bestof').classList.contains('hidden'),
      };
      S.again = true;
      clickMain('Play again');
      return;
    }

    // async challenge after play-again
    if (v === 'lobby' && S.again && S.aStage === 0) { S.aStage = 1; send({ t: 'asyncStart' }); return; }
    if (v === 'asyncDraw') {
      if (S.aStage === 1) { paintWith('pen'); S.aStage = 2; R.asyncPainted = st.async ? st.async.strokes.length : -1; return; }
      if (S.aStage === 2) { S.aStage = 3; clickMain('Publish challenge'); R.asyncWord = st.async ? st.async.word : null; return; }
      return;
    }
    if (v === 'asyncOpen' && fake) {
      R.asyncOpen = true;
      if (S.aStage === 3) { S.aStage = 4; fakeSend({ t: 'asyncGuess', text: 'totally wrong' }); return; }
      if (S.aStage === 4 && st.async && st.async.guesses.length >= 1) { S.aStage = 5; R.asyncWrong = st.async.guesses.length; return; }
      if (S.aStage === 5 && st.async && !st.async.solvedBy.length) { fakeSend({ t: 'asyncGuess', text: st.async.word || 'x' }); return; }
      if (S.aStage === 5 && st.async && st.async.solvedBy.length >= 1) {
        R.asyncSolved = st.async.solvedBy.length;
        R.asyncSolvedName = st.async.solvedBy[0].name;
        S.aStage = 6;
        document.getElementById('stickerOpenBtn').click();
        return;
      }
      if (S.aStage === 6) {
        const out = document.getElementById('stickerOpenOut');
        if (!out.classList.contains('hidden')) {
          R.sticker = out.textContent.slice(0, 90);
          S.aStage = 7;
          document.getElementById('asyncCloseBtn').click();
        }
        return;
      }
      return;
    }
    if (v === 'reveal' && live.asyncReveal && S.aStage === 7) {
      R.asyncReveal = { word: live.asyncReveal.word, solvers: live.asyncReveal.solvers.length };
      S.aStage = 8;
      document.getElementById('revealDone').click();
      return;
    }
    if (v === 'lobby' && S.aStage === 8 && !S.complete) {
      S.complete = true;
      R.backLobby = true;
      R.complete = true;
      note('TOOLS-COMPLETE');
      post();
    }
  }

  function chainTick(v) {
    const twoPlayers = st.players.length >= 2;
    if (v === 'lobby') {
      if (S.cStage === 0 && st.mode !== 'chain') { send({ t: 'mode', mode: 'chain' }); S.cStage = 1; R.mode = 'chain'; return; }
      if (S.cStage === 1 && !fake) { openFake(); return; }
      if (S.cStage === 1 && twoPlayers && mainLabel().indexOf('Start chain') !== -1) { S.cStage = 2; clickMain('Start chain'); return; }
      if (S.cStage >= 11 && !S.complete) { S.complete = true; R.complete = true; note('CHAIN-COMPLETE'); post(); }
      return;
    }
    if (v === 'chainActive' && st.chain) {
      const c = st.chain;
      R.chainSteps = c.total;
      if (S.cStage === 2 && c.index === 0 && c.activeIsMe && c.kind === 'draw') { paintWith('pen'); S.cStage = 3; return; }
      if (S.cStage === 3 && c.index === 0 && c.activeIsMe) { clickMain('Done'); S.cStage = 4; return; }
      if (S.cStage === 4 && c.index === 1) { fakeSend({ t: 'chainGuess', text: 'banana peel' }); S.cStage = 5; return; }
      if (S.cStage === 5 && c.index === 2 && c.activeIsMe && c.kind === 'draw') {
        R.chainWord = c.word;
        paintWith('pen');
        S.cStage = 6;
        return;
      }
      if (S.cStage === 6 && c.index === 2 && c.activeIsMe) { clickMain('Done'); S.cStage = 7; return; }
      if (S.cStage === 7 && c.index === 3) { fakeSend({ t: 'chainGuess', text: 'slippery guy' }); S.cStage = 8; return; }
      return;
    }
    if (v === 'chainReplay' && S.cStage === 8) {
      const ctl = document.getElementById('replayCtl');
      R.replay = {
        visible: !ctl.classList.contains('hidden'),
        label: document.getElementById('slideLabel').textContent,
        badge: document.getElementById('wordBadge').textContent,
      };
      document.getElementById('slideNext').click();
      R.replay2 = {
        label: document.getElementById('slideLabel').textContent,
        badge: document.getElementById('wordBadge').textContent,
      };
      S.cStage = 9;
      clickMain('See final scores');
      return;
    }
    if (v === 'final' && S.cStage === 9) {
      R.chainFinal = Array.from(document.getElementById('boardList').children).map((li) => li.textContent);
      S.cStage = 10;
      S.complete = true;
      R.complete = true;
      note('CHAIN-COMPLETE');
      post();
      return;
    }
    if (v === 'final' && S.cStage >= 10) return;
  }

  setTimeout(tick, 300);
})();
