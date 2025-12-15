// functions/src/triggers/onGameStarted.ts

import * as functions from "firebase-functions/v1"
import * as admin from "firebase-admin"
import { getFunctions } from "firebase-admin/functions"
import { GameSetup, GameState, MoveStatus } from "@shared/types/Game" // Adjust the path as necessary
import { getGameProcessor, getProcessorClass } from "./gameprocessors/ProcessorFactory"
import { logger } from "./logger" // Adjust the path as necessary
import { FieldValue, Timestamp } from "firebase-admin/firestore"
import { notifyBots } from "./utils/notifyBots"

/**
 * Firestore Trigger to start the game when all players are ready.
 */
export const onGameStarted = functions.firestore
  .document("sessions/{sessionID}/setups/{gameID}")
  .onUpdate(async (change, context) => {
    const beforeData = change.before.data() as GameSetup
    const afterData = change.after.data() as GameSetup
    const { gameID, sessionID } = context.params

    logger.debug(`Checking update on game: ${gameID}`)

    if (beforeData.started) {
      logger.warn("game already started")
      return
    }

    // Check if all playerIDs are in playersReady
    const allPlayersReady = afterData.gamePlayers
      .filter((gamePlayer) => gamePlayer.type === "human")
      .every((player) => afterData.playersReady.includes(player.id))

    if (!allPlayersReady) {
      logger.info(`Not all players are ready for game ${gameID}.`)
      return
    }

    if (afterData.gamePlayers.length === 0) {
      logger.info(`no one in game. nonsense. ${gameID}.`)
      return
    }

    if (!afterData.startRequested) {
      logger.info(`start not requested yet ${gameID}.`)
      return
    }

    // If the game has started, abort
    if (afterData.started) {
      logger.info(`game has started ${gameID}.`)
      return
    }

    // Get the processor class to determine which players should be active
    const ProcessorClass = getProcessorClass(afterData.gameType)
    if (!ProcessorClass) {
      logger.error(
        `No processor class found for gameType: ${afterData.gameType} in game ${gameID}`,
      )
      return
    }

    // Filter players using the processor's logic
    // Players not returned become observers
    const filteredSetup = {
      ...afterData,
      gamePlayers: ProcessorClass.filterActivePlayers(afterData)
    }

    // gameprocessor needs gamestate due to needing all turns.
    // construct a new object with empty fields
    const gameState: GameState = {
      turns: [],
      setup: filteredSetup,
      // these are not used, don't want to change to optional fields though
      timeCreated: Timestamp.fromMillis(0),
      timeFinished: Timestamp.fromMillis(0),

    }

    // Instantiate the appropriate processor using the factory
    const processor = getGameProcessor(gameState)

    if (!processor) {
      logger.error(
        `No processor found for gameType: ${afterData.gameType} in game ${gameID}`,
      )
      return
    }

    // Use a transaction to ensure consistency
    const turnDurationSeconds = await admin.firestore().runTransaction(async (transaction) => {
      // If not all players are ready, exit early

      // Initialize the game using the processor's method
      const firstTurn = processor.firstTurn()
      const now = Date.now() // Current time in milliseconds
      const firstTurnTimeSeconds = filteredSetup.firstTurnTime ?? 60 // Default to 60 seconds for backward compatibility
      const startTurnDurationMillis = firstTurnTimeSeconds * 1000 // Convert firstTurnTime from seconds to milliseconds
      const endTime = new Date(now + startTurnDurationMillis) // Add turn time to current time
      firstTurn.startTime = Timestamp.fromMillis(now)
      firstTurn.endTime = Timestamp.fromDate(endTime)

      afterData.started = true

      // set the game
      const gameStateRef = admin
        .firestore()
        .collection(`sessions/${sessionID}/games`)
        .doc(gameID)
      const newGame: GameState = {
        setup: filteredSetup,
        turns: [firstTurn],
        timeCreated: FieldValue.serverTimestamp(),
        timeFinished: null,
      }
      transaction.set(gameStateRef, newGame)

      // set started to true
      const gameSetupRef = admin
        .firestore()
        .collection(`sessions/${sessionID}/setups`)
        .doc(gameID)
      transaction.update(gameSetupRef, { started: true })

      // set the movestatus for players to write to
      const moveStatusRef = admin
        .firestore()
        .collection(`sessions/${sessionID}/games/${gameID}/moveStatuses`)
        .doc("0")
      const moveStatus: MoveStatus = {
        moveNumber: 0,
        alivePlayerIDs: firstTurn.alivePlayers,
        movedPlayerIDs: [],
      }
      transaction.set(moveStatusRef, moveStatus)

      logger.info(`[onGameStarted] Game ${gameID} has been initialized.`)
      
      // Return first turn duration for post-transaction orchestration
      return firstTurnTimeSeconds
    })

    // After transaction commits, schedule turn expiration and notify bots for turn 0
    logger.info(`[onGameStarted] Starting post-transaction orchestration for game ${gameID}`, {
      sessionID,
      gameID,
      turnDurationSeconds
    })

    try {
      // Schedule turn expiration task for turn 0
      const queue = getFunctions().taskQueue("processTurnExpirationTask")
      logger.info(`[onGameStarted] Got task queue reference`, { gameID })
      
      await queue.enqueue(
        {
          sessionID,
          gameID,
          turnNumber: 0,
        },
        {
          scheduleDelaySeconds: turnDurationSeconds,
        }
      )

      logger.info(
        `[onGameStarted] Successfully scheduled turn expiration for game ${gameID}, turn 0`,
        {
          sessionID,
          gameID,
          turnNumber: 0,
          delaySeconds: turnDurationSeconds,
        }
      )
    } catch (error) {
      logger.error(`[onGameStarted] Error scheduling turn expiration`, { gameID, error })
    }

    try {
      // Notify bots immediately for turn 0
      logger.info(`[onGameStarted] Starting bot notifications for turn 0`, { gameID })
      await notifyBots(sessionID, gameID, 0)
      logger.info(`[onGameStarted] Bot notifications completed for turn 0`, { gameID })
    } catch (error) {
      logger.error(`[onGameStarted] Error notifying bots for game ${gameID}, turn 0`, error)
    }

    logger.info(`[onGameStarted] Game ${gameID} initialization complete`)
  })
