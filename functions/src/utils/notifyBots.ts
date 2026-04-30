import axios from "axios"
import * as admin from "firebase-admin"
import { FieldValue } from "firebase-admin/firestore"
import * as logger from "firebase-functions/logger"
import { Bot, GameState, Human, Move, Winner } from "../types/Game"
import {
  buildEndPayload,
  buildMovePayload,
  buildPlayerInfoMap,
  convertDirectionToMoveIndex,
} from "./buildBotPayloads"
import {
  notifyWebsocketBot,
  notifyWebsocketBotGameEnd,
} from "./notifyWebsocketBot"

const isWebsocketBot = (bot: Bot): boolean =>
  (bot.connectionType ?? "http") === "websocket"

/**
 * Sends move requests to all active bots for a specific turn.
 *
 * For HTTP bots this preserves the historical Battlesnake-style request to
 * `${bot.url}/move`. For WebSocket bots (snek-only, see
 * docs/BOT_WEBSOCKET_API.md) this opens a connection per turn that lets the
 * bot stage and then commit a move; the connection is held open until the bot
 * commits or the turn deadline elapses.
 */
export async function notifyBots(
  sessionID: string,
  gameID: string,
  turnNumber: number,
  turnExpiryTime?: number
): Promise<void> {
  logger.info(
    `Bot notification started for game ${gameID}, turn ${turnNumber}`,
    {
      sessionID,
      gameID,
      turnNumber,
      notificationStartTime: new Date().toISOString()
    }
  )

  const gameStateRef = admin
    .firestore()
    .collection(`sessions/${sessionID}/games`)
    .doc(gameID)
  const gameStateDoc = await gameStateRef.get()
  const gameData = gameStateDoc.data() as GameState

  if (!gameData) {
    logger.error(`Game state not found for game ${gameID}`)
    return
  }

  if (turnNumber >= gameData.turns.length) {
    logger.error(
      `Turn ${turnNumber} does not exist in game ${gameID} (current turns: ${gameData.turns.length})`,
      { gameID, turnNumber, currentTurns: gameData.turns.length }
    )
    return
  }

  const turnData = gameData.turns[turnNumber]

  const botsInTurn = gameData.setup.gamePlayers.filter(
    (player) =>
      turnData.alivePlayers.includes(player.id) && player.type === "bot"
  )

  if (botsInTurn.length === 0) {
    logger.info(`No bots in turn ${turnNumber} for game ${gameID}`)
    return
  }

  const botsSnapshot = await admin.firestore().collection("bots").get()
  const allBots: Bot[] = botsSnapshot.docs.map((doc) => doc.data() as Bot)

  const botsToQuery = allBots.filter((bot) =>
    botsInTurn.find((player) => player.id === bot.id)
  )

  if (botsToQuery.length === 0) {
    logger.info(
      `No bots found in the bots collection that match the game players for turn ${turnNumber}`
    )
    return
  }

  const humanPlayerIds = gameData.setup.gamePlayers
    .filter((gp) => gp.type === "human")
    .map((gp) => gp.id)

  const humans = new Map<string, Human>()
  if (humanPlayerIds.length > 0) {
    const usersCollection = admin.firestore().collection("users")
    const humanDocs = await Promise.all(
      humanPlayerIds.map((id) => usersCollection.doc(id).get())
    )
    for (const doc of humanDocs) {
      if (doc.exists) {
        humans.set(doc.id, doc.data() as Human)
      }
    }
  }

  const playerInfoMap = buildPlayerInfoMap(allBots, humans)

  const requests = botsToQuery.map(async (bot) => {
    const payload = buildMovePayload({
      gameID,
      turnNumber,
      turnExpiryTime,
      gameData,
      bot,
      allBots,
      playerInfoMap,
    })

    if (isWebsocketBot(bot)) {
      try {
        await notifyWebsocketBot({
          sessionID,
          gameID,
          turnNumber,
          turnExpiryTime,
          bot,
          payload,
          gameData,
        })
      } catch (error) {
        logger.error(
          `Error in websocket session for bot ${bot.id}`,
          error instanceof Error ? error.message : String(error)
        )
      }
      return
    }

    try {
      const DEFAULT_TIMEOUT = 10000
      const MIN_TIMEOUT = 500
      const moveTimeout = turnExpiryTime
        ? Math.max(MIN_TIMEOUT, turnExpiryTime - Date.now())
        : DEFAULT_TIMEOUT

      logger.info(`Sending move request to bot ${bot.id} for turn ${turnNumber} (timeout: ${moveTimeout}ms)`)
      const response = await axios.post(`${bot.url}/move`, payload, {
        timeout: moveTimeout,
      })
      logger.info(`Successfully sent move request to bot ${bot.id}`, {
        response: response.data,
      })

      const moveDirection = response.data.move as
        | "up"
        | "down"
        | "left"
        | "right"
      const moveIndex = convertDirectionToMoveIndex(
        moveDirection,
        turnData.playerPieces[bot.id][0],
        gameData.setup.boardWidth,
        gameData.setup.boardHeight
      )

      const newMove: Move = {
        gameID: gameID,
        moveNumber: turnNumber,
        playerID: bot.id,
        move: moveIndex,
        timestamp: FieldValue.serverTimestamp(),
      }

      await admin
        .firestore()
        .collection(`sessions/${sessionID}/games/${gameID}/privateMoves`)
        .add(newMove)

      const path = `sessions/${sessionID}/games/${gameID}/moveStatuses/${turnNumber}`
      await admin
        .firestore()
        .doc(path)
        .update({
          movedPlayerIDs: FieldValue.arrayUnion(bot.id),
        })

      logger.info(`Successfully recorded move for bot ${bot.id}`, {
        newMove,
      })
    } catch (error) {
      logger.error(`Error sending move request to bot ${bot.id}`, error)
    }
  })

  await Promise.all(requests)

  logger.info(`Finished processing bot moves for game ${gameID}, turn ${turnNumber}`)
}

export async function notifyBotsGameEnd(
  sessionID: string,
  gameID: string,
  gameState: GameState,
  winners: Winner[],
  finalTurnNumber: number,
  finalScores: { [playerID: string]: number }
): Promise<void> {
  logger.info(`[notifyBotsGameEnd] Sending /end to bots for game ${gameID}`, {
    sessionID,
    gameID,
    finalTurnNumber,
  })

  const botPlayers = gameState.setup.gamePlayers.filter(
    (player) => player.type === "bot"
  )

  if (botPlayers.length === 0) {
    logger.info(`[notifyBotsGameEnd] No bots participated in game ${gameID}`)
    return
  }

  const botsSnapshot = await admin.firestore().collection("bots").get()
  const allBots: Bot[] = botsSnapshot.docs.map((doc) => doc.data() as Bot)

  const botsToNotify = allBots.filter((bot) =>
    botPlayers.find((player) => player.id === bot.id)
  )

  if (botsToNotify.length === 0) {
    logger.info(
      `[notifyBotsGameEnd] No matching bots found in bots collection for game ${gameID}`
    )
    return
  }

  const requests = botsToNotify.map(async (bot) => {
    const endPayload = buildEndPayload(
      gameID,
      finalTurnNumber,
      gameState,
      finalScores,
      winners,
      bot,
    )

    if (isWebsocketBot(bot)) {
      try {
        await notifyWebsocketBotGameEnd({ bot, payload: endPayload, gameID })
        logger.info(`[notifyBotsGameEnd] Sent ws game_end to bot ${bot.id}`)
      } catch (error) {
        logger.error(
          `[notifyBotsGameEnd] Error sending ws game_end to bot ${bot.id}`,
          error
        )
      }
      return
    }

    try {
      logger.info(
        `[notifyBotsGameEnd] Sending /end to bot ${bot.id} at ${bot.url}/end`
      )
      await axios.post(`${bot.url}/end`, endPayload, {
        timeout: 5000,
      })
      logger.info(`[notifyBotsGameEnd] Successfully sent /end to bot ${bot.id}`)
    } catch (error) {
      logger.error(
        `[notifyBotsGameEnd] Error sending /end to bot ${bot.id}`,
        error
      )
    }
  })

  await Promise.all(requests)

  logger.info(
    `[notifyBotsGameEnd] Finished sending /end to all bots for game ${gameID}`
  )
}
