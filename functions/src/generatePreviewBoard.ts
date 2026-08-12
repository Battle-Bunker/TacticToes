import * as functions from "firebase-functions/v1"
import { FUNCTIONS_REGION } from "./config/region"
import * as admin from "firebase-admin"
import { GameSetup, GameState, StartedGameSetup } from "@shared/types/Game"
import { TeamSnekProcessor } from "./gameprocessors/TeamSnekProcessor"
import { expandTeams } from "./utils/expandTeams"
import { Timestamp } from "firebase-admin/firestore"

export const generatePreviewBoard = functions.region(FUNCTIONS_REGION).https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Must be authenticated")
  }

  const { sessionID, gameID } = data as { sessionID?: string; gameID?: string }

  if (!sessionID || typeof sessionID !== "string") {
    throw new functions.https.HttpsError("invalid-argument", "sessionID is required")
  }
  if (!gameID || typeof gameID !== "string") {
    throw new functions.https.HttpsError("invalid-argument", "gameID is required")
  }

  const setupRef = admin.firestore().doc(`sessions/${sessionID}/setups/${gameID}`)
  const [setupSnap, sessionSnap] = await Promise.all([
    setupRef.get(),
    admin.firestore().doc(`sessions/${sessionID}`).get(),
  ])

  if (!setupSnap.exists) {
    throw new functions.https.HttpsError("not-found", "Game setup not found")
  }

  const setup = setupSnap.data() as GameSetup

  if (setup.started) {
    throw new functions.https.HttpsError("failed-precondition", "Game already started")
  }
  const owner = sessionSnap.data()?.owner ?? null
  if (owner !== null && owner !== context.auth.uid) {
    throw new functions.https.HttpsError("permission-denied", "Only the session owner can regenerate the preview")
  }

  const previewSetup: StartedGameSetup = {
    ...setup,
    gamePlayers: expandTeams(setup.teams, setup.snakesPerTeam),
    usePreviewBoard: false,
    presetFertileTiles: [],
    presetHazards: [],
    presetPlayerPositions: {},
    presetFood: [],
  }

  const mockGameState: GameState = {
    setup: previewSetup,
    turns: [],
    timeCreated: Timestamp.now(),
    timeFinished: null,
  }

  const processor = new TeamSnekProcessor(mockGameState)
  const previewData = processor.generatePreviewBoard()

  await setupRef.update({
    presetFertileTiles: previewData.fertileTiles,
    presetHazards: previewData.hazards,
    presetPlayerPositions: previewData.playerPositions,
    presetFood: previewData.food,
  })

  return { success: true }
})
