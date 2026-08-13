#!/usr/bin/env node
// Watch a game on the LOCAL emulator and assert that turns keep resolving.
// Prints one line per resolved turn (alive count, applied-move count, doc
// size) and exits:
//   0  enough turns resolved (or the game finished after enough turns)
//   1  no game found
//   2  game finished before --min-turns resolutions
//   3  stalled (no new turn within --stall seconds) or overall timeout
//
// Usage: node watch.mjs [flags]
//   --session ID     watch sessions/<ID> (else newest matching --prefix)
//   --game ID        watch a specific game (requires --session)
//   --prefix P       session id prefix to scan for (default "e2e-")
//   --turns N        stop successfully after N resolved turns (default 5)
//   --min-turns N    minimum resolutions for a finished game to count as
//                    success (default 3)
//   --timeout S      overall deadline in seconds (default 180)
//   --stall S        max seconds between resolutions before failing (default 45)
//   --expect-alive N assert turn 0 fields exactly N snakes
import { createRequire } from "module"
import path from "path"
import { fileURLToPath } from "url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const require = createRequire(path.join(ROOT, "functions", "package.json"))

const PROJECT = process.env.PROJECT_ID || "demo-teamsnek"
if (!PROJECT.startsWith("demo-")) {
  console.error(`refusing to watch: PROJECT_ID must start with "demo-" (got "${PROJECT}")`)
  process.exit(1)
}
if (!process.env.FIRESTORE_EMULATOR_HOST) process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080"
if (!process.env.GCLOUD_PROJECT) process.env.GCLOUD_PROJECT = PROJECT

const admin = require("firebase-admin")
admin.initializeApp({ projectId: PROJECT })
const db = admin.firestore()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : true) : undefined
}
const num = (name, dflt) => parseInt(typeof flag(name) === "string" ? flag(name) : `${dflt}`, 10)

const wantTurns = num("turns", 5)
const minTurns = num("min-turns", 3)
const timeoutS = num("timeout", 180)
const stallS = num("stall", 45)
const expectAlive = flag("expect-alive") !== undefined ? num("expect-alive", -1) : null
const prefix = typeof flag("prefix") === "string" ? flag("prefix") : "e2e-"
const sessionArg = typeof flag("session") === "string" ? flag("session") : null
const gameArg = typeof flag("game") === "string" ? flag("game") : null

const deadline = Date.now() + timeoutS * 1000

// --- locate the game doc ---
let ref = null
if (sessionArg && gameArg) {
  ref = db.doc(`sessions/${sessionArg}/games/${gameArg}`)
} else {
  // Session games live at sessions/{id}/games/{gameID}. The path filter must
  // be startsWith("sessions/") — Firestore paths have no leading slash — and
  // it must exclude centaurs/{id}/games/{gameID}, which are invite docs that
  // this collectionGroup query also returns.
  const pathPrefix = sessionArg ? `sessions/${sessionArg}/` : `sessions/${prefix}`
  while (!ref && Date.now() < deadline) {
    const games = await db.collectionGroup("games").get()
    const docs = games.docs
      .filter((d) => d.ref.path.startsWith(pathPrefix))
      .sort((a, b) => (a.data().timeCreated?.toMillis?.() ?? 0) - (b.data().timeCreated?.toMillis?.() ?? 0))
    if (docs.length) ref = docs[docs.length - 1].ref
    else await sleep(500)
  }
}
if (!ref) {
  console.log(`NO GAME FOUND under sessions/${sessionArg ?? prefix}*`)
  process.exit(1)
}
console.log(`watching ${ref.path} (want ${wantTurns} resolved turns, min ${minTurns} on finish)`)

// --- poll: report every appended turn, fail on stall/timeout ---
let seen = 0 // turns.length last observed
let lastGrowth = Date.now()
while (Date.now() < deadline) {
  const snap = await ref.get()
  const d = snap.data()
  if (!d) {
    console.log("game doc disappeared")
    process.exit(1)
  }
  const docBytes = JSON.stringify(d).length
  const n = d.turns.length
  if (n > seen) {
    for (let i = seen; i < n; i++) {
      const t = d.turns[i]
      const applied = Object.keys(t.moves || {}).length
      console.log(
        `turn ${i}: alive=${t.alivePlayers.length} movesApplied=${applied} winners=${t.winners.length} docBytes=${docBytes}`,
      )
      if (i === 0 && expectAlive !== null && t.alivePlayers.length !== expectAlive) {
        console.log(`FAIL: expected ${expectAlive} snakes alive at turn 0, saw ${t.alivePlayers.length}`)
        process.exit(2)
      }
    }
    seen = n
    lastGrowth = Date.now()
  }
  const resolved = seen - 1 // turn 0 is created at start; each resolution appends one
  if (d.timeFinished) {
    if (resolved >= minTurns) {
      console.log(`GAME FINISHED after ${resolved} resolved turns — SUCCESS (>= ${minTurns})`)
      process.exit(0)
    }
    console.log(`GAME FINISHED after only ${resolved} resolved turns (< ${minTurns}) — FAIL`)
    process.exit(2)
  }
  if (resolved >= wantTurns) {
    console.log(`PROGRESSED ${resolved} resolved turns — SUCCESS`)
    process.exit(0)
  }
  if (Date.now() - lastGrowth > stallS * 1000) {
    console.log(`STALLED: no new turn for ${stallS}s at ${resolved} resolved turns — FAIL`)
    process.exit(3)
  }
  await sleep(700)
}
console.log(`TIMEOUT after ${timeoutS}s at ${seen - 1} resolved turns — FAIL`)
process.exit(3)
