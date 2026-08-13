// Live verification of the health-recheck round trip on the dev project.
import { createRequire } from "module"
import crypto from "crypto"

const require = createRequire(new URL("../functions/package.json", import.meta.url))
const admin = require("firebase-admin")
const { initializeApp } = require("firebase/app")
const { getAuth, signInWithCustomToken } = require("firebase/auth")
const { getFirestore, doc, setDoc, updateDoc, onSnapshot, serverTimestamp } = require("firebase/firestore")
const { getFunctions, httpsCallable } = require("firebase/functions")

const PROJECT_ID = "tactic-toes-cyphid-dev"
const WEB_API_KEY = "AIzaSyAa5zfOcG-0sQKvHDZLWMxEhNGO87wYQhQ"

// Must match the deployed functions region -- required, no default by design.
const REGION = process.env.E2E_REGION ?? process.env.VITE_FIREBASE_FUNCTIONS_REGION
if (!REGION) {
  console.error("E2E: set E2E_REGION or VITE_FIREBASE_FUNCTIONS_REGION (no default; must match the deployed functions region)")
  process.exit(1)
}

admin.initializeApp({
  credential: admin.credential.cert(process.env.GOOGLE_APPLICATION_CREDENTIALS),
  projectId: PROJECT_ID,
})
const adb = admin.firestore()
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)
const fail = (m) => { console.error("FAIL:", m); process.exit(1) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const clientApp = (name) => initializeApp({ projectId: PROJECT_ID, apiKey: WEB_API_KEY }, name)

async function main() {
  // Provision centaur + credentials (admin).
  const cRef = adb.collection("centaurs").doc()
  const centaurId = cRef.id
  const apiKey = "ttc_" + crypto.randomBytes(32).toString("base64url")
  await cRef.set({ id: centaurId, name: "HealthTest", owner: "e2e-owner", public: true, createdAt: admin.firestore.FieldValue.serverTimestamp() })
  await adb.collection("centaurCredentials").doc(centaurId).set({ centaurId, owner: "e2e-owner", keyHash: crypto.createHash("sha256").update(apiKey).digest("hex"), createdAt: admin.firestore.FieldValue.serverTimestamp(), rotatedAt: null })

  // Session owned by "owner-uid"; wait for default setup.
  const sessionID = "hc" + Date.now().toString(36)
  await adb.doc(`sessions/${sessionID}`).set({ latestGameID: null, timeCreated: admin.firestore.FieldValue.serverTimestamp(), owner: "owner-uid" })
  let gameID = null
  for (let i = 0; i < 30 && !gameID; i++) { await sleep(1000); gameID = (await adb.doc(`sessions/${sessionID}`).get()).data()?.latestGameID }
  if (!gameID) fail("no setup created")
  await adb.doc(`sessions/${sessionID}/setups/${gameID}`).update({ teams: [{ id: centaurId, name: "HealthTest", color: "#E5484D" }] })
  const statusPath = `sessions/${sessionID}/setups/${gameID}/centaurStatus/${centaurId}`

  // Centaur client: sign in and run the real re-ack loop (mirrors Chris-Centaur).
  const cApp = clientApp("centaur")
  const exchange = httpsCallable(getFunctions(cApp, REGION), "exchangeCentaurApiKey")
  const { data } = await exchange({ centaurId, apiKey })
  await signInWithCustomToken(getAuth(cApp), data.customToken)
  const cdb = getFirestore(cApp)
  let ackWrites = 0
  const unsub = onSnapshot(doc(cdb, statusPath), (snap) => {
    if (snap.exists() && snap.data().ready === true) return
    ackWrites++
    void setDoc(doc(cdb, statusPath), { centaurId, ready: true, respondedAt: serverTimestamp() }, { merge: true })
  })
  await sleep(4000)
  let s = await adb.doc(statusPath).get()
  if (!s.exists || s.data().ready !== true) fail("initial ack missing")
  log("initial ack in place (writes:", ackWrites + ")")

  // Owner (human custom token, no centaur claim) flips ready -> false.
  const oApp = clientApp("owner")
  await signInWithCustomToken(getAuth(oApp), await admin.auth().createCustomToken("owner-uid"))
  await updateDoc(doc(getFirestore(oApp), statusPath), { ready: false })
  log("owner flipped ready:false (rules allowed)")

  // Centaur should re-ack.
  await sleep(4000)
  s = await adb.doc(statusPath).get()
  if (s.data().ready !== true) fail("centaur did not re-ack after recheck")
  log("centaur re-acked (writes:", ackWrites + ")")

  // Non-owner human must be denied the flip.
  const rApp = clientApp("rando")
  await signInWithCustomToken(getAuth(rApp), await admin.auth().createCustomToken("rando-uid"))
  let denied = false
  try { await updateDoc(doc(getFirestore(rApp), statusPath), { ready: false }) }
  catch (e) { denied = /permission|insufficient/i.test(String(e)) }
  if (!denied) fail("non-owner was able to reset health")
  log("non-owner flip denied by rules")

  // Owner must not be able to write ready:true (only centaurs ack).
  let denied2 = false
  try { await updateDoc(doc(getFirestore(oApp), statusPath), { ready: true }) }
  catch (e) { denied2 = /permission|insufficient/i.test(String(e)) }
  if (!denied2) fail("owner was able to forge a ready:true ack")
  log("owner ready:true forgery denied by rules")

  unsub()
  log("HEALTH-RESET E2E PASSED ✅ (total centaur ack writes:", ackWrites + ")")
  process.exit(0)
}
main().catch((e) => { console.error("ERROR:", e); process.exit(1) })
