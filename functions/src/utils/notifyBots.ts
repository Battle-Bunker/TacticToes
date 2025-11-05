import axios from "axios"
import * as admin from "firebase-admin"
import { FieldValue } from "firebase-admin/firestore"
import * as logger from "firebase-functions/logger"
import { Bot, GameState, Move } from "../types/Game"

/**
 * Sends move requests to all active bots for a specific turn.
 * This function fetches the current game state and sends Battlesnake API requests
 * to each bot, then records their moves.
 */
export async function notifyBots(
  sessionID: string,
  gameID: string,
  turnNumber: number
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

  // Fetch the current game state
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

  // Validate that the turn number exists in the game
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

  // Fetch all bots from the "bots" collection
  const botsSnapshot = await admin.firestore().collection("bots").get()
  const allBots: Bot[] = botsSnapshot.docs.map((doc) => doc.data() as Bot)

  // Filter to get the bots that are playing in the current game
  const botsToQuery = allBots.filter((bot) =>
    botsInTurn.find((player) => player.id === bot.id)
  )

  if (botsToQuery.length === 0) {
    logger.info(
      `No bots found in the bots collection that match the game players for turn ${turnNumber}`
    )
    return
  }

  // Adjusts a position based on the new reduced board and flips the y-axis
  const adjustPosition = (x: number, y: number): { x: number; y: number } => {
    return { x: x - 1, y: gameData.setup.boardHeight - y - 2 } // Shift x inward and flip y-axis
  }

  // Helper function to determine snake color - team color in team mode, otherwise bot color
  const getSnakeColor = (playerID: string): string => {
    if (
      (gameData.setup.gameType === "teamsnek" ||
        gameData.setup.gameType === "kingsnek") &&
      gameData.setup.teams
    ) {
      const gamePlayer = gameData.setup.gamePlayers.find(
        (gp) => gp.id === playerID
      )
      if (gamePlayer?.teamID) {
        const team = gameData.setup.teams.find(
          (t) => t.id === gamePlayer.teamID
        )
        if (team) {
          return team.color
        }
      }
    }
    // Fall back to bot color if not in team mode or team not found
    const botInfo = allBots.find((b) => b.id === playerID)
    return botInfo?.colour || "#FF0000"
  }

  // Helper function to check if a player is a King
  const isKing = (playerID: string): boolean => {
    if (gameData.setup.gameType !== "kingsnek") return false
    const gamePlayer = gameData.setup.gamePlayers.find(
      (gp) => gp.id === playerID
    )
    return gamePlayer?.isKing || false
  }

  // Helper function to get team's King ID
  const getTeamKingID = (teamID: string): string | undefined => {
    if (gameData.setup.gameType !== "kingsnek") return undefined
    const king = gameData.setup.gamePlayers.find(
      (gp) => gp.teamID === teamID && gp.isKing
    )
    return king?.id
  }

  // Prepare the Battlesnake API request for each bot
  const requests = botsToQuery.map(async (bot) => {
    // Build the request body based on Battlesnake API format, excluding the perimeter and flipping the y-axis
    const youBody = turnData.playerPieces[bot.id].map((pos) => {
      const x = pos % gameData.setup.boardWidth
      const y = Math.floor(pos / gameData.setup.boardWidth)
      return adjustPosition(x, y) // Adjust the position inward and flip y-axis
    })

    const botColor = getSnakeColor(bot.id)
    const botRequestBody = {
      game: {
        id: gameID,
        ruleset: {
          name: "standard",
          version: "v1.1.15",
          settings: {
            foodSpawnChance: 15,
            minimumFood: 1,
            hazardDamagePerTurn: 14,
          },
        },
        map: "standard",
        source: "league",
        timeout: 500,
      },
      turn: turnNumber,
      board: {
        height: gameData.setup.boardHeight - 2,
        width: gameData.setup.boardWidth - 2,
        food: (turnData.food || []).map((pos) => {
          const x = pos % gameData.setup.boardWidth
          const y = Math.floor(pos / gameData.setup.boardWidth)
          return adjustPosition(x, y)
        }),
        hazards: (turnData.hazards || []).map((pos) => {
          const x = pos % gameData.setup.boardWidth
          const y = Math.floor(pos / gameData.setup.boardWidth)
          return adjustPosition(x, y)
        }),
        snakes: Object.keys(turnData.playerPieces).map((player) => {
          const body = turnData.playerPieces[player].map((pos) => {
            const x = pos % gameData.setup.boardWidth
            const y = Math.floor(pos / gameData.setup.boardWidth)
            return adjustPosition(x, y)
          })

          const gamePlayer = gameData.setup.gamePlayers.find(
            (gp) => gp.id === player
          )
          const snakeData: any = {
            id: player,
            name: player,
            health: turnData.playerHealth[player],
            body,
            head: { ...body[0] },
            length: body.length,
            latency: "111",
            shout: "",
            customizations: {
              color: getSnakeColor(player),
              head: "default",
              tail: "default",
            },
          }

          if (
            (gameData.setup.gameType === "teamsnek" ||
              gameData.setup.gameType === "kingsnek") &&
            gamePlayer?.teamID
          ) {
            snakeData.teamID = gamePlayer.teamID

            if (gameData.setup.gameType === "kingsnek") {
              snakeData.isKing = isKing(player)
              const teamKingID = getTeamKingID(gamePlayer.teamID)
              if (teamKingID) {
                snakeData.teamKingID = teamKingID
              }
            }
          }

          return snakeData
        }),
      },
      you: {
        id: bot.id,
        name: bot.id,
        health: turnData.playerHealth[bot.id],
        body: youBody,
        head: { ...youBody[0] },
        length: turnData.playerPieces[bot.id].length,
        latency: "111",
        shout: "",
        customizations: {
          color: botColor,
          head: "default",
          tail: "default",
        },
      },
    }

    try {
      // Make a POST request to the bot's URL
      logger.info(`Sending move request to bot ${bot.id} for turn ${turnNumber}`)
      const response = await axios.post(`${bot.url}/move`, botRequestBody, {
        timeout: 10000,
      })
      logger.info(`Successfully sent move request to bot ${bot.id}`, {
        response: response.data,
      })

      // Convert response to move
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

      // Create a new Move object
      const newMove: Move = {
        gameID: gameID,
        moveNumber: turnNumber,
        playerID: bot.id,
        move: moveIndex,
        timestamp: FieldValue.serverTimestamp(),
      }

      // Store the move in the Firestore collection
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

  // Execute all the requests
  await Promise.all(requests)

  logger.info(`Finished processing bot moves for game ${gameID}, turn ${turnNumber}`)
}

function convertDirectionToMoveIndex(
  direction: "up" | "down" | "left" | "right",
  headIndex: number,
  boardWidth: number,
  boardHeight: number
): number {
  const x = headIndex % boardWidth
  const y = Math.floor(headIndex / boardWidth)

  switch (direction) {
    case "up":
      return y > 0 ? (y - 1) * boardWidth + x : headIndex
    case "down":
      return y < boardHeight - 1 ? (y + 1) * boardWidth + x : headIndex
    case "left":
      return x > 0 ? y * boardWidth + (x - 1) : headIndex
    case "right":
      return x < boardWidth - 1 ? y * boardWidth + (x + 1) : headIndex
    default:
      return headIndex
  }
}
