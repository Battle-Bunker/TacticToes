import axios from "axios"
import * as admin from "firebase-admin"
import { FieldValue } from "firebase-admin/firestore"
import * as logger from "firebase-functions/logger"
import { Bot, GameState, Human, Move, Winner } from "../types/Game"

/**
 * Sends move requests to all active bots for a specific turn.
 * This function fetches the current game state and sends Battlesnake API requests
 * to each bot, then records their moves.
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
  const botByID = new Map<string, Bot>()
  for (const bot of allBots) {
    botByID.set(bot.id, bot)
  }

  // Resolve each bot GamePlayer to its underlying bot record. Each entry
  // (clone or original) gets its own /move request — they share an
  // endpoint URL but have a distinct in-game id, name, and emoji.
  type BotEntry = { gamePlayer: typeof botsInTurn[number]; bot: Bot }
  const botEntries: BotEntry[] = botsInTurn
    .map((gamePlayer) => {
      const underlyingID = gamePlayer.botRef ?? gamePlayer.id
      const bot = botByID.get(underlyingID)
      if (!bot) return null
      return { gamePlayer, bot }
    })
    .filter((e): e is BotEntry => e !== null)

  if (botEntries.length === 0) {
    logger.info(
      `No bots found in the bots collection that match the game players for turn ${turnNumber}`
    )
    return
  }

  const humanPlayerIds = gameData.setup.gamePlayers
    .filter((gp) => gp.type === "human")
    .map((gp) => gp.id)

  // Build playerInfoMap from gamePlayers first (so clone displayName /
  // displayEmoji overrides win), falling back to the underlying bot record
  // for the original instance, then layer human users on top.
  const playerInfoMap = new Map<string, { name: string; emoji: string }>()
  for (const gp of gameData.setup.gamePlayers) {
    if (gp.type !== "bot") continue
    const underlyingID = gp.botRef ?? gp.id
    const bot = botByID.get(underlyingID)
    const name = gp.displayName ?? bot?.name ?? gp.id
    const emoji = gp.displayEmoji ?? bot?.emoji ?? ""
    playerInfoMap.set(gp.id, { name, emoji })
  }

  if (humanPlayerIds.length > 0) {
    const usersCollection = admin.firestore().collection("users")
    const humanFetches = humanPlayerIds.map((id) => usersCollection.doc(id).get())
    const humanDocs = await Promise.all(humanFetches)
    for (const doc of humanDocs) {
      if (doc.exists) {
        const data = doc.data() as Human
        playerInfoMap.set(doc.id, { name: data.name, emoji: data.emoji })
      }
    }
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
    // Fall back to bot color if not in team mode or team not found.
    // Resolve clones via botRef so they inherit the underlying bot's colour.
    const gp = gameData.setup.gamePlayers.find((p) => p.id === playerID)
    const underlyingID = gp?.botRef ?? playerID
    const botInfo = botByID.get(underlyingID)
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

  // Prepare the Battlesnake API request for each bot GamePlayer entry.
  // For Team Snek clones, multiple entries share `bot` (same URL) but each
  // has a distinct in-game id, so each gets its own /move request and its
  // own recorded move under its in-game id.
  const requests = botEntries.map(async ({ gamePlayer, bot }) => {
    const playerID = gamePlayer.id
    // Build the request body based on Battlesnake API format, excluding the perimeter and flipping the y-axis
    const youBody = turnData.playerPieces[playerID].map((pos) => {
      const x = pos % gameData.setup.boardWidth
      const y = Math.floor(pos / gameData.setup.boardWidth)
      return adjustPosition(x, y) // Adjust the position inward and flip y-axis
    })

    const botColor = getSnakeColor(playerID)
    const youInfo = playerInfoMap.get(playerID)
    const foodSpawnRate = gameData.setup.foodSpawnRate ?? 0.5
    const foodSpawnChance = (foodSpawnRate / 5) * 100

    const botRequestBody = {
      game: {
        id: gameID,
        ruleset: {
          name: gameData.setup.gameType,
          settings: {
            foodSpawnChance,
            foodSpawnRate,
            invulnerabilityPotionSpawnRate: gameData.setup.invulnerabilityPotionSpawnRate ?? 0.15,
            minimumFood: 0,
            hazardDamagePerTurn: 100,
          },
        },
        map: "standard",
        timeout: gameData.setup.maxTurnTime * 1000,
        ...(turnExpiryTime !== undefined && { turnExpiryTime }),
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
        ...(turnData.fertileTiles ? {
          fertileTiles: turnData.fertileTiles.map((pos) => {
            const x = pos % gameData.setup.boardWidth
            const y = Math.floor(pos / gameData.setup.boardWidth)
            return adjustPosition(x, y)
          }),
        } : {}),
        ...(turnData.invulnerabilityPotions?.length ? {
          invulnerabilityPotions: turnData.invulnerabilityPotions.map((pos) => {
            const x = pos % gameData.setup.boardWidth
            const y = Math.floor(pos / gameData.setup.boardWidth)
            return adjustPosition(x, y)
          }),
        } : {}),
        snakes: Object.keys(turnData.playerPieces).map((player) => {
          const body = turnData.playerPieces[player].map((pos) => {
            const x = pos % gameData.setup.boardWidth
            const y = Math.floor(pos / gameData.setup.boardWidth)
            return adjustPosition(x, y)
          })

          const gamePlayer = gameData.setup.gamePlayers.find(
            (gp) => gp.id === player
          )
          const playerInfo = playerInfoMap.get(player)
          const snakeData: any = {
            id: player,
            name: playerInfo?.name ?? player,
            emoji: playerInfo?.emoji ?? "",
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
            invulnerabilityLevel: turnData.playerInvulnerabilityLevel?.[player] ?? 0,
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
        id: playerID,
        name: youInfo?.name ?? bot.name,
        emoji: youInfo?.emoji ?? bot.emoji,
        health: turnData.playerHealth[playerID],
        body: youBody,
        head: { ...youBody[0] },
        length: turnData.playerPieces[playerID].length,
        latency: "111",
        shout: "",
        customizations: {
          color: botColor,
          head: "default",
          tail: "default",
        },
        invulnerabilityLevel: turnData.playerInvulnerabilityLevel?.[playerID] ?? 0,
      },
    }

    try {
      const DEFAULT_TIMEOUT = 10000
      const MIN_TIMEOUT = 500
      const moveTimeout = turnExpiryTime
        ? Math.max(MIN_TIMEOUT, turnExpiryTime - Date.now())
        : DEFAULT_TIMEOUT

      // Make a POST request to the bot's URL
      logger.info(`Sending move request to bot ${playerID} (endpoint ${bot.id}) for turn ${turnNumber} (timeout: ${moveTimeout}ms)`)
      const response = await axios.post(`${bot.url}/move`, botRequestBody, {
        timeout: moveTimeout,
      })
      logger.info(`Successfully sent move request to bot ${playerID}`, {
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
        turnData.playerPieces[playerID][0],
        gameData.setup.boardWidth,
        gameData.setup.boardHeight
      )

      // Create a new Move object
      const newMove: Move = {
        gameID: gameID,
        moveNumber: turnNumber,
        playerID: playerID,
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
          movedPlayerIDs: FieldValue.arrayUnion(playerID),
        })

      logger.info(`Successfully recorded move for bot ${playerID}`, {
        newMove,
      })
    } catch (error) {
      logger.error(`Error sending move request to bot ${playerID}`, error)
    }
  })

  // Execute all the requests
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

  // Dedupe by underlying bot id so each clone group sends exactly one /end
  // request to the shared endpoint, matching pre-clones behaviour.
  const underlyingIDsInGame = new Set(
    botPlayers.map((p) => p.botRef ?? p.id)
  )
  const botsToNotify = allBots.filter((bot) => underlyingIDsInGame.has(bot.id))

  if (botsToNotify.length === 0) {
    logger.info(
      `[notifyBotsGameEnd] No matching bots found in bots collection for game ${gameID}`
    )
    return
  }

  // Dedupe by URL too, in case multiple bot docs share an endpoint.
  const seenUrls = new Set<string>()
  const uniqueBotsToNotify = botsToNotify.filter((bot) => {
    if (seenUrls.has(bot.url)) return false
    seenUrls.add(bot.url)
    return true
  })

  const foodSpawnRate = gameState.setup.foodSpawnRate ?? 0.5
  const foodSpawnChance = (foodSpawnRate / 5) * 100

  const requests = uniqueBotsToNotify.map(async (bot) => {
    const endPayload = {
      game: {
        id: gameID,
        ruleset: {
          name: gameState.setup.gameType,
          settings: {
            foodSpawnChance,
            foodSpawnRate,
            invulnerabilityPotionSpawnRate:
              gameState.setup.invulnerabilityPotionSpawnRate ?? 0.15,
            minimumFood: 0,
            hazardDamagePerTurn: 100,
          },
        },
        map: "standard",
        timeout: gameState.setup.maxTurnTime * 1000,
      },
      turn: finalTurnNumber,
      scores: finalScores,
      winners: winners.map((w) => ({
        playerID: w.playerID,
        score: w.score,
        ...(w.teamID ? { teamID: w.teamID } : {}),
        ...(w.teamScore !== undefined ? { teamScore: w.teamScore } : {}),
      })),
      you: {
        id: bot.id,
        name: bot.id,
      },
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
