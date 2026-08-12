import * as functions from "firebase-functions/v1"
import { FUNCTIONS_REGION } from "./config/region"
import * as logger from "firebase-functions/logger"
import * as admin from "firebase-admin"
import { Session } from "@shared/types/Game"
import { createNewGame } from "./utils/createNewGame"

export const onSessionCreated = functions
  .region(FUNCTIONS_REGION)
  .firestore
  .document("sessions/{sessionID}")
  .onCreate(async (snap, context) => {
    const sessionData = snap.data() as Session
    const { sessionID } = context.params

    logger.info(`making new session: ${sessionID}`, { sessionData })

    await admin.firestore().runTransaction(async (transaction) => {
      await createNewGame(transaction, sessionID, null)
    })

    logger.info(`Finished creating session ${sessionID}.`)
  })
