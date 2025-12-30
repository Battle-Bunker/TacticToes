import { onGameStarted } from "./onGameStarted"
import { onMoveCreated } from "./onMoveCreated"
import { onSessionCreated } from "./onSessionCreated"
import { processTurnExpirationTask } from "./processTurnExpirationTask"
import { wakeBot } from "./wakeBot"
import { getPlayerPublicInfo } from "./getPlayerPublicInfo"
import * as admin from "firebase-admin"

admin.initializeApp()

if (process.env.FIRESTORE_EMULATOR_HOST) {
  const firestore = admin.firestore()
  firestore.settings({
    host: process.env.FIRESTORE_EMULATOR_HOST,
    ssl: false,
  })
}

// Export your functions
export {
  onMoveCreated,
  onGameStarted,
  onSessionCreated,
  processTurnExpirationTask,
  wakeBot,
  getPlayerPublicInfo,
}
