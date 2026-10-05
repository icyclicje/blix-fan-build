# Game Player

Plays **one** HTML5 game full-screen with nothing else on the page. Put the game in `game/` and run it. There are no dependencies to install.

## 1. Add your game

Put **one** of these in the `game/` folder:

- **The game's files**: its `index.html` (or any `.html` page) plus all of its assets, or
- **One `.zip`** of the game. It's unzipped automatically, and a single wrapping folder inside the zip is fine.

Most HTML5 exports work: Unity WebGL, Godot, GameMaker, Construct, Phaser, Scratch/TurboWarp, RPG Maker MV/MZ, plain JS games.

## 2. Run it locally

```
npm start
```

Open <http://localhost:8080>. You need Node 18 or newer.

## 3. Deploy on Railway

Using GitHub:

1. Push this folder to a GitHub repo, game included.
2. In Railway, click **New Project → Deploy from GitHub repo** and pick the repo.
3. Go to **Settings → Networking → Generate Domain**.

Or, using the CLI:

```
npm i -g @railway/cli
railway login
railway init
railway up
```

Railway reads `railway.json` and builds the `Dockerfile`. The game is unzipped and compressed at **max quality during the build**, so the container starts in milliseconds. To update the game, replace what's in `game/` and push (or run `railway up`) again.

**Big games:** GitHub rejects files over 100 MB. Either deploy with `railway up`, or host the zip somewhere (a GitHub Release, S3, R2, …) and set the variable `GAME_URL` to its direct download link. The server then downloads it at startup.

**Save money:** set `"sleepApplication": true` in `railway.json`. Railway then sleeps the service when nobody's playing, and the first visit after that takes a few seconds to wake it.

## Options (environment variables)

| Variable        | Default        | What it does |
|-----------------|----------------|--------------|
| `PORT`          | `8080`         | Port to listen on. Railway sets this for you. |
| `GAME_PATH`     | `game`         | A folder, a `.zip`, or a single `.html` file. |
| `GAME_URL`      | —              | Download a `.zip` at startup instead of using `GAME_PATH`. |
| `ENTRY`         | auto           | Page to open, relative to the game, e.g. `MyGame/play.html`. By default the player uses the shallowest `index.html`, or the shallowest `.html` if there's no index. |
| `TITLE`         | auto           | Browser tab title. By default it's taken from the game's `<title>`. |
| `ISOLATE`       | `auto`         | `on`/`off`: sends the COOP/COEP headers that threaded games need (`SharedArrayBuffer`). `auto` turns this on for Godot (`.pck`) and threaded Emscripten (`.worker.js`) builds. |
| `CACHE_SECONDS` | `0`            | How long browsers may reuse non-hashed assets without asking the server. `0` means they check every time and get a cheap 304 if nothing changed, so players never mix old and new files after an update. |
| `CACHE_DIR`     | `.cache`       | Where the unzipped and compressed copies are stored. |

## What makes it efficient

- **One small file and no dependencies.** Nothing to install, and it starts in milliseconds.
- **Brotli/gzip.** Each file is compressed once and the result is cached on disk. That includes `.wasm`, `.data` and `.pck` files, which usually shrink 3–4×. Unity's pre-compressed `.br`/`.gz` builds are served as they are, with the correct headers.
- **Correct caching.** Each file gets an ETag based on its content, so repeat visits get 304s. Content-hashed file names (`main.3f9a2b1c.js`, Unity "Name Files As Hashes") are cached for a year.
- **Range requests** for audio and video, which Safari requires.
- **Forgiving paths.** File-name case mismatches (common in games made on Windows) still load. Absolute paths like `/Build/game.js` work because the game folder becomes the site root.
- **Safe.** Only files from the game are served: no dotfiles, no path traversal, GET/HEAD only.

## Files

```
game/          your game goes here
player.html    the full-screen player page (edit it if you want; {{TITLE}}, {{ICON}}, {{ENTRY}} are filled in)
server.js      the server
Dockerfile     image used by Railway
railway.json   Railway build/deploy settings (health check: /__player/health)
```

## Troubleshooting

- **Black screen or missing files:** the server logs `404 /path` for every file the game asked for but doesn't exist. Check those names against what's in `game/`.
- **Godot 4 says "SharedArrayBuffer / cross-origin isolation required":** set `ISOLATE=on`.
- **Wrong page opens:** set `ENTRY` to the right `.html` file.
