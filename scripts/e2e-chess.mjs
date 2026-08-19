// End-to-end test of chess-piece games against the dev Firebase project.
// Provisions two centaurs (admin SDK), configures a mixed snake+piece game,
// then drives both centaurs through the REAL client-SDK path, asserting the
// chess mechanics on the resolved turns: piece spawns (weight-1 stacks,
// unitTypes, every-unit orientation), per-type max health, movement-tied health loss
// (stationary pieces spend nothing), slider paths + applied-move recording,
// pawn rotation, pawn promotion (weight reset to 1), and snake 1/turn drain.
//
// Usage: node e2e-chess.mjs
// Requires: GOOGLE_APPLICATION_CREDENTIALS + VITE_FIREBASE_* (or E2E_*) env,
// same as e2e-teamsnek.mjs.

import { createRequire } from "module"
import crypto from "crypto"

const require = createRequire(new URL("../functions/package.json", import.meta.url))
const admin = require("firebase-admin")
const { initializeApp } = require("firebase/app")
const { getAuth, signInWithCustomToken } = require("firebase/auth")
const {
  getFirestore, doc, onSnapshot, addDoc, collection, updateDoc,
  arrayUnion, serverTimestamp,
} = require("firebase/firestore")
const { getFunctions, httpsCallable } = require("firebase/functions")

const req = (name, ...candidates) => {
  const value = candidates.find(Boolean)
  if (!value) {
    console.error(`E2E: set ${name} (or the matching VITE_FIREBASE_* secret)`)
    process.exit(1)
  }
  return value
}

const PROJECT_ID = req("E2E_PROJECT_ID", process.env.E2E_PROJECT_ID, process.env.VITE_FIREBASE_PROJECT_ID)
const WEB_API_KEY = req("E2E_WEB_API_KEY", process.env.E2E_WEB_API_KEY, process.env.VITE_FIREBASE_API_KEY)
const APP_ID = req("E2E_APP_ID", process.env.E2E_APP_ID, process.env.VITE_FIREBASE_APP_ID)
// Must match the deployed functions region -- required, no default by design.
const REGION = req("E2E_REGION", process.env.E2E_REGION, process.env.VITE_FIREBASE_FUNCTIONS_REGION)

admin.initializeApp({ projectId: PROJECT_ID })
const adb = admin.firestore()

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)
const failures = []
const check = (cond, msg) => {
  if (cond) { log("  ok:", msg) } else { failures.push(msg); console.error("  FAIL:", msg) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function provisionCentaur(name) {
  const ref = adb.collection("centaurs").doc()
  const id = ref.id
  const apiKey = "ttc_" + crypto.randomBytes(32).toString("base64url")
  const keyHash = crypto.createHash("sha256").update(apiKey).digest("hex")
  await ref.set({
    id, name, owner: "e2e-owner", public: true,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  })
  await adb.collection("centaurCredentials").doc(id).set({
    centaurId: id, owner: "e2e-owner", keyHash,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    rotatedAt: null,
  })
  return { id, name, apiKey }
}

async function startCentaurClient(centaur) {
  const app = initializeApp(
    { projectId: PROJECT_ID, apiKey: WEB_API_KEY, appId: APP_ID },
    centaur.id
  )
  const auth = getAuth(app)
  const fns = getFunctions(app, REGION)
  const exchange = httpsCallable(fns, "exchangeCentaurApiKey")
  const { data } = await exchange({ centaurId: centaur.id, apiKey: centaur.apiKey })
  await signInWithCustomToken(auth, data.customToken)
  log(`centaur ${centaur.name} signed in as`, auth.currentUser.uid)
  return { app, db: getFirestore(app) }
}

// Random adjacent snake move avoiding walls and unit cells (same as the
// snake e2e — enough to keep snakes alive for the assertion window).
function pickSnakeMove(setup, turn, headIndex) {
  const w = setup.boardWidth
  const h = setup.boardHeight
  const x = headIndex % w
  const y = Math.floor(headIndex / w)
  const adjacent = [
    x > 0 ? headIndex - 1 : null,
    x < w - 1 ? headIndex + 1 : null,
    y > 0 ? headIndex - w : null,
    y < h - 1 ? headIndex + w : null,
  ].filter((i) => i !== null)
  const blocked = new Set()
  for (let cx = 0; cx < w; cx++) { blocked.add(cx); blocked.add((h - 1) * w + cx) }
  for (let cy = 0; cy < h; cy++) { blocked.add(cy * w); blocked.add(cy * w + w - 1) }
  Object.values(turn.playerPieces).forEach((body) => body.forEach((p) => blocked.add(p)))
  const safe = adjacent.filter((i) => !blocked.has(i))
  const pool = safe.length > 0 ? safe : adjacent
  return pool[Math.floor(Math.random() * pool.length)]
}

// First direction whose next `steps` squares are interior and empty of units.
function pickClearSlide(setup, turn, origin, steps) {
  const w = setup.boardWidth
  const h = setup.boardHeight
  const occupied = new Set()
  Object.values(turn.playerPieces).forEach((body) => body.forEach((p) => occupied.add(p)))
  const interior = (i) => {
    const x = i % w, y = Math.floor(i / w)
    return x >= 1 && x <= w - 2 && y >= 1 && y <= h - 2
  }
  for (const d of [1, -1, w, -w]) {
    let ok = true
    for (let k = 1; k <= steps; k++) {
      const cell = origin + d * k
      if (!interior(cell) || occupied.has(cell)) { ok = false; break }
    }
    if (ok) return origin + d * steps
  }
  return null
}

async function main() {
  const sessionID = "e2echess" + Date.now().toString(36)
  log("session:", sessionID)

  const [alpha, beta] = await Promise.all([
    provisionCentaur("ChessAlpha"), provisionCentaur("ChessBeta"),
  ])

  await adb.doc(`sessions/${sessionID}`).set({
    latestGameID: null,
    timeCreated: admin.firestore.FieldValue.serverTimestamp(),
    owner: "e2e-owner",
  })
  let gameID = null
  for (let i = 0; i < 30 && !gameID; i++) {
    await sleep(1000)
    const s = await adb.doc(`sessions/${sessionID}`).get()
    gameID = s.data()?.latestGameID ?? null
  }
  if (!gameID) { console.error("onSessionCreated never set latestGameID"); process.exit(1) }
  log("setup doc:", gameID)

  // Mixed game: each team gets snake + king + rook + pawn. Kings run at max
  // health 10 to prove stationary units spend nothing. 13x13, no hazards.
  await adb.doc(`sessions/${sessionID}/setups/${gameID}`).update({
    teams: [
      { id: alpha.id, name: alpha.name, color: "#E5484D" },
      { id: beta.id, name: beta.name, color: "#3E63DD" },
    ],
    snakesPerTeam: 1,
    unitsPerTeam: { snake: 1, king: 1, rook: 1, pawn: 1 },
    maxHealthPerUnit: { king: 10 },
    pawnPromotionWeight: 3,
    boardWidth: 13, boardHeight: 13,
    maxTurnTime: 5, firstTurnTime: 15, maxTurns: 20,
    foodSpawnRate: 0.5,
  })

  const [clientA, clientB] = await Promise.all([
    startCentaurClient(alpha), startCentaurClient(beta),
  ])

  // Per-centaur driver: scripted piece actions + random snake walk, committing
  // every alive unit each turn so turns resolve early.
  const state = { rookSlide: {}, pawnRotate: {} }
  const drive = (client, centaur) => {
    const gameRef = doc(client.db, `sessions/${sessionID}/games/${gameID}`)
    const handled = new Set()
    return onSnapshot(gameRef, async (snap) => {
      if (!snap.exists()) return
      const game = snap.data()
      const turnNumber = game.turns.length - 1
      if (turnNumber < 0 || handled.has(turnNumber)) return
      const turn = game.turns[turnNumber]
      if (turn.winners && turn.winners.length > 0) { state.done = true; return }
      handled.add(turnNumber)
      const mine = game.setup.gamePlayers.filter(
        (gp) => gp.teamID === centaur.id && turn.alivePlayers.includes(gp.id)
      )
      for (const unit of mine) {
        const type = turn.unitTypes?.[unit.id] ?? unit.unitType ?? "snake"
        const head = turn.playerPieces[unit.id]?.[0]
        if (head === undefined) continue
        let move = null
        if (type === "snake") {
          move = pickSnakeMove(game.setup, turn, head)
        } else if (type === "rook" && turnNumber === 0) {
          move = pickClearSlide(game.setup, turn, head, 2)
          if (move !== null) state.rookSlide[unit.id] = { from: head, to: move }
        } else if (type === "pawn" && turnNumber === 1) {
          const f = turn.orientation[unit.id]
          // Stage a side square (perpendicular to orientation) = quarter rotation.
          const w = game.setup.boardWidth
          const perp = { dx: -f.dy, dy: f.dx }
          move = head + perp.dy * w + perp.dx
          state.pawnRotate[unit.id] = { at: head, orientation: { ...f }, staged: move }
        }
        // Everything else (kings always, rook/pawn on other turns) stays:
        // stage nothing; the engine defaults pieces to stay.
        if (move !== null && move !== undefined) {
          await addDoc(collection(client.db, `sessions/${sessionID}/games/${gameID}/privateMoves`), {
            gameID, moveNumber: turnNumber, playerID: unit.id, move,
            timestamp: serverTimestamp(),
          })
        }
        // A no-commit centaur stages but never commits, forcing turns to
        // resolve via the deadline-expiry task instead of early resolution.
        if (process.env.NO_COMMIT_CENTAUR !== centaur.name) {
          await updateDoc(doc(client.db, `sessions/${sessionID}/games/${gameID}/moveStatuses/${turnNumber}`), {
            movedPlayerIDs: arrayUnion(unit.id),
          })
        }
      }
      log(`turn ${turnNumber}: ${centaur.name} acted for ${mine.length} units`)
    })
  }

  const unsubA = drive(clientA, alpha)
  const unsubB = drive(clientB, beta)
  await adb.doc(`sessions/${sessionID}/setups/${gameID}`).update({ startRequested: true })
  log("start requested")

  // Let at least 6 turns resolve (or the game end), then assert offline.
  const deadline = Date.now() + 5 * 60 * 1000
  let game = null
  while (Date.now() < deadline) {
    await sleep(2000)
    const snap = await adb.doc(`sessions/${sessionID}/games/${gameID}`).get()
    if (snap.exists) {
      game = snap.data()
      if (game.turns.length >= 7 || state.done) break
    }
  }
  unsubA(); unsubB()
  if (!game || game.turns.length < 3) {
    console.error(`E2E FAIL: only ${game?.turns?.length ?? 0} turns resolved`)
    process.exit(1)
  }
  const turns = game.turns
  log(`resolved ${turns.length} turns; asserting…`)

  const gp = game.setup.gamePlayers
  const byType = (teamId, t) => gp.find((p) => p.teamID === teamId && p.unitType === t)?.id
  const t0 = turns[0]

  // --- Turn 0: spawn shape ---
  log("turn 0 spawn shape")
  check(gp.length === 8, `8 gamePlayers (got ${gp.length})`)
  check(gp.filter((p) => p.unitType === "king").length === 2, "2 kings configured")
  for (const team of [alpha.id, beta.id]) {
    const snakeId = byType(team, "snake")
    const kingId = byType(team, "king")
    const rookId = byType(team, "rook")
    const pawnId = byType(team, "pawn")
    check(!!snakeId && !!kingId && !!rookId && !!pawnId, `${team}: all four unit types present`)
    check(t0.playerPieces[snakeId]?.length === 3, "snake spawns as stacked triple")
    check(t0.playerPieces[kingId]?.length === 1, "king spawns at weight 1")
    check(t0.unitTypes?.[rookId] === "rook", "turn.unitTypes carries rook")
    for (const id of [snakeId, kingId, rookId, pawnId]) {
      check(!!t0.orientation[id], `${id} has spawn orientation`)
    }
    check(t0.playerHealth[kingId] === 10, `king starts at configured max 10 (got ${t0.playerHealth[kingId]})`)
    check(t0.playerHealth[snakeId] === 100, "snake starts at 100")
    check(t0.scores[kingId] === 1 && t0.scores[snakeId] === 3, "scores = weight (piece 1, snake 3)")
  }

  // --- Rook slide staged on turn 0, visible in turn 1 ---
  log("rook slide (paths, applied move, movement-cost health)")
  for (const [rookId, slide] of Object.entries(state.rookSlide)) {
    const t1 = turns[1]
    if (!t1 || !t1.alivePlayers.includes(rookId)) { log(`  note: rook ${rookId} not alive turn 1, skipping`); continue }
    const pos = t1.playerPieces[rookId][0]
    const ate = t1.playerPieces[rookId].length > 1
    check(t1.moves[rookId] === pos, "moves[rook] records the square actually reached")
    const path = t1.paths?.[rookId]
    check(Array.isArray(path) && path.length >= 1 && path[path.length - 1] === pos,
      `turn.paths records traversal ending at the rook (path=${JSON.stringify(path)})`)
    if (!ate) {
      check(t1.playerHealth[rookId] === 100 - (path?.length ?? 0),
        `rook health = 100 - traversed (${t1.playerHealth[rookId]} vs path ${path?.length})`)
    } else {
      check(t1.playerHealth[rookId] === 100, "rook ate at destination: restored to max")
    }
    check(pos === slide.to || (path?.length ?? 0) < 2,
      "rook reached its staged destination (or was stopped in flight)")
  }

  // --- Kings hold: zero cost while stationary ---
  log("stationary kings spend nothing")
  for (const team of [alpha.id, beta.id]) {
    const kingId = byType(team, "king")
    const last = Math.min(turns.length - 1, 5)
    if (!turns[last].alivePlayers.includes(kingId)) { log(`  note: king ${kingId} died, skipping`); continue }
    check(turns[last].playerHealth[kingId] === 10,
      `king still at 10 health after ${last} turns of holding (got ${turns[last].playerHealth[kingId]})`)
    check(turns[last].playerPieces[kingId][0] === t0.playerPieces[kingId][0], "king never moved")
    check(turns[last].moves[kingId] === t0.playerPieces[kingId][0], "king's applied move records stay (own square)")
  }

  // --- Pawn rotation staged on turn 1, visible in turn 2 ---
  log("pawn rotation")
  for (const [pawnId, rot] of Object.entries(state.pawnRotate)) {
    const t2 = turns[2]
    if (!t2 || !t2.alivePlayers.includes(pawnId)) { log(`  note: pawn ${pawnId} not alive turn 2, skipping`); continue }
    const f2 = t2.orientation[pawnId]
    check(f2 && (f2.dx !== rot.orientation.dx || f2.dy !== rot.orientation.dy),
      `pawn orientation changed (${JSON.stringify(rot.orientation)} -> ${JSON.stringify(f2)})`)
    check(t2.playerPieces[pawnId][0] === rot.at, "rotating pawn did not move")
    const t1 = turns[1]
    check(t2.playerHealth[pawnId] === t1.playerHealth[pawnId], "rotation cost no health")
  }

  // --- Promotion (opportunistic): if any pawn promoted, it did so at weight 1 ---
  log("pawn promotion (if one happened)")
  let sawPromotion = false
  for (let i = 1; i < turns.length; i++) {
    const prev = turns[i - 1], cur = turns[i]
    for (const p of gp) {
      if ((prev.unitTypes?.[p.id]) !== "pawn" || (cur.unitTypes?.[p.id]) !== "queen") continue
      sawPromotion = true
      check(cur.playerPieces[p.id]?.length === 1,
        `promoted pawn ${p.id} reset to weight 1 (got ${cur.playerPieces[p.id]?.length})`)
      check(cur.scores[p.id] === 1, "promoted unit scores 1")
      check(cur.alivePlayers.includes(p.id), "promoting did not eliminate the unit")
    }
  }
  if (!sawPromotion) log("  note: no pawn reached the promotion weight this run")

  // --- Snakes drain exactly 1/turn when not eating ---
  log("snake movement drain")
  outer: for (const team of [alpha.id]) {
    const snakeId = byType(team, "snake")
    for (let i = 1; i < Math.min(turns.length, 6); i++) {
      const prev = turns[i - 1], cur = turns[i]
      if (!cur.alivePlayers.includes(snakeId) || !prev.alivePlayers.includes(snakeId)) continue outer
      const ate = cur.playerPieces[snakeId].length > prev.playerPieces[snakeId].length
      if (!ate) {
        check(cur.playerHealth[snakeId] === prev.playerHealth[snakeId] - 1,
          `snake lost exactly 1 health turn ${i} (${prev.playerHealth[snakeId]} -> ${cur.playerHealth[snakeId]})`)
        break outer
      }
    }
  }

  if (failures.length > 0) {
    console.error(`E2E CHESS: ${failures.length} FAILURES`)
    process.exit(1)
  }
  log("ALL CHESS E2E ASSERTIONS PASSED ✅")
  process.exit(0)
}

main().catch((e) => { console.error("E2E ERROR:", e); process.exit(1) })
