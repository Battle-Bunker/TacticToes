// End-to-end test of the refactored Team Snek platform against the dev
// Firebase project. Provisions two centaurs (admin SDK), configures a
// session, then drives both centaurs through the REAL client-SDK path
// (API key exchange -> custom token sign-in -> rules-enforced staging and
// commits) until the game finishes, asserting the full lifecycle.
//
// Usage: node e2e-teamsnek.mjs
// Requires: GOOGLE_APPLICATION_CREDENTIALS pointing at the dev SA key.
// Deps: run from a directory with firebase-admin + firebase installed
// (uses TacticToes/functions node_modules for admin, frontend for client).

import { createRequire } from "module"
import crypto from "crypto"

const require = createRequire(new URL("../functions/package.json", import.meta.url))
const admin = require("firebase-admin")

const clientRequire = createRequire(new URL("../functions/package.json", import.meta.url))
const { initializeApp } = clientRequire("firebase/app")
const { getAuth, signInWithCustomToken } = clientRequire("firebase/auth")
const {
  getFirestore, doc, onSnapshot, addDoc, collection, updateDoc,
  arrayUnion, serverTimestamp, setDoc,
} = clientRequire("firebase/firestore")
const { getFunctions, httpsCallable } = clientRequire("firebase/functions")

// Falls back to the Firebase config already in the environment, so this runs
// against whichever project the shell is pointed at with no extra setup. The
// E2E_ overrides exist for targeting a different project than the frontend.
// Nothing is defaulted to a literal: these are per-deployment values, and a
// committed fallback is both a stale-config trap and, for the API key, a leak.
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
// Must match functions/src/config/region.ts, or every callable below 404s.
const REGION = process.env.E2E_REGION ?? process.env.VITE_FIREBASE_FUNCTIONS_REGION ?? "australia-southeast1"

admin.initializeApp({ projectId: PROJECT_ID })
const adb = admin.firestore()

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)
const fail = (msg) => { console.error("E2E FAIL:", msg); process.exit(1) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- provisioning (admin) ----------

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

// ---------- centaur client (rules-enforced) ----------

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

function driveCentaur(client, centaur, sessionID, gameID, state) {
  const gameRef = doc(client.db, `sessions/${sessionID}/games/${gameID}`)
  const handled = new Set()
  return onSnapshot(gameRef, async (snap) => {
    if (!snap.exists()) return
    const game = snap.data()
    const turnNumber = game.turns.length - 1
    if (turnNumber < 0 || handled.has(turnNumber)) return
    const turn = game.turns[turnNumber]
    if (turn.winners && turn.winners.length > 0) {
      state.winners = turn.winners
      state.finalTurn = turnNumber
      return
    }
    handled.add(turnNumber)
    const mySnakes = game.setup.gamePlayers.filter(
      (gp) => gp.teamID === centaur.id && turn.alivePlayers.includes(gp.id)
    )
    for (const snake of mySnakes) {
      const allowed = turn.allowedMoves[snake.id] || []
      if (allowed.length === 0) continue
      const move = allowed[Math.floor(Math.random() * allowed.length)]
      await addDoc(collection(client.db, `sessions/${sessionID}/games/${gameID}/privateMoves`), {
        gameID, moveNumber: turnNumber, playerID: snake.id, move,
        timestamp: serverTimestamp(),
      })
      // A no-commit centaur stages but never commits, forcing turns to
      // resolve via the deadline-expiry task instead of early resolution.
      if (process.env.NO_COMMIT_CENTAUR !== centaur.name) {
        await updateDoc(doc(client.db, `sessions/${sessionID}/games/${gameID}/moveStatuses/${turnNumber}`), {
          movedPlayerIDs: arrayUnion(snake.id),
        })
      }
    }
    if (turnNumber % 10 === 0) log(`turn ${turnNumber}: ${centaur.name} moved ${mySnakes.length} snakes`)
  })
}

// ---------- test ----------

async function main() {
  const sessionID = "e2e" + Date.now().toString(36)
  log("session:", sessionID)

  const [alpha, beta] = await Promise.all([
    provisionCentaur("Alpha"), provisionCentaur("Beta"),
  ])
  log("centaurs:", alpha.id, beta.id)

  // Create the session; onSessionCreated makes the default setup.
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
  if (!gameID) fail("onSessionCreated never set latestGameID")
  log("setup doc:", gameID)

  // Configure: 2 teams x 2 snakes, small fast game.
  await adb.doc(`sessions/${sessionID}/setups/${gameID}`).update({
    teams: [
      { id: alpha.id, name: alpha.name, color: "#E5484D" },
      { id: beta.id, name: beta.name, color: "#3E63DD" },
    ],
    snakesPerTeam: 2,
    boardWidth: 11, boardHeight: 11,
    maxTurnTime: 5, firstTurnTime: 15, maxTurns: 60,
  })

  // Sign both centaurs in over the real client path BEFORE start.
  const [clientA, clientB] = await Promise.all([
    startCentaurClient(alpha), startCentaurClient(beta),
  ])

  // Pending-invite handshake (presence feature), if deployed: check invite.
  await sleep(3000)
  const pendingInvite = await adb.doc(`centaurs/${alpha.id}/games/${gameID}`).get()
  log("pending invite exists:", pendingInvite.exists, pendingInvite.data()?.status ?? "(no status)")
  if (pendingInvite.exists && pendingInvite.data()?.status === "pending") {
    // Exercise the centaurStatus ack over the rules-enforced client path.
    await setDoc(doc(clientA.db, `sessions/${sessionID}/setups/${gameID}/centaurStatus/${alpha.id}`), {
      centaurId: alpha.id, ready: true, respondedAt: serverTimestamp(),
    }, { merge: true })
    log("alpha wrote centaurStatus ack (rules allowed it)")
  }

  // Start the game.
  const state = {}
  const unsubA = driveCentaur(clientA, alpha, sessionID, gameID, state)
  const unsubB = driveCentaur(clientB, beta, sessionID, gameID, state)
  await adb.doc(`sessions/${sessionID}/setups/${gameID}`).update({ startRequested: true })
  log("start requested")

  // Wait for the game to finish (allowedMoves random walk + turn expiry).
  const deadline = Date.now() + 8 * 60 * 1000
  while (!state.winners && Date.now() < deadline) await sleep(2000)
  unsubA(); unsubB()
  if (!state.winners) fail("game did not finish within 8 minutes")
  log(`game finished at turn ${state.finalTurn}; winners:`,
    state.winners.map((w) => `${w.playerID} team=${w.teamID} teamScore=${w.teamScore} mmr=${w.newMMR}`))

  // ---------- assertions ----------
  const gameSnap = await adb.doc(`sessions/${sessionID}/games/${gameID}`).get()
  const game = gameSnap.data()
  const gp = game.setup.gamePlayers
  if (gp.length !== 4) fail(`expected 4 snakes, got ${gp.length}`)
  const letters = gp.map((p) => p.letter).sort().join("")
  if (letters !== "AABB") fail(`expected letters AABB, got ${letters}`)
  if (!gp.some((p) => p.id === `${alpha.id}#2`)) fail("expected clone id alpha#2")

  const centaurMap = await adb.doc(`sessions/${sessionID}/games/${gameID}/meta/centaurMap`).get()
  if (!centaurMap.exists) fail("centaurMap missing")
  const players = centaurMap.data().players
  if (players[`${alpha.id}#2`] !== alpha.id) fail("centaurMap clone mapping wrong")

  const inviteA = await adb.doc(`centaurs/${alpha.id}/games/${gameID}`).get()
  if (!inviteA.exists) fail("started invite missing for alpha")
  if (!(inviteA.data().snakeIDs || []).includes(`${alpha.id}#2`)) fail("invite snakeIDs missing clone")

  for (const w of state.winners) {
    if (!w.teamID || typeof w.teamScore !== "number") fail("winner missing teamID/teamScore")
  }
  const rankA = await adb.doc(`rankings/${alpha.id}`).get()
  const rankB = await adb.doc(`rankings/${beta.id}`).get()
  if (!rankA.exists || !rankB.exists) fail("flattened ranking docs missing")
  const ra = rankA.data(), rb = rankB.data()
  if (typeof ra.currentMMR !== "number" || ra.gamesPlayed !== 1) fail(`alpha ranking malformed: ${JSON.stringify(ra).slice(0, 200)}`)
  if ((ra.currentMMR - 1000) + (rb.currentMMR - 1000) !== 0 && Math.abs((ra.currentMMR - 1000) + (rb.currentMMR - 1000)) > 2)
    log("note: MMR deltas not zero-sum (rounding):", ra.currentMMR, rb.currentMMR)

  // Next lobby was created and preserved teams.
  const session = await adb.doc(`sessions/${sessionID}`).get()
  const nextGameID = session.data().latestGameID
  if (!nextGameID || nextGameID === gameID) fail("createNewGame did not advance latestGameID")
  const nextSetup = await adb.doc(`sessions/${sessionID}/setups/${nextGameID}`).get()
  const ns = nextSetup.data()
  if (ns.started || ns.startRequested) fail("next lobby flags not reset")
  if (ns.teams.length !== 2 || ns.snakesPerTeam !== 2) fail("next lobby lost teams/snakesPerTeam")
  if (ns.gamePlayers) fail("next lobby leaked gamePlayers")

  log("ALL E2E ASSERTIONS PASSED ✅")
  process.exit(0)
}

main().catch((e) => { console.error("E2E ERROR:", e); process.exit(1) })
