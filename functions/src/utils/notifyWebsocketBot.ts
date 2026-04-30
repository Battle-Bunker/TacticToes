import * as admin from "firebase-admin"
import { FieldValue } from "firebase-admin/firestore"
import * as logger from "firebase-functions/logger"
import WebSocket from "ws"
import { Bot, GameState, Move } from "../types/Game"
import { convertDirectionToMoveIndex } from "./buildBotPayloads"

/**
 * Drives one turn worth of WebSocket interaction with a single bot.
 *
 * Lifecycle (see docs/BOT_WEBSOCKET_API.md):
 *   1. Open ws connection to bot.url.
 *   2. Send `move_request` containing the same payload that an HTTP bot
 *      would receive.
 *   3. Bot may send any number of `stage_move` messages (each replaces
 *      the previously staged move in `privateMoves`).
 *   4. Bot may send a single `commit_move` (which also stages the move
 *      and then marks the bot as committed in `moveStatuses`).
 *   5. We close the connection on commit, on bot disconnect, or when
 *      we hit the turn deadline.
 */
export async function notifyWebsocketBot(params: {
  sessionID: string
  gameID: string
  turnNumber: number
  turnExpiryTime?: number
  bot: Bot
  payload: unknown
  gameData: GameState
}): Promise<void> {
  const { sessionID, gameID, turnNumber, turnExpiryTime, bot, payload, gameData } = params

  const DEFAULT_TIMEOUT = 10000
  const MIN_TIMEOUT = 500
  const wsTimeoutMs = turnExpiryTime
    ? Math.max(MIN_TIMEOUT, turnExpiryTime - Date.now())
    : DEFAULT_TIMEOUT

  const requestId = `${sessionID}:${gameID}:${turnNumber}`

  logger.info(
    `[notifyWebsocketBot] connecting to ${bot.url} for bot ${bot.id} turn ${turnNumber} (timeout ${wsTimeoutMs}ms)`,
    { sessionID, gameID, turnNumber, botId: bot.id }
  )

  let lastStagedMove: "up" | "down" | "left" | "right" | undefined
  let committed = false

  const ws: WebSocket = new WebSocket(bot.url, {
    handshakeTimeout: Math.min(5000, wsTimeoutMs),
  })

  // Resolve once the connection is finished (cleanly or via timeout). We never
  // reject from this function — bot misbehaviour is logged and turned into a
  // best-effort move (or no move at all, matching HTTP timeout behaviour).
  const finished = new Promise<void>((resolve) => {
    let settled = false
    const settle = () => {
      if (settled) return
      settled = true
      resolve()
    }

    const closeTimer = setTimeout(() => {
      logger.info(
        `[notifyWebsocketBot] turn deadline reached for bot ${bot.id}, closing ws`,
        { gameID, turnNumber, committed }
      )
      try {
        ws.close(1000, "turn deadline")
      } catch {
        /* ignore */
      }
      settle()
    }, wsTimeoutMs)

    const stageMove = async (
      direction: "up" | "down" | "left" | "right"
    ): Promise<void> => {
      const turnData = gameData.turns[turnNumber]
      const headIndex = turnData.playerPieces[bot.id]?.[0]
      if (headIndex === undefined) {
        logger.warn(
          `[notifyWebsocketBot] bot ${bot.id} has no head, ignoring stage`,
          { gameID, turnNumber }
        )
        return
      }
      const moveIndex = convertDirectionToMoveIndex(
        direction,
        headIndex,
        gameData.setup.boardWidth,
        gameData.setup.boardHeight
      )
      const newMove: Move = {
        gameID,
        moveNumber: turnNumber,
        playerID: bot.id,
        move: moveIndex,
        timestamp: FieldValue.serverTimestamp(),
      }
      await admin
        .firestore()
        .collection(`sessions/${sessionID}/games/${gameID}/privateMoves`)
        .add(newMove)
      lastStagedMove = direction
    }

    const commit = async (): Promise<void> => {
      const path = `sessions/${sessionID}/games/${gameID}/moveStatuses/${turnNumber}`
      try {
        await admin
          .firestore()
          .doc(path)
          .update({
            movedPlayerIDs: FieldValue.arrayUnion(bot.id),
          })
        committed = true
        logger.info(
          `[notifyWebsocketBot] bot ${bot.id} committed for turn ${turnNumber}`,
          { gameID, turnNumber }
        )
      } catch (err) {
        logger.error(
          `[notifyWebsocketBot] failed to mark bot ${bot.id} as committed`,
          { err: err instanceof Error ? err.message : String(err) }
        )
      }
    }

    ws.on("open", () => {
      try {
        ws.send(
          JSON.stringify({
            type: "move_request",
            requestId,
            payload,
          })
        )
      } catch (err) {
        logger.error(
          `[notifyWebsocketBot] failed to send move_request to bot ${bot.id}`,
          { err: err instanceof Error ? err.message : String(err) }
        )
      }
    })

    ws.on("message", async (raw) => {
      let msg: { type?: string; move?: string; shout?: string } | undefined
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        logger.warn(
          `[notifyWebsocketBot] bot ${bot.id} sent invalid JSON, closing`,
          { gameID, turnNumber }
        )
        try {
          ws.close(1003, "invalid json")
        } catch {
          /* ignore */
        }
        return
      }

      if (!msg || typeof msg !== "object" || !msg.type) return

      if (msg.type === "stage_move" || msg.type === "commit_move") {
        const direction = msg.move
        if (
          direction !== undefined &&
          direction !== "up" &&
          direction !== "down" &&
          direction !== "left" &&
          direction !== "right"
        ) {
          logger.warn(
            `[notifyWebsocketBot] bot ${bot.id} sent invalid direction "${direction}"`,
            { gameID, turnNumber, type: msg.type }
          )
          return
        }

        const effectiveDirection =
          (direction as "up" | "down" | "left" | "right" | undefined) ??
          lastStagedMove

        if (msg.type === "stage_move") {
          if (!effectiveDirection) {
            logger.warn(
              `[notifyWebsocketBot] bot ${bot.id} sent stage_move with no direction and no prior stage`,
              { gameID, turnNumber }
            )
            return
          }
          try {
            await stageMove(effectiveDirection)
          } catch (err) {
            logger.error(
              `[notifyWebsocketBot] stage failed for bot ${bot.id}`,
              { err: err instanceof Error ? err.message : String(err) }
            )
          }
        } else if (msg.type === "commit_move") {
          if (!effectiveDirection) {
            logger.warn(
              `[notifyWebsocketBot] bot ${bot.id} sent commit_move with no direction and no prior stage; rejecting`,
              { gameID, turnNumber }
            )
            return
          }
          try {
            // commit_move semantics: stage (so latest direction is the one
            // applied) and then mark as committed.
            if (direction) {
              await stageMove(effectiveDirection)
            }
            await commit()
          } catch (err) {
            logger.error(
              `[notifyWebsocketBot] commit failed for bot ${bot.id}`,
              { err: err instanceof Error ? err.message : String(err) }
            )
          }
          try {
            ws.close(1000, "committed")
          } catch {
            /* ignore */
          }
          clearTimeout(closeTimer)
          settle()
        }
      } else {
        logger.info(
          `[notifyWebsocketBot] bot ${bot.id} sent unknown message type "${msg.type}"`,
          { gameID, turnNumber }
        )
      }
    })

    ws.on("close", () => {
      logger.info(
        `[notifyWebsocketBot] ws closed for bot ${bot.id}`,
        { gameID, turnNumber, committed }
      )
      clearTimeout(closeTimer)
      settle()
    })

    ws.on("error", (err: Error) => {
      logger.error(
        `[notifyWebsocketBot] ws error for bot ${bot.id}`,
        { err: err.message, gameID, turnNumber }
      )
      clearTimeout(closeTimer)
      settle()
    })
  })

  await finished
}

/**
 * Sends a one-shot `game_end` message to a websocket bot. We don't care about
 * the response and tear the connection down quickly.
 */
export async function notifyWebsocketBotGameEnd(params: {
  bot: Bot
  payload: unknown
  gameID: string
}): Promise<void> {
  const { bot, payload, gameID } = params
  const requestId = `${gameID}:end`

  await new Promise<void>((resolve) => {
    let settled = false
    const settle = () => {
      if (settled) return
      settled = true
      resolve()
    }

    const ws: WebSocket = new WebSocket(bot.url, { handshakeTimeout: 5000 })

    const closeTimer = setTimeout(() => {
      try {
        ws.close(1000, "end timeout")
      } catch {
        /* ignore */
      }
      settle()
    }, 5000)

    ws.on("open", () => {
      try {
        ws.send(
          JSON.stringify({
            type: "game_end",
            requestId,
            payload,
          })
        )
      } catch (err) {
        logger.error(
          `[notifyWebsocketBotGameEnd] failed to send game_end to bot ${bot.id}`,
          { err: err instanceof Error ? err.message : String(err) }
        )
      }
      // Give the bot a moment to receive then tear it down.
      setTimeout(() => {
        try {
          ws.close(1000, "end")
        } catch {
          /* ignore */
        }
      }, 200)
    })

    ws.on("close", () => {
      clearTimeout(closeTimer)
      settle()
    })

    ws.on("error", (err: Error) => {
      logger.error(
        `[notifyWebsocketBotGameEnd] ws error for bot ${bot.id}`,
        { err: err.message }
      )
      clearTimeout(closeTimer)
      settle()
    })
  })
}
