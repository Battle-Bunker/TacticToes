#!/usr/bin/env node
// Seed the LOCAL emulator suite with centaur identities + credentials and one
// game, then start it. Emulator-only: refuses to run against anything but a
// demo- project, and always pins FIRESTORE_EMULATOR_HOST.
//
// Usage: node seed.mjs [flags]
//   --first-turn-time N   seconds for turn 0            (env FIRST_TURN_TIME, default 15)
//   --max-turn-time N     seconds per later turn        (env MAX_TURN_TIME,   default 6)
//   --max-turns N         turn cap                      (env MAX_TURNS,       default 40)
//   --snakes-per-team N   snakes each team fields       (env SNAKES_PER_TEAM, default 5)
//   --centaurs SPEC       comma list of id[:name[:key[:color]]]
//                         (env E2E_CENTAURS, default "chris,dave";
//                          key defaults to ttc_local-key-<id>)
//   --session ID          session doc id                (default e2e-<epoch-ms>)
//   --start-delay-ms N    gap between settings write and startRequested
//                         (env START_DELAY_MS, default 4000 — lets running
//                          centaurs pick up the pending invite first)
//   --engine-only         after start, stage one legal turn-0 move per snake
//                         (env ENGINE_ONLY=1). See README: without this, the
//                         spawn-stacked snakes' default move is their own
//                         square, so every snake self-collides at the first
//                         expiry and the game ends after one resolution.
//
// Keep maxTurnTime >= ~3s: the expiry task chain needs headroom to re-enqueue.
import { createRequire } from "module"
import path from "path"
import { fileURLToPath } from "url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const require = createRequire(path.join(ROOT, "functions", "package.json"))

const PROJECT = process.env.PROJECT_ID || "demo-teamsnek"
if (!PROJECT.startsWith("demo-")) {
  console.error(`refusing to seed: PROJECT_ID must start with "demo-" (got "${PROJECT}")`)
  process.exit(1)
}
// Pin the admin SDK to the local emulator before it is loaded.
if (!process.env.FIRESTORE_EMULATOR_HOST) process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080"
if (!process.env.GCLOUD_PROJECT) process.env.GCLOUD_PROJECT = PROJECT

const admin = require("firebase-admin")
const crypto = require("crypto")
const { Timestamp } = require("firebase-admin/firestore")

admin.initializeApp({ projectId: PROJECT })
const db = admin.firestore()

// --- tiny arg parsing: --flag value / --flag, with env fallbacks ---
const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : true) : undefined
}
const num = (name, env, dflt) => {
  const v = flag(name)
  return parseInt(typeof v === "string" ? v : process.env[env] ?? `${dflt}`, 10)
}

const firstTurnTime = num("first-turn-time", "FIRST_TURN_TIME", 15)
const maxTurnTime = num("max-turn-time", "MAX_TURN_TIME", 6)
const maxTurns = num("max-turns", "MAX_TURNS", 40)
const snakesPerTeam = num("snakes-per-team", "SNAKES_PER_TEAM", 5)
const startDelayMs = num("start-delay-ms", "START_DELAY_MS", 4000)
const engineOnly = flag("engine-only") !== undefined || process.env.ENGINE_ONLY === "1"
const sessionID = (typeof flag("session") === "string" ? flag("session") : null) || `e2e-${Date.now()}`

const PALETTE = ["#ff5555", "#5555ff", "#55aa55", "#ddaa33", "#aa55dd", "#33bbbb"]
const spec = (typeof flag("centaurs") === "string" ? flag("centaurs") : null) || process.env.E2E_CENTAURS || "chris,dave"
const CENTAURS = spec.split(",").map((entry, i) => {
  const [id, name, key, color] = entry.trim().split(":")
  return {
    id,
    name: name || id.charAt(0).toUpperCase() + id.slice(1),
    key: key || `ttc_local-key-${id}`,
    color: color || PALETTE[i % PALETTE.length],
  }
})
if (CENTAURS.length < 2) {
  console.error("need at least 2 centaurs (one per team)")
  process.exit(1)
}

const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex")
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// --- 1. centaur identities + API-key credentials (admin bypasses rules) ---
for (const c of CENTAURS) {
  await db.doc(`centaurs/${c.id}`).set({
    id: c.id, name: c.name, owner: "e2e-owner-uid", public: true, createdAt: Timestamp.now(),
  })
  await db.doc(`centaurCredentials/${c.id}`).set({
    centaurId: c.id, owner: "e2e-owner-uid", keyHash: sha256(c.key),
    createdAt: Timestamp.now(), rotatedAt: Timestamp.now(),
  })
}
console.log(`centaurs seeded: ${CENTAURS.map((c) => `${c.id} (key ${c.key})`).join(", ")}`)

// --- 2. session -> onSessionCreated creates the setup doc ---
const sessRef = db.collection("sessions").doc(sessionID)
await sessRef.set({ latestGameID: null, timeCreated: Timestamp.now(), owner: null })
let gameID = null
for (let i = 0; i < 50 && !gameID; i++) {
  await sleep(400)
  gameID = (await sessRef.get()).data()?.latestGameID
}
if (!gameID) throw new Error("onSessionCreated never set latestGameID — is the functions emulator up?")

// --- 3. lobby settings, THEN startRequested as a separate write ---
// Two-step on purpose: onGameStarted only fires on update events, and the
// settings write must land (and sync invites) before the start flag flips.
const setupRef = sessRef.collection("setups").doc(gameID)
await setupRef.update({
  teams: CENTAURS.map((c) => ({ id: c.id, name: c.name, color: c.color })),
  snakesPerTeam, maxTurnTime, firstTurnTime, maxTurns,
})
console.log(`SEEDED session=${sessionID} game=${gameID} (start not yet requested)`)
await sleep(startDelayMs)
await setupRef.update({ startRequested: true })

// --- 4. wait for the game doc so callers can rely on it existing ---
const gameRef = sessRef.collection("games").doc(gameID)
let game = null
for (let i = 0; i < 50 && !game; i++) {
  await sleep(400)
  const snap = await gameRef.get()
  if (snap.exists) game = snap.data()
}
if (!game) throw new Error("onGameStarted never created the game doc")
console.log(`STARTED session=${sessionID} game=${gameID} alive=${game.turns[0].alivePlayers.length}`)

// --- 5. engine-only: nudge every snake off its spawn for turn 0 ---
// Snakes spawn stacked ([p,p,p]); with no staged move the engine derives a
// {dx:0,dy:0} "direction" and the snake steps onto itself, wiping the whole
// board at the first expiry. One legal staged move for turn 0 gives every
// snake a real direction; turns 1+ then resolve purely on engine defaults
// (march straight until wall/collision) — which is what this mode exercises.
// Writes go to privateMoves only; moveStatuses is left alone so resolution
// happens on the expiry cadence, not the all-players-moved fast path.
if (engineOnly) {
  const { boardWidth, boardHeight } = game.setup
  const turn0 = game.turns[0]
  const walls = new Set(game.walls)
  const occupied = new Set(Object.values(turn0.playerPieces).flat())
  let nudged = 0
  for (const pid of turn0.alivePlayers) {
    const head = turn0.playerPieces[pid][0]
    const x = head % boardWidth
    const y = Math.floor(head / boardWidth)
    const candidates = [
      { dx: 0, dy: -1, run: y - 1 },
      { dx: 0, dy: 1, run: boardHeight - 2 - y },
      { dx: -1, dy: 0, run: x - 1 },
      { dx: 1, dy: 0, run: boardWidth - 2 - x },
    ]
      .map((d) => ({ ...d, target: (y + d.dy) * boardWidth + (x + d.dx) }))
      .filter((d) => d.run > 0 && !walls.has(d.target) && !occupied.has(d.target))
      .sort((a, b) => b.run - a.run) // longest straight run before the wall
    if (!candidates.length) continue
    await gameRef.collection("privateMoves").add({
      gameID, moveNumber: 0, playerID: pid, move: candidates[0].target, timestamp: Timestamp.now(),
    })
    nudged++
  }
  console.log(`NUDGED ${nudged}/${turn0.alivePlayers.length} snakes for turn 0 (engine defaults take over from turn 1)`)
}

process.exit(0)
