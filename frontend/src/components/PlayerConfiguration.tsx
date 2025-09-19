import React from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Select,
  MenuItem,
  FormControl,
  Typography,
  Box,
} from "@mui/material";
import { GamePlayer, Player, Team } from "@shared/types/Game";

interface PlayerConfigurationProps {
  teams: Team[];
  players: Player[];
  gamePlayers: GamePlayer[];
  onTeamChange: (playerID: string, teamID: string) => void;
  onPlayerKick: (playerID: string, type: "bot" | "human") => void;
  onPlayerTeamKick: (playerID: string, teamID: string) => void;
  playersReady: string[];
  getBotStatus?: (botId: string) => "unknown" | "loading" | "alive" | "dead" | "error";
}

export const PlayerConfiguration: React.FC<PlayerConfigurationProps> = ({
  teams,
  players,
  gamePlayers,
  onTeamChange,
  onPlayerKick,
  onPlayerTeamKick,
  playersReady,
  getBotStatus,
}) => {
  // Group players by team
  const playersByTeam = teams.map((team) => ({
    team,
    players: gamePlayers.filter((gamePlayer) => gamePlayer.teamID === team.id),
  }));

  // Get unassigned players
  const unassignedPlayers = gamePlayers.filter(
    (gamePlayer) =>  !gamePlayer.teamID
  );


  return (
    <div>
      {/* Team Sections */}
      {playersByTeam.map(({ team, players: teamPlayers }) => (
        <Box key={team.id} sx={{ mb: 3 }}>
          <Typography
            variant="h6"
            sx={{
              color: team.color,
              fontWeight: "bold",
              mb: 1,
              display: "flex",
              alignItems: "center",
              gap: 1,
            }}
          >
            <div
              style={{
                width: "16px",
                height: "16px",
                backgroundColor: team.color,
                borderRadius: "50%",
              }}
            />
            {team.name}
          </Typography>
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Player</TableCell>
                  <TableCell>Team</TableCell>
                  <TableCell align="right">Ready</TableCell>
                  <TableCell align="right">Remove</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {teamPlayers.map((gamePlayer) => {
                  const player = players.find(
                    (p) => p.id === gamePlayer.id
                  );
                  if (!player) return null;
                  return (
                    <TableRow key={player.id}>
                      <TableCell sx={{ backgroundColor: player.colour }}>
                        {player.name} {player.emoji}
                        {gamePlayer.type === 'bot' && getBotStatus?.(player.id) === 'dead' && ' (DEAD)'}
                      </TableCell>
                      <TableCell sx={{ backgroundColor: player.colour }}>
                        <FormControl size="small" fullWidth>
                          <Select
                            value={gamePlayer.teamID || ""}
                            onChange={(e) =>
                              onTeamChange(player.id, e.target.value)
                            }
                            disabled={gamePlayer.type === 'bot' && getBotStatus?.(player.id) === 'dead'}
                            sx={{ minWidth: 120 }}
                          >
                            {teams.map((team) => (
                              <MenuItem key={team.id} value={team.id}>
                                <div
                                  style={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: "5px",
                                  }}
                                >
                                  <div
                                    style={{
                                      width: "12px",
                                      height: "12px",
                                      backgroundColor: team.color,
                                      borderRadius: "50%",
                                    }}
                                  />
                                  {team.name}
                                </div>
                              </MenuItem>
                            ))}
                          </Select>
                        </FormControl>
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
                        onClick={() => onPlayerTeamKick(player.id,gamePlayer.teamID || "")}
                        style={{ cursor: "pointer" }}
                      >
                        ❌
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
        </Box>
      ))}

      {/* Spectators Section */}
      {unassignedPlayers.length > 0 && (
        <Box sx={{ mb: 3 }}>
          <Typography variant="h6" sx={{ mb: 1, color: "#666", fontWeight: "bold" }}>
            Spectators
          </Typography>
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Player</TableCell>
                  <TableCell>Team</TableCell>
                  <TableCell align="right">Ready</TableCell>
                  <TableCell align="right">Remove</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {unassignedPlayers.map((gamePlayer) => {
                  const player = players.find(
                    (p) => p.id === gamePlayer.id
                  );
                  if (!player) return null;
                  return (
                    <TableRow key={player.id}>
                      <TableCell sx={{ backgroundColor: player.colour }}>
                        {player.name} {player.emoji}
                        {gamePlayer.type === 'bot' && getBotStatus?.(player.id) === 'dead' && ' (DEAD)'}
                      </TableCell>
                      <TableCell sx={{ backgroundColor: player.colour }}>
                        <FormControl size="small" fullWidth>
                          <Select
                            value={gamePlayer.teamID || ""}
                            onChange={(e) =>
                              onTeamChange(player.id, e.target.value)
                            }
                            disabled={gamePlayer.type === 'bot' && getBotStatus?.(player.id) === 'dead'}
                            sx={{ minWidth: 120 }}
                          >
                            <MenuItem value="">
                              <em>Select team</em>
                            </MenuItem>
                            {teams.map((team) => (
                              <MenuItem key={team.id} value={team.id}>
                                <div
                                  style={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: "5px",
                                  }}
                                >
                                  <div
                                    style={{
                                      width: "12px",
                                      height: "12px",
                                      backgroundColor: team.color,
                                      borderRadius: "50%",
                                    }}
                                  />
                                  {team.name}
                                </div>
                              </MenuItem>
                            ))}
                          </Select>
                        </FormControl>
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
                        onClick={() => onPlayerKick(player.id, gamePlayer.type)}
                        style={{ cursor: "pointer" }}
                      >
                        ❌
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
        </Box>
      )}
    </div>
  );
}; 