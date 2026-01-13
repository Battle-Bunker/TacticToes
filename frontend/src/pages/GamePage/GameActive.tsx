// src/components/GameActive.tsx

import React, { useState } from "react";
import { useUser } from "../../context/UserContext";

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
} from "@mui/material";

import { useGameStateContext } from "../../context/GameStateContext";
import GameGrid from "./GameGrid";
import UserRulesAccept from "./UserRuleAccept";

const GameActive: React.FC = () => {
  const { userID } = useUser();
  const {
    gameState,
    gameSetup,
    players,
    timeRemaining,
    selectedSquare,
    latestMoveStatus,
    connectivityStatus,
    queryTimedOut,
  } = useGameStateContext();

  const [isRulesDialogOpen, setIsRulesDialogOpen] = useState(true); // Show rules dialog initially
  const [isRulesAccepted, setIsRulesAccepted] = useState(false); // Track if rules have been accepted

  const handleRulesAccepted = () => {
    setIsRulesAccepted(true);
    setIsRulesDialogOpen(false);
  };

  if (!gameState) return null;

  const currentTurn = gameState.turns?.[gameState.turns.length - 1];
  const playerInCurrentGame = gameSetup?.gamePlayers.find(
    (player) => player.id === userID,
  );

  const scoringUnit = currentTurn?.scoringUnit || "individual";
  const showTeamClusterFallback = Boolean(currentTurn?.teamClusterFallback);


  // Filter players to only show those in the current game
  const gamePlayers = players.filter((player) =>
    gameSetup?.gamePlayers.some((gp) => gp.id === player.id),
  );

  if (!currentTurn) {
    return (
      <Stack spacing={2} pt={2}>
        <Alert severity="info">Waiting for game data.</Alert>
      </Stack>
    );
  }

  return (
    <Stack spacing={2} pt={2}>
      {/* Rules Dialog - Only shown on the first turn */}
      {gameState.turns.length === 1 &&
        !isRulesAccepted &&
        timeRemaining > 0 && (
          <UserRulesAccept
            open={isRulesDialogOpen}
            onClose={handleRulesAccepted} // Close dialog after "I understand" is checked
            rules={gameSetup?.gameType}
            timeRemaining={timeRemaining}
          />
        )}

      {/* Alert if player joined late or team clusters failed */}
      {showTeamClusterFallback ? (
        <Alert severity="warning">
          Team cluster spawn failed to fit all players. Standard spawn was used.
        </Alert>
      ) : (
        !playerInCurrentGame && (
          <Alert severity="warning">
            This game started before you joined. Watch until the next game starts.
          </Alert>
        )
      )}
      {/* Alert if internet error */}
      {connectivityStatus === "disconnected" && (
        <Alert severity="error">
          You have no internet. Seek higher ground.
        </Alert>
      )}
      {/* Alert if internet error */}
      {queryTimedOut && connectivityStatus !== "disconnected" && (
        <Alert severity="error">Your internet is slow. Get good.</Alert>
      )}

      <Typography>
        Turn {gameState.turns.length}.{" "}
        {currentTurn.winners.length === 0
          ? `${Math.max(0, timeRemaining).toFixed(0)} seconds left.`
          : "Game over"}
      </Typography>

      {gameState.turns.length == 1 && selectedSquare === null && (
        <Typography>Tap a square to submit your move.</Typography>
      )}

      {/* Game Grid */}
      {<GameGrid />}

      {/* Players/Teams Table */}
      {scoringUnit === "team" && gameSetup?.teams ? (
        // Team-based table
        <TableContainer sx={{ my: 2, width: "100%" }}>
          <Table size="small" sx={{ borderCollapse: "collapse" }}>
            <TableHead>
              <TableRow>
                <TableCell>Team</TableCell>
                <TableCell align="right">Score</TableCell>
                <TableCell align="left">Players</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {gameSetup.teams.map((team) => {
                const teamScore = currentTurn.teamScores?.[team.id] || 0;
                const teamPlayers = gamePlayers.filter((player) =>
                  gameSetup.gamePlayers.some(
                    (gp) => gp.id === player.id && gp.teamID === team.id,
                  ),
                );

                return (
                  <TableRow key={team.id} sx={{ backgroundColor: team.color }}>
                    <TableCell>{team.name}</TableCell>
                    <TableCell align="right">{teamScore}</TableCell>
                    <TableCell align="left">
                      {teamPlayers.map((p) => (
                        <span key={p.id}>
                          {p.emoji} {p.name}
                          {latestMoveStatus?.movedPlayerIDs.includes(p.id)
                            ? " ✓"
                            : " ⏳"}
                          {teamPlayers.indexOf(p) < teamPlayers.length - 1
                            ? ", "
                            : ""}
                        </span>
                      ))}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      ) : (
        // Individual player table
        <TableContainer sx={{ my: 2, width: "100%" }}>
          <Table size="small" sx={{ borderCollapse: "collapse" }}>
            <TableHead>
              <TableRow>
                <TableCell>Players</TableCell>
                <TableCell align="right">Moved</TableCell>
                <TableCell align="right">Score</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {gamePlayers.map((player) => {
                return (
                  <TableRow
                    key={player.id}
                    sx={{ backgroundColor: player.colour }}
                  >
                    <TableCell>
                      {player.name} {player.emoji}
                    </TableCell>
                    <TableCell align="right">
                      {latestMoveStatus?.movedPlayerIDs.includes(player.id)
                        ? "yeah"
                        : "nah"}
                    </TableCell>
                    <TableCell align="right">
                      {currentTurn.scores[player.id]}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {/* Waiting Overlay */}
      {latestMoveStatus &&
        latestMoveStatus.moveNumber === gameState.turns.length - 1 &&
        latestMoveStatus.movedPlayerIDs.includes(userID) && (
          <Box
            sx={{
              position: "fixed",
              top: -20,
              left: 0,
              width: "100%",
              height: "100%",
              bgcolor: "rgba(255, 255, 255, 0.7)",
              display: "flex",
              justifyContent: "center",
              alignItems: "center",
              pointerEvents: "none",
              zIndex: 9999,
            }}
          >
            <Typography sx={{ mx: 2, textAlign: "center" }} variant="h4">
              Waiting for
              <br />
              {(() => {
                const unmovePlayers = currentTurn.alivePlayers.filter(
                  (player) =>
                    !latestMoveStatus?.movedPlayerIDs?.includes(player),
                );

                if (unmovePlayers.length === 0) return "the cloud";

                return unmovePlayers.map((gamePlayer, index) => {
                  const player = players.find(
                    (player) => gamePlayer === player.id,
                  );
                  return (
                    <React.Fragment key={player?.id}>
                      {player?.name}
                      {index < unmovePlayers.length - 1 && <br />}
                    </React.Fragment>
                  );
                });
              })()}
            </Typography>
          </Box>
        )}
    </Stack>
  );
};

export default GameActive;
