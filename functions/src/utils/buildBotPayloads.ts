import { Bot, GameState, Human, Winner } from "../types/Game"

/**
 * Shared move/end payload builders. Used by both the HTTP bot dispatcher and
 * the WebSocket bot dispatcher so that the request shape is identical
 * regardless of transport.
 */

export interface PlayerInfoMap {
  get(id: string): { name: string; emoji: string } | undefined
}

export function buildPlayerInfoMap(
  allBots: Bot[],
  humans: Map<string, Human>
): Map<string, { name: string; emoji: string }> {
  const map = new Map<string, { name: string; emoji: string }>()
  for (const bot of allBots) {
    map.set(bot.id, { name: bot.name, emoji: bot.emoji })
  }
  for (const [id, human] of humans.entries()) {
    map.set(id, { name: human.name, emoji: human.emoji })
  }
  return map
}

export interface MovePayloadContext {
  gameID: string
  turnNumber: number
  turnExpiryTime?: number
  gameData: GameState
  bot: Bot
  allBots: Bot[]
  playerInfoMap: Map<string, { name: string; emoji: string }>
}

const adjustPosition = (
  x: number,
  y: number,
  boardHeight: number
): { x: number; y: number } => {
  return { x: x - 1, y: boardHeight - y - 2 }
}

const getSnakeColor = (
  playerID: string,
  gameData: GameState,
  allBots: Bot[]
): string => {
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
  const botInfo = allBots.find((b) => b.id === playerID)
  return botInfo?.colour || "#FF0000"
}

const isKingFor = (playerID: string, gameData: GameState): boolean => {
  if (gameData.setup.gameType !== "kingsnek") return false
  const gp = gameData.setup.gamePlayers.find((g) => g.id === playerID)
  return gp?.isKing || false
}

const getTeamKingID = (
  teamID: string,
  gameData: GameState
): string | undefined => {
  if (gameData.setup.gameType !== "kingsnek") return undefined
  const king = gameData.setup.gamePlayers.find(
    (gp) => gp.teamID === teamID && gp.isKing
  )
  return king?.id
}

export function buildMovePayload(ctx: MovePayloadContext): unknown {
  const { gameID, turnNumber, turnExpiryTime, gameData, bot, allBots, playerInfoMap } = ctx
  const turnData = gameData.turns[turnNumber]
  const boardWidth = gameData.setup.boardWidth
  const boardHeight = gameData.setup.boardHeight

  const youBody = turnData.playerPieces[bot.id].map((pos) => {
    const x = pos % boardWidth
    const y = Math.floor(pos / boardWidth)
    return adjustPosition(x, y, boardHeight)
  })

  const botColor = getSnakeColor(bot.id, gameData, allBots)
  const foodSpawnRate = gameData.setup.foodSpawnRate ?? 0.5
  const foodSpawnChance = (foodSpawnRate / 5) * 100

  return {
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
      height: boardHeight - 2,
      width: boardWidth - 2,
      food: (turnData.food || []).map((pos) => {
        const x = pos % boardWidth
        const y = Math.floor(pos / boardWidth)
        return adjustPosition(x, y, boardHeight)
      }),
      hazards: (turnData.hazards || []).map((pos) => {
        const x = pos % boardWidth
        const y = Math.floor(pos / boardWidth)
        return adjustPosition(x, y, boardHeight)
      }),
      ...(turnData.fertileTiles ? {
        fertileTiles: turnData.fertileTiles.map((pos) => {
          const x = pos % boardWidth
          const y = Math.floor(pos / boardWidth)
          return adjustPosition(x, y, boardHeight)
        }),
      } : {}),
      ...(turnData.invulnerabilityPotions?.length ? {
        invulnerabilityPotions: turnData.invulnerabilityPotions.map((pos) => {
          const x = pos % boardWidth
          const y = Math.floor(pos / boardWidth)
          return adjustPosition(x, y, boardHeight)
        }),
      } : {}),
      snakes: Object.keys(turnData.playerPieces).map((player) => {
        const body = turnData.playerPieces[player].map((pos) => {
          const x = pos % boardWidth
          const y = Math.floor(pos / boardWidth)
          return adjustPosition(x, y, boardHeight)
        })

        const gamePlayer = gameData.setup.gamePlayers.find(
          (gp) => gp.id === player
        )
        const playerInfo = playerInfoMap.get(player)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
            color: getSnakeColor(player, gameData, allBots),
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
            snakeData.isKing = isKingFor(player, gameData)
            const teamKingID = getTeamKingID(gamePlayer.teamID, gameData)
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
      name: bot.name,
      emoji: bot.emoji,
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
      invulnerabilityLevel: turnData.playerInvulnerabilityLevel?.[bot.id] ?? 0,
    },
  }
}

export function buildEndPayload(
  gameID: string,
  finalTurnNumber: number,
  gameState: GameState,
  finalScores: { [playerID: string]: number },
  winners: Winner[],
  bot: Bot,
): unknown {
  const foodSpawnRate = gameState.setup.foodSpawnRate ?? 0.5
  const foodSpawnChance = (foodSpawnRate / 5) * 100
  return {
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
}

export function convertDirectionToMoveIndex(
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
