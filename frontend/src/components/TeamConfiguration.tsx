import React, { useState } from "react";
import {
  Button,
  TextField,
  FormControl,
} from "@mui/material";
import { ColorPicker } from "./ColorPicker";
import { Bot } from "@shared/types/Game";
import { BotHealthCheck } from "./BotHealthCheck";

interface Team {
  id: string;
  name: string;
  color: string;

}

interface TeamConfigurationProps {
  teams: Team[];
  onTeamsChange: (teams: Team[]) => void;
  maxTurns: number;
  onMaxTurnsChange: (turns: number) => void;
  hazardPercentage: number;
  onHazardPercentageChange: (percentage: number) => void;
  bots?: Bot[];
  gamePlayers?: Array<{ id: string; type: "bot" | "human"; teamID?: string }>;
}


export const TeamConfiguration: React.FC<TeamConfigurationProps> = ({
  teams,
  onTeamsChange,
  maxTurns,
  onMaxTurnsChange,
  hazardPercentage,
  onHazardPercentageChange,
  bots = [],
  gamePlayers = [],
}) => {
  const [newTeamName, setNewTeamName] = useState("");
  const [newTeamColor, setNewTeamColor] = useState("#FF6B6B");

  // Initialize default teams if none exist
  React.useEffect(() => {
    if (teams.length === 0) {
      const defaultTeams: Team[] = [
        { id: 'team_red', name: 'Red Team', color: '#FF6B6B' },
        { id: 'team_blue', name: 'Blue Team', color: '#4ECDC4' }
      ];
      onTeamsChange(defaultTeams);
    }
  }, [teams.length, onTeamsChange]);

  const addTeam = () => {
    if (newTeamName.trim()) {
      const newTeam: Team = {
        id: `team_${Date.now()}`,
        name: newTeamName,
        color: newTeamColor,

      };
      onTeamsChange([...teams, newTeam]);
      setNewTeamName("");
    }
  };

  const removeTeam = (teamId: string) => {
    onTeamsChange(teams.filter((team) => team.id !== teamId));
  };


  return (
    <div>
      <h3>Team Configuration</h3>

      {/* Turn Limit and Terrain */}
      <FormControl fullWidth margin="normal">
        <div style={{ display: "flex", gap: "15px" }}>
          <TextField
            type="number"
            label="Max Turns"
            value={maxTurns}
            onChange={(e) => onMaxTurnsChange(parseInt(e.target.value))}
            sx={{ flex: 1 }}
            inputProps={{ min: 1 }}
          />
          <TextField
            type="number"
            label="Hazard Percentage"
            value={hazardPercentage}
            onChange={(e) =>
              onHazardPercentageChange(parseInt(e.target.value))
            }
            sx={{ flex: 1 }}
            inputProps={{ min: 0, max: 100 }}
          />
        </div>
      </FormControl>

      {/* Team Creation */}
      <div style={{ display: "flex", gap: "15px", marginBottom: "20px", alignItems: "flex-start" }}>
        <TextField
          label="Team Name"
          value={newTeamName}
          onChange={(e) => setNewTeamName(e.target.value)}
          sx={{ flex: 1 }}
        />
        <ColorPicker
          selectedColor={newTeamColor}
          onColorChange={setNewTeamColor}
          label="Team Color"
        />
        <Button 
          variant="contained" 
          onClick={addTeam}
          sx={{ 
            backgroundColor: '#1976d2',
            '&:hover': {
              backgroundColor: '#1565c0'
            },
            height: '56px',
            px: 3
          }}
        >
          Add Team
        </Button>
      </div>

      {/* Bot Health Check Section */}
      <BotHealthCheck 
        bots={bots}
        gamePlayers={gamePlayers}
        autoCheck={true}
        showTitle={true}
        compact={false}
      />

      {/* Team List */}
      <div>
        {teams.map((team) => (
          <div
            key={team.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "10px",
              padding: "10px",
              border: "1px solid #ccc",
              marginBottom: "10px",
            }}
          >
            <div
              style={{
                width: "32px",
                height: "32px",
                backgroundColor: team.color,
                borderRadius: "50%",
                border: "2px solid #fff",
                boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                position: "relative",
              }}
            >
              <div
                style={{
                  position: "absolute",
                  width: "100%",
                  height: "100%",
                  borderRadius: "50%",
                  border: "1px solid rgba(0,0,0,0.1)",
                }}
              />
            </div>
            <span style={{ fontWeight: 500, fontSize: "16px" }}>{team.name}</span>
            <Button
              variant="outlined"
              color="error"
              size="small"
              onClick={() => removeTeam(team.id)}
            >
              Remove
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
};
