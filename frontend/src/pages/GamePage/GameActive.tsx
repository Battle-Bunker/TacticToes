import React from "react"

import { Alert, Stack, Typography } from "@mui/material"

import { useGameStateContext } from "../../context/GameStateContext"
import GameGrid from "./GameGrid"

const GameActive: React.FC = () => {
  const {
    gameState,
    timeRemaining,
    latestMoveStatus,
    connectivityStatus,
    queryTimedOut,
  } = useGameStateContext()

  if (!gameState) return null

  const currentTurn = gameState.turns?.[gameState.turns.length - 1]
  const showTeamClusterFallback = Boolean(currentTurn?.teamClusterFallback)

  if (!currentTurn) {
    return (
      <Stack spacing={2} pt={2}>
        <Alert severity="info">Waiting for game data.</Alert>
      </Stack>
    )
  }

  const gameOver = currentTurn.winners.length > 0

  const movedCount =
    latestMoveStatus?.moveNumber === gameState.turns.length - 1
      ? latestMoveStatus.movedPlayerIDs.length
      : 0
  const aliveCount = currentTurn.alivePlayers.length

  return (
    <Stack spacing={2} pt={2}>
      {showTeamClusterFallback && (
        <Alert severity="warning">
          Team cluster spawn failed to fit all players. Standard spawn was used.
        </Alert>
      )}
      {connectivityStatus === "disconnected" && (
        <Alert severity="error">
          You have no internet. Seek higher ground.
        </Alert>
      )}
      {queryTimedOut && connectivityStatus !== "disconnected" && (
        <Alert severity="error">Your internet is slow. Get good.</Alert>
      )}

      <Typography>
        Turn {gameState.turns.length}.{" "}
        {gameOver
          ? "Game over"
          : `${Math.max(0, timeRemaining).toFixed(0)} seconds left.`}
      </Typography>

      {!gameOver && (
        <Typography variant="body2" color="text.secondary">
          {movedCount} of {aliveCount} units have moved.
        </Typography>
      )}

      {/* The board being watched, its turn controls, and its scoreboard. */}
      <GameGrid />
    </Stack>
  )
}

export default GameActive
