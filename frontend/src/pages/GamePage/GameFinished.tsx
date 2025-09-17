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
import { Winner } from "@shared/types/Game"
import React, { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useGameStateContext } from "../../context/GameStateContext"
import { useUser } from "../../context/UserContext"
import EmojiRain from "./EmojiRain"

export interface PlayerResult {
  playerID: string
  name: string | undefined
  emoji: string | undefined
  score: number
  mmr: number | undefined
  mmrBump: number | undefined
}

export interface TeamResult {
  teamID: string
  teamName: string
  teamColor: string
  teamScore: number
  players: PlayerResult[]
}

const GameFinished: React.FC = () => {
  const { gameState, gameSetup, players, latestTurn, sessionName, session } =
    useGameStateContext()
  const { colour } = useUser()
  const navigate = useNavigate()
  const [sortedPlayers, setSortedPlayers] = useState<PlayerResult[]>([])
  const [sortedTeams, setSortedTeams] = useState<TeamResult[]>([])
  
  const scoringUnit = latestTurn?.scoringUnit || 'individual'
  
  useEffect(() => {
    if (!latestTurn || !gameState) return
    const winners: Winner[] = latestTurn.winners || []
    
    // Build a list of all players with their scores
    const playersWithScores = winners.map((player) => {
      const winner = players.find((w) => w.id === player.playerID)
      const playerScore = latestTurn.scores[player.playerID]

      return {
        playerID: player.playerID,
        name: winner?.name,
        emoji: winner?.emoji,
        score: playerScore,
        mmr: player.newMMR,
        mmrBump: player.mmrChange,
      }
    })

    if (scoringUnit === 'team' && gameSetup?.teams) {
      // Group players by team
      const teamResults = new Map<string, TeamResult>()
      
      winners.forEach(winner => {
        if (winner.teamID) {
          const team = gameSetup.teams?.find(t => t.id === winner.teamID)
          if (!team) return
          
          if (!teamResults.has(winner.teamID)) {
            teamResults.set(winner.teamID, {
              teamID: winner.teamID,
              teamName: team.name,
              teamColor: team.color,
              teamScore: winner.teamScore || 0,
              players: []
            })
          }
          
          const player = players.find(p => p.id === winner.playerID)
          teamResults.get(winner.teamID)?.players.push({
            playerID: winner.playerID,
            name: player?.name,
            emoji: player?.emoji,
            score: latestTurn.scores[winner.playerID],
            mmr: winner.newMMR,
            mmrBump: winner.mmrChange
          })
        }
      })
      
      // Sort teams by score
      const sorted = Array.from(teamResults.values()).sort((a, b) => b.teamScore - a.teamScore)
      setSortedTeams(sorted)
    } else {
      // Sort the players by score in descending order
      const sorted = playersWithScores.sort((a, b) => b.score - a.score)
      setSortedPlayers(sorted)
    }
  }, [players, latestTurn, scoringUnit, gameSetup])
  
  // Ensure gameState and players are available
  if (!gameState || !players || !latestTurn) return null

  // Determine winner and draw based on scoring unit
  let draw = false
  let topWinner: { name?: string, emoji?: string, color?: string } | null = null
  
  if (scoringUnit === 'team' && sortedTeams.length > 0) {
    draw = sortedTeams.length > 1 && sortedTeams[0].teamScore === sortedTeams[1].teamScore
    if (!draw) {
      topWinner = { 
        name: sortedTeams[0].teamName,
        emoji: '🏆',
        color: sortedTeams[0].teamColor
      }
    }
  } else if (sortedPlayers.length > 0) {
    draw = sortedPlayers.length > 1 && sortedPlayers[0].score === sortedPlayers[1].score
    if (!draw) {
      topWinner = { 
        name: sortedPlayers[0].name,
        emoji: sortedPlayers[0].emoji
      }
    }
  }

  // If there are no winners, display a message accordingly
  const unFinished = latestTurn.winners.length === 0
  if (unFinished) return null

  return (
    <>
      <Box
        sx={{
          position: "relative",
          zIndex: 9999999, // Ensures this section stays on top
          backgroundColor: "white", // Blocks out the EmojiRain
          padding: 2,
          border: "2px solid black",
          my: 2,
        }}
      >
        {draw ? (
          <>
            <Typography
              variant="h5"
              color="primary"
              sx={{ my: 2, textAlign: "left" }}
            >
              It's a draw. Lame.
            </Typography>
          </>
        ) : (
          <>
            <Typography
              variant="h5"
              color="primary"
              sx={{ my: 2, textAlign: "left" }}
              style={topWinner?.color ? { color: topWinner.color } : {}}
            >
              {topWinner?.name} won. Nice.
            </Typography>
          </>
        )}
        
        {/* Team-based or Individual Results Table */}
        {scoringUnit === 'team' && sortedTeams.length > 0 ? (
          // Team-based results
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
                  <TableCell align="left">
                    <strong>Players</strong>
                  </TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {sortedTeams.map((team, index) => (
                  <TableRow key={team.teamID} style={{ backgroundColor: team.teamColor }}>
                    <TableCell align="left">
                      {index + 1}. {team.teamName}
                    </TableCell>
                    <TableCell align="right">{team.teamScore}</TableCell>
                    <TableCell align="left">
                      {team.players.map(p => `${p.emoji} ${p.name}`).join(', ')}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        ) : (
          // Individual results
          <TableContainer sx={{ margin: "auto", my: 2 }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell align="left">
                    <strong>Player</strong>
                  </TableCell>
                  <TableCell align="right">
                    <strong>Score</strong>
                  </TableCell>
                  <TableCell align="right">
                    <strong>MMR</strong>
                  </TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {sortedPlayers.map((player, index) => (
                  <TableRow key={player.playerID}>
                    <TableCell align="left">
                      {index + 1}. {player.emoji} {player.name}
                    </TableCell>
                    <TableCell align="right">{player.score}</TableCell>
                    <TableCell align="right">{player.mmr} ({player.mmrBump})</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
        {/* "Play Again?" Button */}
        <Button
          sx={{ my: 2, bgcolor: colour }}
          variant="contained"
          fullWidth
          onClick={() =>
            navigate(`/session/${sessionName}/${session?.latestGameID}`)
          }
        >
          That was fun. Again.
        </Button>
      </Box>

      {/* Emoji Rain Effect for Winner */}
      {topWinner && !draw && topWinner.emoji && (
        <EmojiRain
          emoji={topWinner.emoji}
        />
      )}
    </>
  )
}

export default GameFinished
