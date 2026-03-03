import * as functions from "firebase-functions/v1"
import * as admin from "firebase-admin"
import { GameSetup, GameState, GameType } from "@shared/types/Game"
import { getProcessorClass } from "./gameprocessors/ProcessorFactory"
import { SnekProcessor } from "./gameprocessors/SnekProcessor"
import { Timestamp } from "firebase-admin/firestore"

export const generatePreviewBoard = functions.https.onCall(async (data, context) => {
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
  const setupSnap = await setupRef.get()

  if (!setupSnap.exists) {
    throw new functions.https.HttpsError("not-found", "Game setup not found")
  }

  const setup = setupSnap.data() as GameSetup

  const snekTypes: GameType[] = ["snek", "teamsnek", "kingsnek"]
  if (!snekTypes.includes(setup.gameType)) {
    throw new functions.https.HttpsError("invalid-argument", "Preview board is only supported for snek game types")
  }

  const ProcessorClass = getProcessorClass(setup.gameType)
  if (!ProcessorClass) {
    throw new functions.https.HttpsError("internal", "Could not find processor for game type")
  }

  const activePlayers = ProcessorClass.filterActivePlayers(setup)

  const previewSetup: GameSetup = {
    ...setup,
    gamePlayers: activePlayers,
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

  const processor = new ProcessorClass(mockGameState) as SnekProcessor
  const previewData = processor.generatePreviewBoard()

  await setupRef.update({
    presetFertileTiles: previewData.fertileTiles,
    presetHazards: previewData.hazards,
    presetPlayerPositions: previewData.playerPositions,
    presetFood: previewData.food,
  })

  return { success: true }
})
