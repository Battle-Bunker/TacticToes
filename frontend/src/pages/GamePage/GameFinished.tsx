import {
  Box,
  Button,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material"
import React from "react"
import { useNavigate } from "react-router-dom"
import { useGameStateContext } from "../../context/GameStateContext"

interface TeamResult {
  teamID: string
  teamName: string
  teamColor: string
  teamScore: number
  snakeNames: string[]
  mmr?: number
  mmrChange?: number
}

const GameFinished: React.FC = () => {
  const { gameState, latestTurn, sessionName, session } = useGameStateContext()
  const navigate = useNavigate()

  if (!gameState || !latestTurn) return null

  const winners = latestTurn.winners
  if (winners.length === 0) return null

  const { teams, gamePlayers } = gameState.setup

  // Every team gets a results row; winners additionally carry MMR updates.
  const teamResults: TeamResult[] = teams.map((team) => {
    const winner = winners.find((w) => w.teamID === team.id)
    return {
      teamID: team.id,
      teamName: team.name,
      teamColor: team.color,
      teamScore: winner?.teamScore ?? latestTurn.teamScores?.[team.id] ?? 0,
      snakeNames: gamePlayers
        .filter((gp) => gp.teamID === team.id)
        .map((gp) => `${team.name} ${gp.letter}`),
      mmr: winner?.newMMR,
      mmrChange: winner?.mmrChange,
    }
  })

  const sortedTeams = teamResults.sort((a, b) => b.teamScore - a.teamScore)

  const draw =
    sortedTeams.length > 1 &&
    sortedTeams[0].teamScore === sortedTeams[1].teamScore
  const winningTeam = !draw && sortedTeams.length > 0 ? sortedTeams[0] : null

  return (
    <Box
      sx={{
        backgroundColor: "white",
        padding: 2,
        border: "2px solid black",
        my: 2,
      }}
    >
      {draw ? (
        <Typography variant="h5" color="primary" sx={{ my: 2, textAlign: "left" }}>
          It's a draw. Lame.
        </Typography>
      ) : (
        winningTeam && (
          <Typography
            variant="h5"
            sx={{ my: 2, textAlign: "left", color: winningTeam.teamColor }}
          >
            🏆 {winningTeam.teamName} won. Nice.
          </Typography>
        )
      )}

      <TableContainer sx={{ margin: "auto", my: 2 }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell align="left">
                <strong>Team</strong>
              </TableCell>
              <TableCell align="right">
                <strong>Score</strong>
              </TableCell>
              <TableCell align="right">
                <strong>MMR</strong>
              </TableCell>
              <TableCell align="left">
                <strong>Snakes</strong>
              </TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {sortedTeams.map((team, index) => (
              <TableRow
                key={team.teamID}
                sx={{ backgroundColor: team.teamColor }}
              >
                <TableCell align="left">
                  {index + 1}. {team.teamName}
                </TableCell>
                <TableCell align="right">{team.teamScore}</TableCell>
                <TableCell align="right">
                  {team.mmr !== undefined
                    ? `${team.mmr} (${team.mmrChange ?? 0})`
                    : "-"}
                </TableCell>
                <TableCell align="left">{team.snakeNames.join(", ")}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>

      <Button
        sx={{ my: 2 }}
        variant="contained"
        fullWidth
        onClick={() =>
          navigate(`/session/${sessionName}/${session?.latestGameID}`)
        }
      >
        That was fun. Again.
      </Button>
    </Box>
  )
}

export default GameFinished
