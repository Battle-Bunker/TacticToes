import { onGameStarted } from "./onGameStarted"
import { onMoveCreated } from "./onMoveCreated"
import { onSessionCreated } from "./onSessionCreated"
import { processTurnExpirationTask } from "./processTurnExpirationTask"
import { processScheduledGameStart } from "./processScheduledGameStart"
import { createCentaurApiKey, exchangeCentaurApiKey, getCentaurApiKeyStatus } from "./centaurAuth"
import { generatePreviewBoard } from "./generatePreviewBoard"
import * as admin from "firebase-admin"

admin.initializeApp()

if (process.env.FIRESTORE_EMULATOR_HOST) {
  const firestore = admin.firestore()
  firestore.settings({
    host: process.env.FIRESTORE_EMULATOR_HOST,
    ssl: false,
  })
}

export {
  onMoveCreated,
  onGameStarted,
  onSessionCreated,
  processTurnExpirationTask,
  processScheduledGameStart,
  generatePreviewBoard,
  createCentaurApiKey,
  exchangeCentaurApiKey,
  getCentaurApiKeyStatus,
}
