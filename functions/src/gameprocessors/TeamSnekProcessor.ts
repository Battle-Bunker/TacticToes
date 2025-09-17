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

  /**
   * Team snek uses team-based scoring
   */
  static getScoringUnit(setup: GameSetup): 'individual' | 'team' {
    return 'team';
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

  // Override to handle team-based survival scoring
  protected calculateSurvivalWinners(gameState: any): Winner[] {
    // Get individual survival winners from parent
    const individualWinners = super.calculateSurvivalWinners(gameState);
    
    // Calculate team scores based on team members' survival
    const teamScores = new Map<string, number>();
    individualWinners.forEach(winner => {
      const player = this.gameSetup.gamePlayers.find(p => p.id === winner.playerID);
      if (player && player.teamID) {
        const currentScore = teamScores.get(player.teamID) || 0;
        teamScores.set(player.teamID, currentScore + winner.score);
      }
    });
    
    // Update winners with team scores
    return individualWinners.map(winner => {
      const player = this.gameSetup.gamePlayers.find(p => p.id === winner.playerID);
      if (player && player.teamID) {
        return {
          ...winner,
          teamID: player.teamID,
          teamScore: teamScores.get(player.teamID) || 0
        };
      }
      return winner;
    });
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
    
    // Calculate the team's total score
    let teamScore = 0;
    teamPlayers.forEach(player => {
      teamScore += gameState.newSnakes[player.id]?.length || 0;
    });
    
    return teamPlayers.map(player => ({
      playerID: player.id,
      score: gameState.newSnakes[player.id]?.length || 0,
      winningSquares: gameState.newSnakes[player.id] || [],
      teamID: teamID,
      teamScore: teamScore
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
    
    // Second pass: assign individual scores to each player
    this.gameSetup.gamePlayers.forEach(player => {
      // Each player gets their individual snake length
      playerScores[player.id] = gameState.newSnakes[player.id]?.length || 0;
    });
    
    // Update the turn with new scores
    newTurn.scores = playerScores;
    newTurn.teamScores = teamScores;
    
    // Set the scoring unit for team-based display
    newTurn.scoringUnit = 'team';
    
    return newTurn;
  }
}
