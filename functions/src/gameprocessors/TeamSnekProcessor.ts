import { GameState, Winner, GameSetup, GamePlayer } from "@shared/types/Game";
import { SnekProcessor } from "./SnekProcessor";

export class TeamSnekProcessor extends SnekProcessor {
  private maxTurns: number;

  constructor(gameState: GameState) {
    super(gameState);
    this.maxTurns = gameState.setup.maxTurns || 100;
  }

  /**
   * Team snek: only players assigned to teams are active players.
   * Unassigned players become observers.
   */
  static filterActivePlayers(setup: GameSetup): GamePlayer[] {
    return setup.gamePlayers.filter(player => player.teamID);
  }

  // Override calculateWinners to end game when maxTurns is reached
  protected calculateWinners(gameState: any): Winner[] {
    const currentTurnNumber = this.gameState.turns.length;
    
    // If maxTurns reached, end the game and calculate winners
    if (currentTurnNumber >= this.maxTurns) {
      return this.calculateSurvivalWinners(gameState);
    }

    // If only one team is alive, return the team as the winner
    const aliveTeams = this.getAliveTeams(gameState);
    if (aliveTeams.length === 1) {
      return this.calculateTeamWinners(aliveTeams[0], gameState);
    }
      
    // Otherwise, use parent logic (only end if 1 or fewer players alive)
    return super.calculateWinners(gameState);
  }

  private getAliveTeams(gameState: any): string[] {
    const aliveTeams = new Set<string>();
    
    gameState.newAlivePlayers.forEach((playerID: string) => {
      const player = this.gameSetup.gamePlayers.find(p => p.id === playerID);
      if (player && player.teamID) {
        aliveTeams.add(player.teamID);
      }
    });
    
    return Array.from(aliveTeams);
  }

  private calculateTeamWinners(teamID: string, gameState: any): Winner[] {
    const teamPlayers = this.gameSetup.gamePlayers.filter(player => player.teamID === teamID);
    
    return teamPlayers.map(player => ({
      playerID: player.id,
      score: gameState.newSnakes[player.id]?.length || 0,
      winningSquares: gameState.newSnakes[player.id] || [],
      teamID: teamID
    }));
  }

  // Override createNewTurn to calculate team-based scores
  protected createNewTurn(currentTurn: any, gameState: any, winners: any[]): any {
    // Call parent method first
    const newTurn = super.createNewTurn(currentTurn, gameState, winners);
    
    // Calculate team scores
    const teamScores: { [teamID: string]: number } = {};
    const playerScores: { [playerID: string]: number } = {};
    
    // First pass: calculate team totals
    this.gameSetup.gamePlayers.forEach(player => {
      if (player.teamID) {
        if (!teamScores[player.teamID]) {
          teamScores[player.teamID] = 0;
        }
        const snakeLength = gameState.newSnakes[player.id]?.length || 0;
        teamScores[player.teamID] += snakeLength;
      }
    });
    
    // Second pass: assign team score to each player
    this.gameSetup.gamePlayers.forEach(player => {
      if (player.teamID) {
        // Each player gets their team's total score
        playerScores[player.id] = teamScores[player.teamID];
      } else {
        // Non-team players use snake length
        playerScores[player.id] = gameState.newSnakes[player.id]?.length || 0;
      }
    });
    
    // Update the turn with new scores
    newTurn.scores = playerScores;
    newTurn.teamScores = teamScores;
    
    return newTurn;
  }
}
