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
  Checkbox,
} from "@mui/material";
import { GamePlayer, GameType, Player, Team } from "@shared/types/Game";

interface PlayerConfigurationProps {
  teams: Team[];
  players: Player[];
  gamePlayers: GamePlayer[];
  onTeamChange: (playerID: string, teamID: string) => void;
  onPlayerKick: (playerID: string, type: "bot" | "human") => void;
  onPlayerTeamKick: (playerID: string, teamID: string) => void;
  playersReady: string[];
  getBotStatus?: (botId: string) => "unknown" | "loading" | "alive" | "dead" | "error";
  gameType?: GameType;
  onKingToggle?: (playerID: string, teamID: string) => void;
  playerNameOverrides?: Record<string, string>;
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
  gameType,
  onKingToggle,
  playerNameOverrides,
}) => {
  const isKingSnek = gameType === 'kingsnek';
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
                  {isKingSnek && <TableCell align="center">King</TableCell>}
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
                  const displayName = playerNameOverrides?.[player.id] || player.name;
                  return (
                    <TableRow key={player.id}>
                      <TableCell sx={{ backgroundColor: player.colour }}>
                        {displayName} {player.emoji}
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
                      {isKingSnek && (
                        <TableCell
                          align="center"
                          sx={{ backgroundColor: player.colour }}
                        >
                          <Checkbox
                            checked={gamePlayer.isKing || false}
                            onChange={() => onKingToggle?.(player.id, gamePlayer.teamID || "")}
                            checkedIcon={<span>👑</span>}
                            icon={<span style={{ opacity: 0.3 }}>👑</span>}
                            sx={{ padding: 0 }}
                          />
                        </TableCell>
                      )}
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
                  {isKingSnek && <TableCell align="center">King</TableCell>}
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
                  const displayName = playerNameOverrides?.[player.id] || player.name;
                  return (
                    <TableRow key={player.id}>
                      <TableCell sx={{ backgroundColor: player.colour }}>
                        {displayName} {player.emoji}
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
                      {isKingSnek && (
                        <TableCell
                          align="center"
                          sx={{ backgroundColor: player.colour }}
                        >
                          <span style={{ opacity: 0.3 }}>👑</span>
                        </TableCell>
                      )}
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
