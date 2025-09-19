// src/pages/GamePage/components/GameSetup.tsx

import { arrayRemove, arrayUnion, doc, updateDoc } from "firebase/firestore"
import React, { useEffect, useState } from "react"
import { useUser } from "../../context/UserContext"
import { db } from "../../firebaseConfig"
import { TeamConfiguration } from "../../components/TeamConfiguration"
import { PlayerConfiguration } from "../../components/PlayerConfiguration"
import { BotHealthProvider, useBotHealth } from "../../context/BotHealthContext"

import {
  Box,
  Button,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  SelectChangeEvent,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material"
import { GamePlayer, GameType, Team } from "@shared/types/Game"
import { useGameStateContext } from "../../context/GameStateContext"
import { getRulesComponent } from "./RulesDialog"

// Define the board size mapping
const BOARD_SIZE_MAPPING = {
  small: { width: 11, height: 11 },
  medium: { width: 13, height: 13 },
  large: { width: 17, height: 17 },
}

type BoardSize = keyof typeof BOARD_SIZE_MAPPING

const GameSetup: React.FC = () => {
  const { userID, colour } = useUser()
  const {
    gameSetup,
    players,
    bots,
    gameType,
    setGameType,
    sessionName,
    gameID,
    gameState,
  } = useGameStateContext()

  const [secondsPerTurn, setSecondsPerTurn] = useState<string>("10")
  const [RulesComponent, setRulesComponent] = useState<React.FC | null>(null)
  const [boardSize, setBoardSize] = useState<BoardSize>("medium")
  const [teams, setTeams] = useState<Team[]>(gameSetup?.teams || [])
  const [maxTurns, setMaxTurns] = useState<number>(gameSetup?.maxTurns || 100)
  
  const { getBotStatus } = useBotHealth()

  const gameDocRef = doc(db, "sessions", sessionName, "setups", gameID)

  // Inject the shake animation styles once the component mounts
  React.useEffect(() => {
    addStyles()
  }, [])

  // Update local state when gameSetup changes
  useEffect(() => {
    if (gameSetup) {
      // Update board size
      const currentSize = Object.entries(BOARD_SIZE_MAPPING).find(
        ([, dimensions]) =>
          dimensions.width === gameSetup.boardWidth &&
          dimensions.height === gameSetup.boardHeight,
      )
      if (currentSize) {
        setBoardSize(currentSize[0] as BoardSize)
      }

      // Update game type
      if (gameSetup.gameType) {
        setGameType(gameSetup.gameType)
      }

      // Update turn time
      setSecondsPerTurn(`${gameSetup.maxTurnTime}`)

      //  Update max turns
      if (gameSetup.maxTurns !== undefined) {
        setMaxTurns(gameSetup.maxTurns)
      }

      //  Update teams
      if (gameSetup.teams) {
        setTeams(gameSetup.teams)
      }
    }
  }, [gameSetup, setGameType])

  // Start game
  const handleReady = async () => {
    await updateDoc(gameDocRef, {
      playersReady: arrayUnion(userID),
    })
  }

  const handleAddBot = async (botID: string) => {
    // Check if bot is dead before adding to game
    const botHealthStatus = getBotStatus(botID);
    if (botHealthStatus === 'dead') {
      console.log(`Cannot add bot ${botID} to game - bot is dead`);
      return;
    }

    const bot: GamePlayer = {
      id: botID,
      type: "bot",
    }

    await updateDoc(gameDocRef, {
      gamePlayers: arrayUnion(bot),
    })
  }

  // Start game
  const handleStart = async () => {
    await updateDoc(gameDocRef, {
      startRequested: true,
    })
  }

  // Kick a player by removing their playerID from the playerIDs field
  const handlePlayerKick = async (playerID: string, type: "bot" | "human") => {
    const player: GamePlayer = {
      id: playerID,
      type: type,
    }
    await updateDoc(gameDocRef, {
      gamePlayers: arrayRemove(player),
        })
  }

  // Handle team assignment for a player
  const handleTeamChange = async (playerID: string, teamID: string) => {
    if (!gameSetup) return
    
    // Check if this is a dead bot trying to be assigned to a team
    const player = gameSetup.gamePlayers.find(p => p.id === playerID);
    if (player?.type === 'bot') {
      const botStatus = getBotStatus(playerID);
      if (botStatus === 'dead') {
        console.log(`Cannot assign dead bot ${playerID} to team`);
        return;
      }
    }
    
    const updatedGamePlayers = gameSetup.gamePlayers.map((player) =>
      player.id === playerID ? { ...player, teamID } : player
    )
    
    await updateDoc(gameDocRef, {
      gamePlayers: updatedGamePlayers,
    })
  }

  // Handle team configuration changes
  const handleTeamsChange = async (newTeams: Team[]) => {
    await updateDoc(gameDocRef, {
      teams: newTeams,
    })
    setTeams(newTeams)
  }

  const handlePlayerTeamKick = async (playerID: string, teamID: string) => {
   if (!gameSetup) return;

    const playerIndex = gameSetup.gamePlayers.findIndex(
      (player: GamePlayer) => player.id === playerID && player.teamID === teamID
    );
  
    if (playerIndex === -1) {
     console.log("Player not found.")
      return;
    }
  
    //  Use null instead of deleteField()
    const updatedGamePlayers = gameSetup.gamePlayers.map((player, index) => 
      index === playerIndex 
        ? { ...player, teamID: null }  //  Set to null
        : player
    );
  
    await updateDoc(gameDocRef, {
      gamePlayers: updatedGamePlayers
    });
  };

  // Handle max turns configuration
  const handleMaxTurnsChange = async (newMaxTurns: number) => {
    await updateDoc(gameDocRef, {
      maxTurns: newMaxTurns,
    })
    setMaxTurns(newMaxTurns)
  }

  // Handler for selecting game type
  const handleGameTypeChange = async (event: SelectChangeEvent<GameType>) => {

    const selectedGameType = event.target.value as GameType
    setGameType(selectedGameType)

    // Update Firestore when game type is selected
    if (!gameSetup?.started) {
      await updateDoc(gameDocRef, { gameType: selectedGameType })
    }
  }

  // Handler for selecting board size
  const handleBoardSizeChange = async (event: SelectChangeEvent<BoardSize>) => {
    const selectedBoardSize = event.target.value as BoardSize
    setBoardSize(selectedBoardSize)

    const { width, height } = BOARD_SIZE_MAPPING[selectedBoardSize]

    // Update Firestore when board size is selected
    if (!gameSetup?.started) {
      await updateDoc(gameDocRef, {
        boardWidth: width,
        boardHeight: height,
      })
    }
  }

  useEffect(() => {
    setRulesComponent(() => getRulesComponent(gameSetup?.gameType))
  }, [gameSetup?.gameType, gameSetup])

  if (gameState || !gameSetup) return null

  const { started, playersReady } = gameSetup
  const notReadyPlayers = gameSetup.gamePlayers
    .filter((gamePlayer) => gamePlayer.type === "human")
    .filter((player) => !gameSetup.playersReady.includes(player.id))
    .map(
      (notReadyPlayer) =>
        players.find((player) => player.id === notReadyPlayer.id)?.name,
    )

  // Validation for Team Snek games
  const canStartGame = () => {
    if (gameType !== 'teamsnek') return true;
    
    const populatedTeams = teams.filter(team => 
      gameSetup.gamePlayers.some(player => player.teamID === team.id)
    );
    
    return populatedTeams.length >= 2;
  };

  const getTeamValidationMessage = () => {
    if (gameType !== 'teamsnek') return '';
    
    const populatedTeams = teams.filter(team => 
      gameSetup.gamePlayers.some(player => player.teamID === team.id)
    );
    
    if (populatedTeams.length === 0) {
      return 'Assign players to teams before starting the game';
    } else if (populatedTeams.length === 1) {
      return 'At least 2 teams must have players before starting the game';
    }
    
    return '';
  };

  return (
    <Stack spacing={2} pt={2}>
      {/* Ready Section */}
      {!gameSetup.gamePlayers
        .filter((gamePlayer) => gamePlayer.type === "human")
        .map((human) => human.id)
        .every((player) => gameSetup.playersReady.includes(player)) ? (
        <>
          <Button
            disabled={
              started ||
              gameSetup.boardWidth < 5 ||
              gameSetup.boardWidth > 20 ||
              parseInt(secondsPerTurn) <= 0 ||
              gameSetup.playersReady.includes(userID)
            }
            onClick={handleReady}
            sx={{ backgroundColor: colour, height: "70px", fontSize: "32px" }}
            fullWidth
          >
            {gameSetup.playersReady.includes(userID) ? `Waiting` : "I'm ready!"}
          </Button>
          {gameType === 'teamsnek' && !canStartGame() && getTeamValidationMessage() && (
            <Typography color="error" sx={{ textAlign: 'center', mt: 1 }}>
              {getTeamValidationMessage()}
            </Typography>
          )}
        </>
      ) : (
        <>
          <Button
            disabled={gameSetup.startRequested || !canStartGame()}
            onClick={handleStart}
            sx={{ 
              backgroundColor: canStartGame() ? colour : '#ccc', 
              height: "70px", 
              fontSize: "32px",
              '&:hover': {
                backgroundColor: canStartGame() ? colour : '#ccc'
              }
            }}
            className={canStartGame() ? "shake" : ""}
            fullWidth
          >
            {gameSetup.startRequested ? "Game starting" : "Start game"}
          </Button>
          {!canStartGame() && getTeamValidationMessage() && (
            <Typography color="error" sx={{ textAlign: 'center', mt: 1 }}>
              {getTeamValidationMessage()}
            </Typography>
          )}
        </>
      )}
      {gameSetup.playersReady.includes(userID) &&
        notReadyPlayers.length > 0 && (
          <Typography color="error">
            Not ready: {notReadyPlayers.join(", ")}
          </Typography>
        )}
      <Box sx={{ display: "flex", gap: 2 }}>
        {/* Game Type Dropdown */}
        <FormControl variant="outlined" sx={{ flex: 1 }}>
          <InputLabel id="game-type-label">Game Type</InputLabel>
          <Select
            labelId="game-type-label"
            value={gameType}
            onChange={handleGameTypeChange}
            disabled={started}
            label="Game Type"
          >
            <MenuItem value="snek">Snek</MenuItem>
            <MenuItem value="teamsnek">Team Snek</MenuItem>
            <MenuItem value="connect4">Connect 4</MenuItem>
            <MenuItem value="tactictoes">Tactic Toes</MenuItem>
            <MenuItem value="longboi">Long Boi</MenuItem>
            <MenuItem value="reversi">Othello</MenuItem>
            <MenuItem value="colourclash">Colour Clash</MenuItem>
          </Select>
        </FormControl>

        {/* Game Size */}
        <FormControl variant="outlined" sx={{ flex: 1 }}>
          <InputLabel id="board-size-label">Size</InputLabel>
          <Select
            labelId="board-size-label"
            value={boardSize}
            onChange={handleBoardSizeChange}
            disabled={started}
            label="Board Size"
          >
            <MenuItem value="small">Small</MenuItem>
            <MenuItem value="medium">Medium</MenuItem>
            <MenuItem value="large">Large</MenuItem>
          </Select>
        </FormControl>
      </Box>

      {/* Game rules */}
      <FormControl fullWidth variant="outlined" sx={{ mt: 2 }}>
        <InputLabel shrink sx={{ backgroundColor: "white", px: 1 }}>
          Rules
        </InputLabel>
        <Box
          sx={{
            border: "2px solid black",
            padding: 2,
            borderRadius: "0px",
            minHeight: "56px",
            display: "flex",
            alignItems: "start",
            flexDirection: "column",
            fontFamily: "monospace",
            whiteSpace: "pre-wrap",
          }}
        >
          {RulesComponent && <RulesComponent />}
        </Box>
      </FormControl>
      {/* Bots List */}
      {bots.length > 0 && (
        <FormControl fullWidth variant="outlined" sx={{ mt: 2 }}>
          <InputLabel shrink sx={{ backgroundColor: "white", px: 1 }}>
            Available Bots
          </InputLabel>
          <Box
            sx={{
              border: "2px solid black",
              padding: 2,
              borderRadius: "0px",
              minHeight: "56px",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <Box sx={{ display: "flex", flexWrap: "wrap", gap: 2 }}>
              {bots.map((bot) => {
                const botStatus = getBotStatus(bot.id);
                const isDead = botStatus === 'dead';
                
                return (
                  <Button
                    key={bot.name}
                    disabled={isDead}
                    sx={{
                      backgroundColor: isDead ? '#ccc' : bot.colour,
                      opacity: isDead ? 0.6 : 1,
                    }}
                    onClick={() => handleAddBot(bot.id)}
                    title={isDead ? 'Bot is dead and cannot be added to game' : ''}
                  >
                    {bot.emoji}   {bot.name.length > 10
                      ? `${bot.name.slice(0, 10)}…`
                      : bot.name}
                    {isDead && ' (DEAD)'}
                  </Button>
                );
              })}
            </Box>
          </Box>
        </FormControl>
      )}

      {/* Team Configuration - Only show for team games */}
      {(gameType === "teamsnek" ) && (
        <FormControl fullWidth variant="outlined" sx={{ mt: 2 }}>
          <InputLabel shrink sx={{ backgroundColor: "white", px: 1 }}>
            Team Configuration
          </InputLabel>
          <Box
            sx={{
              border: "2px solid black",
              padding: 2,
              borderRadius: "0px",
              minHeight: "56px",
            }}
          >
            <TeamConfiguration
              teams={teams}
              onTeamsChange={handleTeamsChange}
              maxTurns={maxTurns}
              onMaxTurnsChange={handleMaxTurnsChange}
              bots={bots}
              gamePlayers={gameSetup?.gamePlayers || []}
            />
          </Box>
        </FormControl>
      )}

      {/* Players Table */}
      {(gameType === "teamsnek" ) && teams.length > 0 ? (
        <FormControl fullWidth variant="outlined" sx={{ mt: 2 }}>
          <InputLabel shrink sx={{ backgroundColor: "white", px: 1 }}>
            Player Configuration
          </InputLabel>
          <Box
            sx={{
              border: "2px solid black",
              padding: 2,
              borderRadius: "0px",
              minHeight: "56px",
            }}
          >
            <PlayerConfiguration
              teams={teams}
              players={players}
              gamePlayers={gameSetup.gamePlayers}
              onTeamChange={handleTeamChange}
              onPlayerKick={handlePlayerKick}
              playersReady={playersReady}
              onPlayerTeamKick={handlePlayerTeamKick}
              getBotStatus={getBotStatus}
            />
          </Box>
        </FormControl>
      ) : (
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Player</TableCell>
                <TableCell align="right">Ready</TableCell>
                <TableCell align="right">Remove?</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {gameSetup.gamePlayers.map((gamePlayer) => {
                const player = players.find(
                  (player) => player.id === gamePlayer.id,
                )
                if (!player) return null
                return (
                  <TableRow key={player.id}>
                    <TableCell sx={{ backgroundColor: player.colour }}>
                      {player.name} {player.emoji}
                    </TableCell>
                    <TableCell
                      align="right"
                      sx={{ backgroundColor: player.colour }}
                    >
                      {playersReady.includes(player.id) ? "Yeah" : "Nah"}
                    </TableCell>
                    <TableCell
                      align="right"
                      sx={{ backgroundColor: player.colour }}
                      onClick={() => handlePlayerKick(player.id, gamePlayer.type)}
                    >
                      ❌
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </Stack>
  )
}

const GameSetupWithProvider: React.FC = () => {
  return (
    <BotHealthProvider>
      <GameSetup />
    </BotHealthProvider>
  );
};

export default GameSetupWithProvider

// Function to insert keyframe and class rules separately
const addStyles = () => {
  const styleSheet = document.styleSheets[0]

  // Insert the keyframes animation
  styleSheet.insertRule(
    `
    @keyframes shake {
      0% { transform: translateX(0); }
      25% { transform: translateX(-5px); }
      50% { transform: translateX(5px); }
      75% { transform: translateX(-5px); }
      100% { transform: translateX(0); }
    }
  `,
    styleSheet.cssRules.length,
  )

  // Insert the shake class rule with infinite iterations
  styleSheet.insertRule(
    `
    .shake {
      animation: shake 0.5s ease infinite;
    }
  `,
    styleSheet.cssRules.length,
  )
}
