# Spindle → Bun rewrite

Working note. Target: **Bun 1.4.0**. Branch: `bun-rewrite-v14`.
Rewrite the backend onto Bun built-ins, drop pnpm for `bun install`. Frontend source is untouched.

Status: **Phase 0 research complete; §3 resolved. Awaiting approval before any code is written.**

---

## 1. Locked decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | **`bun build --target=bun --outdir dist`** → `CMD ["bun", "--no-env-file", "dist/index.js"]` on `oven/bun:1.4.0-alpine`. **Settled** after the §2b bake-off measured the two as equivalent; tie went to operability | `--compile` was measured, not assumed: 1.0 MB smaller image, 14 ms faster boot, 330 K less idle RSS, identical CPU. None of it perceptible; `bun`-in-image debuggability and a 0.4 MB CI artifact win. |
| 2 | **Tests first.** Capture the live Express API as fixtures, write `bun:test` suites, *then* rewrite until green | Zero tests exist and the frontend is untouched — a changed JSON key would only surface as broken UI. |
| 3 | **Unsupported cover art → skip + warn** (`art_path = ''`), sharp dropped | Now nearly unreachable: GIF/BMP *do* decode on Linux (§2). Only TIFF/HEIC/AVIF don't, and none appear in the library. |
| 4 | **Vite runs under Bun** (`bunx --bun vite build`) | Single runtime, no Node in the builder image. Still to be gated in Phase 0.5. |
| 5 | **`bun:sqlite` with `strict: true`** | Trap 4.1 — non-strict silently returns wrong results for the `@name` params this codebase already uses. |
| 6 | **API contract frozen** — same paths, status codes, JSON keys, headers | `frontend/src/api/client.ts` and its camel-casing `normalizeApiShape` stay untouched. |
| 7 | **Ranges handled manually** in `stream.ts`, not via Bun's automatic layer | §2 — the auto layer is undocumented in 1.4's types and cannot honour `If-Range`. Manual keeps exact parity. |
| 8 | **Art: `fit: "inside"`** for the 500 base, **width-only `resize(w)`** for `?w=` variants | §3. Bun.Image cannot crop; `inside` renders pixel-identical to today because the frontend's `object-fit: cover` performs the same center-crop. Zero new code. |

---

## 2. Phase 0 results — all verified on **bun 1.4.0** (34cbb9a40), glibc 2.44

Against the real library (`/hdd/ADM/Music`, 536 tracks) and the real DB (`_DATA/db/music.db`).

**bun:sqlite** — unchanged from 1.3.14.
- `db.run(schema.sql)` executes the whole multi-statement script → 11 tables.
- `.get()` no match → **`null`** (better-sqlite3 gave `undefined`; the `| undefined` casts must become `| null`).
- `run().lastInsertRowid` is a **`number`**; `changes` present.
- `PRAGMA user_version` via `db.query('PRAGMA user_version').get()` → `{user_version: n}`. Live DB = **1**.
- `db.transaction(fn)` works. `ON CONFLICT … DO UPDATE` binds fine with strict bare keys and `null` values.
- Real DB opens readonly, reports **536 tracks**.

**Bun.Glob** — `**/*` + JS extension filter → **536 files in 392 ms**, matching today's `glob` count.
`nocase` / `caseSensitive` / `ignore` are *silently accepted and ignored* — worse than throwing, so the
JS-side filter is not optional.

**music-metadata** — parses under Bun (`codec=Vorbis I`, duration, `native.vorbis` frames intact, so the
raw `WOAS`/`SYLT`/`USLT` readers keep working). **Bundles cleanly**: `bun build` inlines it (136 modules,
0.38 MB) and the bundle runs with `node_modules` renamed away. → runtime image needs no `node_modules`.

**Bun.Image** — you were right about the format matrix. On Linux:

| | result |
|---|---|
| decode JPEG / PNG / WebP | OK |
| decode **GIF** (first frame) / **BMP** | **OK** — 1.4 docs confirmed by probe |
| decode TIFF | `ERR_IMAGE_FORMAT_UNSUPPORTED` |
| encode jpeg / png / webp | OK |
| encode avif / heic | `ERR_IMAGE_FORMAT_UNSUPPORTED` |

Real 45925 B JPEG cover → `resize(500,500).webp({quality:85})` → 9500 B, round-trip metadata correct.
`autoOrient: true` is the **default** (sharp does not auto-orient unless asked) — a cover carrying EXIF
Orientation would now be rotated where it previously was not. None seen in this library; worth a glance
during Phase 6.

**`bun build --target=bun --outdir dist`** — `import x from './y.sql' with { type: 'text' }` is **inlined
into the bundle**; the built `index.js` runs from `/` with `src/` deleted. `--sourcemap` works. Explicit
`process.on('SIGTERM')` fires and exits cleanly → **no tini needed**.

**`{ dir }` static routes** (`routes: { '/art/*': { dir } }`) — serves 200 with `content-type`,
`last-modified`, weak `etag`, `accept-ranges`; **304** on `If-None-Match`; **206** on `Range`; path
traversal → 404; missing → 404. Type is `{ dir: string; statCache?: boolean }` — **no way to add
`Cache-Control`**, which today's `express.static` sets to 30 d immutable for `/art` and 7 d for the SPA.
Art filenames are content hashes, so losing `immutable` turns every cached image into a revalidation
round-trip. → `/art` keeps a custom handler (needed for `?w=` anyway) that sets `Cache-Control`; same for
the SPA's hashed assets.

**Automatic range handling** — reproduced the full matrix (200 / 206 / suffix / open-ended / 416 /
multi-range→200) on a handler-returned `BunFile`, custom headers preserved. But it is **undocumented** in
1.4's types (only `{dir}` routes mention `Range`), and it fires on *everything*: explicit `status: 200`,
a `ReadableStream` body, even `Accept-Ranges: none`. Probed suppressors:

| response | Range: 0-99 → |
|---|---|
| `BunFile` | 206 (auto) |
| `file.stream()` + Content-Length | 206 (auto) |
| `file.stream()` no Content-Length | 206 (auto) |
| `Accept-Ranges: none` | 206 (auto) |
| in-memory `Uint8Array` | **200** |
| **any response with `Content-Range` set** | **200 — auto layer suppressed** |
| manual `206` + `file.slice(100,200)` + `Content-Range` | **serves exactly our 100 bytes** |

→ Setting `Content-Range` ourselves is the opt-out, and full manual control works. Hence decision 7.

**SSE** — an `EventEmitter` bridged into a `ReadableStream` streams incrementally (measured ~80 ms apart);
`server.timeout(req, 0)` disables the idle timeout; **`req.signal` fires `abort` on client disconnect**
(confirmed) — the replacement for `req.on('close')` when unsubscribing from a sync job.

**Routing** — per-method objects, `:param` via `req.params`, `/api/*` wildcard, `error()` hook and `fetch`
fallback all behave. A matched route with no handler for the method → 404 (Express behaved the same).

**Digest parity — both confirmed, and this is the load-bearing one:**
- `node:crypto` sha256 === `Bun.CryptoHasher('sha256')` for all 40 covers sampled, and **40/40 hashes
  already exist as files in `_DATA/art`** → the existing art cache is reused, nothing re-encodes.
- `tracks.file_hash` recomputed via `Bun.file(p).slice(0, 65536).bytes()` → **60/60 match**, 0 differ.
  → the next sync after the rewrite skips all 536 tracks instead of re-extracting them.

**`.env`** — Bun reads `.env` from **cwd only, no upward search**. With cwd=`backend/` the root `.env` is
ignored, identical to today's `dotenv.config()`. So the root `.env` is *already* dead for the backend:
`DATA_ROOT=./.ignore/_DATA` never applies, and the live DB is found via the `backend/data → ../_DATA`
symlink through the `__dirname/../../data` fallback. Make this explicit in Phase 7.

---

## 2b. Bake-off: `bun index.js` vs `--compile` binary

Run **now**, ahead of Phase 8, on a stand-in server with the real backend's dependency footprint
(`bun:sqlite` + `music-metadata` + `Bun.Image` + `Bun.serve` routes + embedded SQL text imports), against
the **real DB** (536 tracks) and **real audio files**, both containers `--network host`, 5 runs each.
Instruments: cgroup v2 `cpu.stat usage_usec`, `memory.current`, `memory.peak`.

Validity check first — both variants returned identical real responses: `/api/tracks` → 500 tracks × 32
columns, `/api/stream/1` → `206` with exactly 262144 bytes, `/art/<hash>.webp` → `200`, 18582 B,
`image/webp`. The CPU numbers reflect genuine work, not error paths.

| metric (median of 5) | `bun dist/index.js` | `--compile` binary | winner |
|---|---|---|---|
| image size | 88.6 MB | **87.6 MB** | compile, by 1.0 MB (1.1%) |
| boot to first 200 | 105 ms | **91 ms** | compile, by ~14 ms (13%) |
| idle RSS | 8348 K | **8016 K** | compile, by ~330 K (4%) |
| peak RSS under load | 36816 K | **35228 K** | compile, ranges overlap |
| CPU for 600 requests | **4950 ms** | 4971 ms | tie — 0.4%, spreads overlap |

Spreads: boot 94–118 vs 86–101 · idle RSS 8200–8532 vs 7916–8408 · CPU 4856–5011 vs 4964–5259.

**Conclusion: equivalent.** Same runtime either way, so the runtime dominates every metric. `--compile` is
marginally ahead on three axes and none of the margins would be perceptible on a self-hosted music player;
CPU — the metric that actually matters while streaming — is a dead tie.

Base-image note: giving the bundle a "leaner" base *hurts* — `oven/bun:1.4.0-distroless` produced
**96.2 MB** vs alpine's 88.6 MB. Alpine is the right base for both. The musl `--compile` binary is
76.3 MB and needs only `libstdc++` + `libgcc` (no ICU, unlike a glibc host build), so
`alpine:3.22 + those two` is its minimal runtime.

So the tiebreak is qualitative:

| | `bun dist/index.js` | `--compile` binary |
|---|---|---|
| debugging in-container | `bun` present — REPL, one-off scripts, patch and restart | opaque single artifact |
| sourcemaps | `--sourcemap` beside the bundle, just works | needs care |
| CI artifact | 0.4 MB | 76 MB per arch |
| runtime image needs `bun` | yes | no (could go leaner than alpine) |
| accidental drift | source could be edited in-image | immune |

**Decided: `bun dist/index.js`** (approved). Performance was a wash, so the tie went to operability. The
`--compile` path stays documented here in case the trade ever changes — nothing in the codebase precludes
it, since the embedded-SQL approach (trap 4.4) is what both modes require.

---

## 3. RESOLVED — album art geometry

Bun.Image **cannot crop**. Verified exhaustively against `bun.d.ts`: the entire surface is
`resize / rotate / flip / flop / modulate` + encoders + terminals — no `crop`, `extract`, `extend`,
`composite`, no blank-canvas constructor, no raw-pixel output, and `resize` has no `background` option.
A non-square image can only be squared by cropping, stretching, padding, or not at all; Bun.Image can
express only the last two.

**Decision: `fit: "inside"`.** Today sharp baked a center-crop into the cached file, and the browser then
applied `object-fit: cover` to the already-square result (a no-op). Under `inside` the crop simply moves
to the browser — the same center-crop, the same visible pixels, one fewer place doing it. Every art box is
a fixed square in CSS (`.album-art-sm {40px}`, `-md {80px}`, `-lg/-xl {aspect-ratio: 1/1}`) so there is no
layout shift, and 523 of 536 covers are square anyway.

**`?w=` is a width contract:** it sets the width, whatever the height. So the base uses
`resize(500, 500, { fit: 'inside' })` (bounds *both* axes at 500, which matters for portrait sources) and
variants use width-only `resize(w)` off the cached base, exactly as today's `art.ts` derives them.

Measured on real covers — width is exact in all nine variants:

| source | base (`inside` 500) | `?w=64` | `?w=128` | `?w=256` |
|---|---|---|---|---|
| 640×640 square | **500×500** | 64×64 | 128×128 | 256×256 |
| 640×579 landscape | 500×453 | 64×57 | 128×115 | 256×231 |
| 626×640 portrait | 489×500 | 64×65 | 128×130 | 256×261 |

No `withoutEnlargement`: today's sharp call upscales small covers to 500, so the default preserves parity.

Minor, not worth fixing: `AlbumArt.tsx` declares the base as `500w` in its `srcset`, which is 489 for a
portrait cover — a negligible error in candidate selection. The `width`/`height` attributes are likewise
nominal, and the fixed CSS boxes mean they cannot shift layout.

Rejected alternatives: `fill` (stretches 13 covers, one visibly by 10.5% — the only option that changes
what you see); padding to a transparent square (impossible without compositing, and it would show bars
where today silently crops); a hand-rolled PNG-decode → crop → BMP → Bun.Image pipeline (~120 lines of
dependency-free codec for 13 files — the only route to byte-level parity, deliberately not taken).

## 4. Traps found while reading the code

**4.1 — `bun:sqlite` non-strict mode silently returns nothing.** Re-verified on 1.4: with default
`strict: false`, binding `{ n: 'X' }` to `… WHERE name = @n` returns **`null`** — no error, no match. Only
`{ '@n': 'X' }` works. Every statement in `sync.ts`, `lyrics.ts` and `settings.ts` binds plain objects to
`@name` placeholders, so without `strict: true` the sync pipeline writes NULLs and no test necessarily
catches it.

**4.2 — `.get()` returns `null`, not `undefined`.** The `as {…} | undefined` casts must become `| null`.
`if (!row)` guards and `row?.value ?? null` are unaffected — it is the *types* that lie, not the logic.

**4.3 — the `prepared()` WeakMap cache in `db/init.ts` is obsolete.** `db.query()` caches compiled
statements itself, but only ~20; the sync hot path uses ~12 distinct statements. Close enough to the cap
that hot statements get bound once at module scope rather than trusting the LRU.

**4.4 — migrations cannot be `readdirSync`'d.** The runtime image ships only `dist/index.js`, so
`db/migrations/index.ts` exports an ordered `MIGRATIONS` array built from
`import … with { type: 'text' }`. Verified inlined by `bun build` and working with `src/` deleted.

**4.5 — `Bun.Glob` has no working `nocase` or `ignore`.** Options are accepted and ignored. Scan `**/*`,
then filter in JS: lowercase extension against `EXTENSIONS`, skip `node_modules` / `.DS_Store`. Verified
same 536 files. (`followSymlinks: false` is the default and matches today's `follow: false`.)

**4.6 — `If-Range` cannot be honoured by Bun's automatic ranging.** Today's `stream.ts` sends the full
body when a client's `If-Range` validator is stale, so ranges are never spliced onto a mismatched cached
copy — a real corruption path for resumed media. The auto layer keys only off `Range`. Resolved by
decision 7: parse ranges ourselves and always set `Content-Range`, which also suppresses the auto layer.

**4.7 — hash parity is load-bearing.** Confirmed green (§2). Phase 1 keeps it as a test so a later
refactor cannot silently trigger a full re-extract of 536 tracks and a re-encode of every cover.

**4.8 — the chunked-persist + event-loop yield design must survive.** `bun:sqlite` is synchronous like
better-sqlite3, so `PERSIST_CHUNK_SIZE = 200` transactions with `setImmediate` yields between them are
still what keeps a large sync from stuttering in-flight audio. Keep it; measure with `--cpu-prof-md`.

**4.9 — Express's `app.use('/api/tracks', router)` matched `/api/tracks` *and* `/api/tracks/`.** Bun's
route table needs trailing-slash variants registered explicitly or they 404.

**4.10 — `Bun.Image` auto-orients by default, sharp did not.** See §2. Watch for it in Phase 6.

**4.12 — `bun:sqlite`'s `run()` rejects a comment-only script; better-sqlite3's `exec()` treated it as a
no-op.** `001_initial.sql` is exactly that — a documentation-only baseline that exists to establish
`user_version = 1` — so the first `initDb()` threw `Query contained no valid SQL statement`. The runner now
skips execution when a migration has nothing left after comments are stripped, while still bumping
`user_version`. The check is deliberately biased towards "has statements": a false positive merely lets
`run()` raise on a genuinely empty script, whereas a false negative would skip a real migration *and*
record it as applied. Caught by the Phase 2 smoke test, guarded by `test/db.test.ts`.

**4.11 — `Bun.Image.metadata()` reports the *source* dimensions, ignoring queued transforms.** A pipeline
that will output 64px wide still reports the input's 500. Output dimensions require decoding the encoded
result. Cost me a wrong reading during Phase 0; nothing in the final design needs output dims at runtime,
but any future code that does must re-decode.

---

## 5. Dependency fate

**Runtime — 8 → 1**

| dep | replacement |
|---|---|
| `better-sqlite3` | `bun:sqlite` (`strict: true`) |
| `sharp` | `Bun.Image` |
| `dotenv` | Bun auto-loads `.env` |
| `glob` | `Bun.Glob` + JS extension filter |
| `express` | `Bun.serve({ routes })` |
| `cors` | `http/cors.ts` (our code) |
| `morgan` | `http/log.ts` (our code) |
| `music-metadata` | **kept** — no built-in equivalent; bundles cleanly |

**Dev — 7 → 2.** Drop `tsx` (`bun --watch` replaces it), `@types/better-sqlite3`, `@types/cors`,
`@types/express`, `@types/morgan`. Swap `@types/node` → `@types/bun`. **Keep `typescript`** — Bun does not
typecheck, so `tsc --noEmit` stays.

Also deleted: `pnpm-lock.yaml`, `pnpm-workspace.yaml` (→ `workspaces` in root `package.json`), `.nvmrc`,
`packageManager`. `bun.lock` is committed.

---

## 6. Bun 1.4 features adopted beyond the original scope

- **`{ dir }` static routes** for the SPA tree — replaces most of `express.static`. `/art` and hashed
  assets keep a thin custom handler purely to set `Cache-Control` (§2).
- **`--cpu-prof-md` / `--heap-prof-md`** — turns trap 4.8 from a comment into a measurement: profile a
  full sync while streaming a track.
- **Native streams with real backpressure** — what today's hand-rolled `pipeline()` wrapper approximates,
  so that wrapper goes away.
- **`bun test --isolate --parallel`** (+ `--changed`, `--shard`, `--timings`) — `--isolate` gives each file
  a fresh global and closes servers between files, which the contract suite needs.
- **`bun run --parallel`** — direct replacement for `pnpm -r --parallel run dev`.
- **`--no-env-file`** in the container: config comes from `ENV`, so refuse to read a stray `.env`.
- **Smaller/faster runtime** — Linux startup ~2× faster, large HTTP-server memory reductions.

**Noted, not adopted:** `bun build --compile` (superseded by decision 1), `bun build --asset` (text
imports already inline), HTTP/3 (experimental), `Bun.cron()` (a scheduled auto-resync is a real feature
idea, out of scope for a port), `node:sqlite`, `bun pm licenses` / `audit` / `dedupe` / `prune`.

---

## 7. Target layout

```
backend/
  package.json          # deps: music-metadata. dev: @types/bun, typescript
  tsconfig.json         # types: ["bun"]
  src/
    index.ts            # Bun.serve({ routes }) — whole HTTP surface
    env.ts              # DATA_ROOT / PORT / FRONTEND_URL, explicit (no dotenv)
    http/
      wrap.ts           # decorator over the route table: CORS + log + error + JSON body
      cors.ts           # replaces `cors`
      log.ts            # replaces morgan('dev')
      respond.ts        # json() / error() / notFound()
    db/
      init.ts           # bun:sqlite, strict:true, WAL, migration runner
      schema.sql
      migrations/
        001_initial.sql
        index.ts        # text imports -> ordered MIGRATIONS array  (trap 4.4)
    routes/             # tracks albums artists playlists settings stats stream sync art
    services/           # metadata scanner sync stats lyrics
    types.ts
  test/
    spec.ts             # the contract as 106 replayable steps (shared)
    capture.ts          # replay a server -> fixture
    compare.ts          # diff two fixtures
    verify.ts           # capture + diff a live server, non-zero exit on drift
    fixtures/
      express-baseline.json    # the oracle, captured from the live Express app
    sqlite.test.ts      # strict binding, txns, null-vs-undefined, user_version  ✅
    hash.test.ts        # digest parity vs the real library                      ✅
    contract.test.ts    # boots the Bun server, replays spec, diffs (Phase 3+)
    sync.test.ts        # add / update / move / delete / touch decisions (Phase 6)
```

`middleware/` folds into `http/`. Route→file mapping stays 1:1 with today's `routes/` so each file is
reviewable against its Express original.

---

## 8. Phases

- [x] **0 — Research.** Every API re-verified on 1.4; results in §2. Open question in §3.
- [ ] **0.5 — Workspace swap.** Root `package.json` → `workspaces: ["backend","frontend"]`; delete pnpm
      files + `.nvmrc`; `bun install`; commit `bun.lock`. Gate decision 4 (`bunx --bun vite build` vs the
      current Vite output). Gate the Dockerfile bases by building in `oven/bun:1.4.0-alpine`.
- [x] **1 — Contract capture (tests first).** Done except `contract.test.ts`, which needs the new server.
      - `test/spec.ts` — the API contract as **106 replayable steps**, shared by both directions.
      - `test/capture.ts` — replays the spec, records status + contract headers + normalised JSON;
        images record decoded *dimensions* (sharp and Bun.Image will never emit identical bytes), audio
        records a digest (those are file bytes and must match exactly).
      - `test/compare.ts` + `test/verify.ts` — diff a live server against the baseline; non-zero exit on
        any difference, so it doubles as a CI gate.
      - `test/fixtures/express-baseline.json` — captured from the live Express app, production-shaped.
      - **Harness proven deterministic**: capturing Express twice from a pristine DB diffs to zero across
        all 106 steps, so any later difference is a real regression.
      - `test/sqlite.test.ts` — 12 tests pinning the bun:sqlite assumptions (trap 4.1 has an explicit
        regression guard). **12 pass.**
      - `test/hash.test.ts` — digest parity against the real library: **536/536** `file_hash` values and
        **40/40** art-cache filenames reproduce exactly, and Bun's hasher agrees with node's including on
        sub-64 KiB files. **4 pass.**
- [x] **2 — DB layer.** `src/env.ts` (explicit config; `DATA_ROOT` now anchors on the working directory
      rather than on the module path, because the bundle lives in `dist/` while the source lives in `src/`
      — same effective result as today in both dev and container). `src/db/init.ts` on `bun:sqlite` with
      `strict: true`, WAL, FK, and the embedded-`MIGRATIONS` runner (trap 4.12).
      `src/db/migrations/index.ts` replaces `readdirSync`. `prepared()` kept as a thin wrapper over
      `db.query()` so hot loops can hold statements at module scope (trap 4.3).
      **`test/db.test.ts` — 7 tests.** Verified on a fresh database (11 tables, `user_version` 1, WAL, FK,
      3 seeded smart playlists, idempotent re-init) and on a copy of the real one (536 tracks preserved,
      `user_version` stays 1, no duplicate seeding). Full suite: **23 pass across 3 files**.
- [ ] **3 — HTTP core.** `Bun.serve` skeleton, `http/wrap.ts` composing CORS + logging + errors + body
      parsing, `maxRequestBodySize: 1 MiB` (was `express.json({limit:'1mb'})`), `{ dir }` for the SPA plus
      the `Cache-Control` handler, SPA fallback that still 404s JSON under `/api/*` and `/art/*`,
      trailing-slash variants (4.9).
- [ ] **4 — Read routes.** tracks, albums, artists, playlists, settings, stats. `contract.test.ts` is the oracle.
- [ ] **5 — Binary routes.** `stream.ts`: keep ETag/304, MIME, 404/410; manual ranges per decision 7; drop
      `createReadStream` and the `pipeline()` wrapper. `art.ts`: `Bun.Image` for the 64/128/256 variants,
      keep the width whitelist, filename regex, in-flight dedupe map and temp-write+rename.
- [ ] **6 — Sync pipeline.** `scanner.ts` (4.5), `metadata.ts` (`Bun.Image` per §3 + 4.10/4.11),
      `services/sync.ts` (logic unchanged; 4.3/4.8), `routes/sync.ts` SSE bridging the `EventEmitter` with
      `req.signal` unsubscribe and `server.timeout(req,0)`. Then a real sync against `/hdd/ADM/Music`:
      expect **536 skipped, 0 added, 0 updated**.
- [ ] **7 — Deps & tooling.** Strip the 12 dropped deps. `dev: bun --watch src/index.ts`,
      `build: bun build src/index.ts --target=bun --outdir dist --sourcemap`, `typecheck: tsc --noEmit`,
      root `dev: bun run --parallel --filter '*' dev`. Make `DATA_ROOT` explicit (§2). `tsc --noEmit` clean.
- [ ] **8 — Docker + CI.** Builder `oven/bun:1.4.0-alpine`: `bun install --frozen-lockfile`, build the
      backend, `bunx --bun vite build` the SPA. Runtime `oven/bun:1.4.0-alpine` carrying only `dist/` +
      `frontend/dist` — no python3/make/g++, no `SHARP_IGNORE_GLOBAL_LIBVIPS`, no `pnpm deploy --prod`, no
      tini, no `node_modules`. `CMD ["bun", "--no-env-file", "dist/index.js"]`. Re-measure §2b against the
      finished backend to confirm the decision still holds. CI: replace the `node -p` version check with `jq`.
- [ ] **9 — Verification.** `bun test`; run the app and click every page; play + seek + skip; force-sync;
      profile a sync while streaming; `docker compose up` and repeat against the image.

---

## 9. Out of scope

Frontend source, the SQLite schema (no migration added — the live DB stays at `user_version = 1`), the API
contract, and any new product feature.
