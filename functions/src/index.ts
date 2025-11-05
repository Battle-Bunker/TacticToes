import { onGameStarted } from "./onGameStarted"
import { onMoveCreated } from "./onMoveCreated"
import { onBotNotificationRequest } from "./onBotNotificationRequest"
import { onSessionCreated } from "./onSessionCreated"
import { onTurnExpirationRequest } from "./onTurnExpirationRequest"
import { wakeBot } from "./wakeBot"
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
  onTurnExpirationRequest,
  onBotNotificationRequest,
  onSessionCreated,
  wakeBot,
}
