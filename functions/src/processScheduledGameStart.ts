import * as admin from "firebase-admin"
import { onTaskDispatched } from "firebase-functions/v2/tasks"
import { getFunctions } from "firebase-admin/functions"
import * as logger from "firebase-functions/logger"
import { GameSetup, GameState, MoveStatus } from "@shared/types/Game"
import { getGameProcessor, getProcessorClass } from "./gameprocessors/ProcessorFactory"
import { FieldValue, Timestamp } from "firebase-admin/firestore"
import { notifyBots } from "./utils/notifyBots"

export const processScheduledGameStart = onTaskDispatched(
  async (request) => {
    const { sessionID, gameID, expectedScheduledStartMillis } = request.data

    logger.info(
      `[processScheduledGameStart] Task started for session ${sessionID}, game ${gameID}`,
      { sessionID, gameID, taskStartTime: new Date().toISOString() }
    )

    const setupRef = admin
      .firestore()
      .collection(`sessions/${sessionID}/setups`)
      .doc(gameID)

    const setupDoc = await setupRef.get()
    if (!setupDoc.exists) {
      logger.warn(`[processScheduledGameStart] Setup not found for game ${gameID}`)
      return
    }

    const setup = setupDoc.data() as GameSetup

    if (!setup.tournamentMode) {
      logger.info(`[processScheduledGameStart] Tournament mode not active for game ${gameID}, skipping`)
      return
    }

    if (setup.started) {
      logger.info(`[processScheduledGameStart] Game ${gameID} already started, skipping`)
      return
    }

    if (!setup.scheduledStartTime) {
      logger.info(`[processScheduledGameStart] No scheduledStartTime set for game ${gameID}, skipping`)
      return
    }

    const scheduledTime = setup.scheduledStartTime as Timestamp
    const scheduledMillis = scheduledTime.toMillis()
    if (expectedScheduledStartMillis && Math.abs(scheduledMillis - expectedScheduledStartMillis) > 5000) {
      logger.info(
        `[processScheduledGameStart] scheduledStartTime mismatch for game ${gameID} — stale task, skipping`,
        { scheduledMillis, expectedScheduledStartMillis }
      )
      return
    }

    if (setup.gamePlayers.length === 0) {
      logger.info(`[processScheduledGameStart] No players in game ${gameID}, skipping`)
      return
    }

    const ProcessorClass = getProcessorClass(setup.gameType)
    if (!ProcessorClass) {
      logger.error(`[processScheduledGameStart] No processor class found for gameType: ${setup.gameType}`)
      return
    }

    const filteredSetup = {
      ...setup,
      gamePlayers: ProcessorClass.filterActivePlayers(setup),
    }

    const gameState: GameState = {
      turns: [],
      setup: filteredSetup,
      timeCreated: Timestamp.fromMillis(0),
      timeFinished: Timestamp.fromMillis(0),
    }

    const processor = getGameProcessor(gameState)
    if (!processor) {
      logger.error(`[processScheduledGameStart] No processor found for gameType: ${setup.gameType}`)
      return
    }

    const txResult = await admin.firestore().runTransaction(async (transaction) => {
      const freshDoc = await transaction.get(setupRef)
      const freshSetup = freshDoc.data() as GameSetup

      if (freshSetup.started) {
        logger.info(`[processScheduledGameStart] Game ${gameID} already started (in transaction), skipping`)
        return null
      }

      if (!freshSetup.tournamentMode) {
        logger.info(`[processScheduledGameStart] Tournament mode disabled (in transaction), skipping`)
        return null
      }

      if (expectedScheduledStartMillis && freshSetup.scheduledStartTime) {
        const freshScheduledMillis = (freshSetup.scheduledStartTime as Timestamp).toMillis()
        if (Math.abs(freshScheduledMillis - expectedScheduledStartMillis) > 5000) {
          logger.info(`[processScheduledGameStart] scheduledStartTime changed (in transaction), stale task — skipping`)
          return null
        }
      }

      const freshFilteredSetup = {
        ...freshSetup,
        gamePlayers: ProcessorClass.filterActivePlayers(freshSetup),
      }

      const freshGameState: GameState = {
        turns: [],
        setup: freshFilteredSetup,
        timeCreated: Timestamp.fromMillis(0),
        timeFinished: Timestamp.fromMillis(0),
      }
      const freshProcessor = getGameProcessor(freshGameState)
      if (!freshProcessor) {
        logger.error(`[processScheduledGameStart] No processor found for gameType (in transaction): ${freshSetup.gameType}`)
        return null
      }

      const firstTurn = freshProcessor.firstTurn()
      const nowMs = Date.now()
      const firstTurnTimeSeconds = freshFilteredSetup.firstTurnTime ?? 60
      const startTurnDurationMillis = firstTurnTimeSeconds * 1000
      const endTime = new Date(nowMs + startTurnDurationMillis)
      firstTurn.startTime = Timestamp.fromMillis(nowMs)
      firstTurn.endTime = Timestamp.fromDate(endTime)

      const gameStateRef = admin
        .firestore()
        .collection(`sessions/${sessionID}/games`)
        .doc(gameID)
      const newGame: GameState = {
        setup: freshFilteredSetup,
        turns: [firstTurn],
        timeCreated: FieldValue.serverTimestamp(),
        timeFinished: null,
      }
      transaction.set(gameStateRef, newGame)

      transaction.update(setupRef, { started: true, startRequested: true })

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

      logger.info(`[processScheduledGameStart] Game ${gameID} initialized in transaction`)
      return { turnDurationSeconds: firstTurnTimeSeconds, turnExpiryTime: nowMs + startTurnDurationMillis }
    })

    if (txResult === null) {
      logger.info(`[processScheduledGameStart] Transaction aborted for game ${gameID}`)
      return
    }

    const { turnDurationSeconds, turnExpiryTime } = txResult

    try {
      const queue = getFunctions().taskQueue("processTurnExpirationTask")
      await queue.enqueue(
        { sessionID, gameID, turnNumber: 0 },
        { scheduleDelaySeconds: turnDurationSeconds }
      )
      logger.info(
        `[processScheduledGameStart] Scheduled turn expiration for game ${gameID}, turn 0`,
        { delaySeconds: turnDurationSeconds }
      )
    } catch (error) {
      logger.error(`[processScheduledGameStart] Error scheduling turn expiration`, { gameID, error })
    }

    try {
      await notifyBots(sessionID, gameID, 0, turnExpiryTime)
      logger.info(`[processScheduledGameStart] Bot notifications completed for turn 0`, { gameID })
    } catch (error) {
      logger.error(`[processScheduledGameStart] Error notifying bots for game ${gameID}, turn 0`, error)
    }

    logger.info(`[processScheduledGameStart] Task completed for game ${gameID}`)
  }
)
