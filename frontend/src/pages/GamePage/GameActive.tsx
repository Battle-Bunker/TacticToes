import React from "react"

import {
  Alert,
  Box,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material"

import { useGameStateContext } from "../../context/GameStateContext"
import { unitLabel } from "../../utils/snakeLabel"
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

  const { teams, gamePlayers } = gameState.setup
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

      {/* Game Grid */}
      <GameGrid />

      {/* Team score table */}
      <TableContainer sx={{ my: 2, width: "100%" }}>
        <Table size="small" sx={{ borderCollapse: "collapse" }}>
          <TableHead>
            <TableRow>
              <TableCell>Team</TableCell>
              <TableCell align="right">Score</TableCell>
              <TableCell align="left">Units</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {teams.map((team) => {
              const teamScore = currentTurn.teamScores?.[team.id] || 0
              const teamSnakes = gamePlayers.filter(
                (gp) => gp.teamID === team.id,
              )

              return (
                <TableRow key={team.id} sx={{ backgroundColor: team.color }}>
                  <TableCell>{team.name}</TableCell>
                  <TableCell align="right">{teamScore}</TableCell>
                  <TableCell align="left">
                    {teamSnakes.map((snake) => {
                      const alive = currentTurn.alivePlayers.includes(snake.id)
                      const health = currentTurn.playerHealth[snake.id] ?? 0
                      const length =
                        currentTurn.playerPieces[snake.id]?.length ?? 0
                      const unitType =
                        currentTurn.unitTypes?.[snake.id] ??
                        snake.unitType ??
                        "snake"
                      const maxHealth =
                        gameState.setup.maxHealthPerUnit?.[unitType] ?? 100
                      const fraction = Math.max(
                        0,
                        Math.min(1, health / maxHealth),
                      )
                      const fillColor =
                        fraction < 0.1
                          ? "#e53935"
                          : fraction < 0.25
                            ? "#fb8c00"
                            : "#43a047"

                      return (
                        <Box
                          key={snake.id}
                          component="span"
                          sx={{
                            mr: 1,
                            whiteSpace: "nowrap",
                            textDecoration: alive ? "none" : "line-through",
                            opacity: alive ? 1 : 0.5,
                          }}
                        >
                          {unitLabel(team, snake, currentTurn.unitTypes?.[snake.id])}
                          {alive && (
                            <>
                              {" "}
                              <Box
                                component="span"
                                sx={{
                                  display: "inline-block",
                                  verticalAlign: "middle",
                                  width: 48,
                                  height: 8,
                                  backgroundColor: "rgba(0, 0, 0, 0.5)",
                                  borderRadius: "2px",
                                  overflow: "hidden",
                                  mr: 0.5,
                                }}
                              >
                                <Box
                                  component="span"
                                  sx={{
                                    display: "block",
                                    width: `${fraction * 100}%`,
                                    height: "100%",
                                    backgroundColor: fillColor,
                                  }}
                                />
                              </Box>
                              {`${health} ×${length}`}
                            </>
                          )}
                        </Box>
                      )
                    })}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </TableContainer>
    </Stack>
  )
}

export default GameActive
