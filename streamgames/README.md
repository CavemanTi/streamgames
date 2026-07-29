# StreamGames

Interactive chat games for Kick streamers. Each game is a single page you point OBS at — it connects to your chat directly, keeps its own scores, and never checks in with a server.

**No account. No licence key. No backend.**

---

## Why it's built this way

Most stream widgets phone home to validate a licence. When that server goes away, so does the widget — including for people who paid for it. That's not hypothetical; it's why the tool this replaces no longer works.

So there's nothing to phone home to. The overlay runs in OBS on your machine, talks to Kick's chat socket directly, and stores everything locally. Nothing here can be switched off remotely, and the source is public, so anyone can host their own copy.

---

## Games

### Plinko

Chat drops balls down a pin board into scoring slots.

| Command | What it does |
|---|---|
| `!drop` | Drop one ball |
| `!drop 3` | Drop up to 5 at once |
| `!color red` | Set your ball colour permanently |
| `!balls` | Check your credits |

Mods also get `!plinko freeplay on/off`, `!plinko give <user> <n>`, `!plinko reset` and `!plinko clear`.

Features: daily and all-time leaderboards, ball credits from watchtime and subs, per-user cooldowns, penalty slots, a hard cap on balls in flight with overflow queued so raids can't tank your framerate.

The physics is calibrated against a true binomial distribution — landing odds match a real pin board rather than feeling random.

---

## Setup

1. **Browser source** in OBS → `https://<you>.github.io/streamgames/plinko/?obs=1` at 1920×1080
2. **View → Docks → Custom Browser Docks** → `https://<you>.github.io/streamgames/plinko/panel.html`
3. Enter your **chatroom ID** in the dock. Find it on your channel page: devtools → Network → WS → look for `chatrooms.NNNNN.v2`
4. Type `!drop` in your own chat

---

## Structure

```
index.html        landing page, generates the OBS URLs
shared/kit.js     settings, storage, cross-context bridge, economy
plinko/
  index.html      the overlay (browser source)
  panel.html      the control dock
probe/index.html  diagnostic — checks the dock and source can talk
```

The shared kit is game-agnostic. A new game needs its own renderer and command parser; leaderboards, credits, settings and chat plumbing come for free.

---

## Notes

- Chat comes from the WebSocket the Kick site itself uses. It's undocumented and could change; if chat stops arriving, that's the first place to look.
- State lives in browser storage inside OBS. Clearing OBS's cache clears leaderboards.
- The overlay and dock must be served from the **same origin** to see each other. Opening them as local files won't work.

---

## Self-hosting

Fork it, enable Pages under Settings → Pages → deploy from `main` → root. That's the whole process. You are not dependent on this repo staying up.
