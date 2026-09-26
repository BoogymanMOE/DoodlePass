# ✏️ Doodle Chain

A Telegram Mini App drawing-and-guessing party game for group chats.
One player draws a secret word, everyone else races to guess it — then the round
recap (with the drawing) is auto-posted back into the chat with a **Play again**
button, so the game spreads inside the conversation.

**Three ways to play:**

| Mode | What happens |
|---|---|
| 🎨 **Classic** | One drawer, everyone guesses — first correct guess ends the round |
| 🧬 **Chain** | A draws → B guesses → C draws B's guess → … the chain mutates and is replayed as a slideshow |
| 📅 **Async** | Draw now, publish the challenge — friends guess whenever they next open the chat (survives restarts) |

**Visual direction:** everything sits on an aged-paper background with a real
grain overlay; the canvas is a sheet of sketch paper (faint dot grid, washi-tape
corners), the chrome is hand-drawn (wobbly borders, pencil-lettering accents),
and guesses arrive as chat bubbles.

## MVP scope covered (section 4 of the brief)

1. **Lobby** — players join from the group chat, avatars via `photo_url` with
   initials fallback, host picks the mode, taps **Start** (Telegram `MainButton`).
2. **Word draw** — random drawer, secret word, 75s countdown (configurable).
3. **Canvas** — HTML5 canvas with **8 paint tools**:
   pen · marker (translucent) · spray can · line · rectangle · circle · eraser
   (true alpha erase) · stamps (star/heart/smiley) — plus a 5-color palette,
   3 brush sizes, undo and clear.
4. **Guessing** — live stroke sync over WebSocket; text input + `MainButton`;
   first correct guess ends the round early.
5. **Scoring** — points = seconds remaining × 10, drawer gets a 25% bonus.
6. **Round recap** — reveal screen in-app; **Share recap to chat** calls
   `sendData()`, the bot fetches the recap + drawing thumbnail and posts it into
   the group.
7. **Timer UI** — green → amber → red with a pulse in the last 5 seconds.

## Beyond the MVP

- **🧬 Chain mode** — `draw → guess → re-draw` steps across the roster
  (4–8 steps). Whatever the guesser types becomes the next artist's word.
  Draw steps score 60 (30 on timeout), guess steps 40. If a guesser stalls, the
  chain breaks gracefully and whatever exists is replayed as a slideshow — every
  player can step through the slides locally; the host then ends the game.
- **📅 Async challenge** — one open challenge per chat: the starter draws alone,
  publishes, and everyone else (any time within the TTL) sees the drawing and
  can guess. Multiple solvers score a speed bonus (50–200). Challenges are
  persisted to `./data/*.json` and survive server restarts. Host/drawer closes
  it → recap.
- **🌟 Sticker export** — turn any drawing into a Telegram sticker: the client
  renders a 512×512 transparent PNG and the server uploads it via the
  Sticker Set API (`createNewStickerSet` / `addStickerToSet`, per-user pack
  `dc<userid>_by_<botusername>`). Needs `BOT_TOKEN` on the game server.
- **😂 Best-of recap card** — at game end the client composes a shareable card
  (final scores + funniest wrong guesses + drawing thumbnail), stores it on the
  recap, and the bot posts *that image* instead of the plain thumbnail.

## Architecture

```
public/          static mini app (index.html, style.css, app.js)
server.js        HTTP static host + WebSocket game layer + recap API
                 + sticker upload (Bot API) + async persistence (./data)
words.js         ~200-word draw list
bot.js           long-polling Bot API bot (no extra deps, Node 18+ fetch)
test/smoke.mjs   E2E: two clients play a full classic round
test/features.mjs  chain, async+persistence, tools, card, sticker endpoint
test/browser.mjs   headless-Chrome UI test (skips if Chrome missing)
```

- Game state lives **in memory**, keyed by Telegram chat id (rooms are dropped
  when the last player leaves).
- The server is authoritative for the word, timer and scores; clients only send
  guesses and stroke segments.
- Recap flow: mini app calls `sendData({action:'recap', recapId})` → bot receives
  `web_app_data` → bot fetches `GET /api/recaps/:id` (caption fields + drawing
  JPEG data-URL) → bot posts `sendPhoto` with an inline `web_app`
  **Play again** button whose URL carries `?chat=<chatId>` so the relaunched app
  rejoins the same room.

## Run locally

```bash
npm install
npm start          # http://localhost:8080
npm test           # smoke + feature tests (chain, async, tools, card, sticker)
npm run test:browser  # optional: headless-Chrome UI test (needs Chrome)
```

Open `http://localhost:8080/?chat=test123` in two browser tabs to try it
without Telegram (a fallback primary button replaces the Telegram MainButton,
and the `?chat=` param makes both tabs share a room).

## Hook it up to Telegram

1. **Bot:** talk to **@BotFather** → `/newbot` → copy the token.
2. **Mini app:** `/newapp` with the bot → give it a name → set the Web App URL
   to your public HTTPS URL (e.g. `https://your-domain.example`).
   Also set it as the **menu button** (`/setmenubutton`) so the chat-level entry
   point exists.
3. **HTTPS:** Telegram requires HTTPS. For a quick test, tunnel the local
   server, e.g. `ngrok http 8080` or `cloudflared tunnel --url http://localhost:8080`.
4. **Start the pieces:**

```bash
export BOT_TOKEN="123456:ABC..."        # from BotFather — used by BOTH bot and server
export APP_URL="https://your-domain.example"
export GAME_SERVER="http://localhost:8080"   # where the recap API lives
npm start &     # game server (serve this same origin publicly)
npm run bot     # recap poster
```

> The game server also reads `BOT_TOKEN` (for sticker export and `getMe`).
> If it's set, `/api/sticker` works; without it, sticker buttons return a
> friendly "needs BOT_TOKEN" error.

5. Add the bot to a **group** → open the app from the menu button or send
   `/start` → tap **Play Doodle Chain** → draw & guess.

### Environment variables

| Var | Used by | Default | Purpose |
|---|---|---|---|
| `PORT` | server | `8080` | HTTP + WebSocket port |
| `ROUNDS` | server | `3` | classic rounds per game |
| `ROUND_SECONDS` | server | `75` | classic countdown length |
| `CHAIN_STEP_SECONDS` | server | `45` | per-step countdown in chain mode |
| `ASYNC_TTL_HOURS` | server | `24` | how long an async challenge stays open |
| `DATA_DIR` | server | `data` | where async challenges are persisted |
| `DISCONNECT_GRACE_MS` | server | `20000` | reconnect grace before a dropped player is removed |
| `BOT_TOKEN` | bot + server | — | BotFather token (required for the bot; enables stickers on the server) |
| `APP_URL` | bot | — | public mini app URL (required) |
| `GAME_SERVER` | bot | `http://localhost:8080` | recap API base URL |

## WebSocket protocol (summary)

Client → server: `join`, `mode`, `start`, `next`, `playAgain`,
`draw{first,tool,color,size,stamp,pts,target?}`, `drawEnd`, `undo`, `clear`,
`guess`, `chainDone`, `chainGuess`,
`asyncStart`, `asyncPublish`, `asyncGuess`, `asyncClose`, `asyncDiscard`,
`thumb`, `card`.

Server → client: `state` (full snapshot incl. strokes, chain and async views),
`guess`, `feed` (chain play-by-play), `draw`, `undo`, `clear`,
`roundEnd` (word reveal + winner + `recapId`), `chainReplay`,
`gameOver` (leaderboard + `recapId` + wrong guesses),
`asyncEnd` (challenge recap + `recapId`), `error`.

Recap API: `GET /api/recaps/:id` → `{type: round|final|chain|async, thumb, card, …}`
(the bot picks `card` over `thumb` for final recaps).
Sticker API: `POST /api/sticker {userId, data: pngDataUrl}`.

Rooms are keyed by `chatId`, resolved as: `?chat=` param → Telegram
`start_param` → `dm:<user id>` fallback (solo testing).

## Security notes / production TODOs

- `Telegram.WebApp.initData` is **not yet verified** server-side. Anyone who can
  reach the URL can join a room. Before real traffic: validate the HMAC of
  `initData` with the bot token on `join`, and reject mismatches.
- Room ids are chat ids only — no global matchmaking by design.

## Roadmap (brief section 5, in order)

1. ✅ Chain mode — draw → guess → re-draw loop with slideshow replay.
2. ✅ Sticker export via the Sticker Set API.
3. ✅ Async play (draw now, others guess whenever they next open the chat).
4. ⬜ Per-chat persistent leaderboard (add SQLite, keep the room model).
5. ✅ "Best of" recap card (funniest wrong guesses + scores → shareable image).
