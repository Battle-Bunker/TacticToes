import { Winner, GameSetup, GamePlayer, Turn } from "@shared/types/Game";
import { SnekProcessor } from "./SnekProcessor";

export class TeamSnekProcessor extends SnekProcessor {

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

  // Override calculateWinners to use team-based end conditions
  protected calculateWinners(gameState: any): Winner[] {
    const currentTurnNumber = this.gameState.turns.length;
    const reachedTurnLimit = this.maxTurns !== undefined && currentTurnNumber >= this.maxTurns;

    const aliveTeams = this.getAliveTeams(gameState);

    if (aliveTeams.length === 0) {
      return this.calculatePreviousTurnTeamOutcome();
    }

    if (aliveTeams.length === 1) {
      return this.calculateTeamWinners(aliveTeams[0], gameState);
    }

    if (reachedTurnLimit) {
      const teamScores = this.getTeamScores(gameState);
      const maxScore = Math.max(...teamScores.values());
      const topTeams = Array.from(teamScores.entries())
        .filter(([, score]) => score === maxScore)
        .map(([teamID]) => teamID);

      if (topTeams.length === 1) {
        return this.calculateTeamWinners(topTeams[0], gameState);
      }

      // Tie at the turn limit results in a draw between the top teams
      return this.calculateTeamDrawWinners(topTeams, gameState);
    }

    return [];
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
    const teamScore = this.getTeamScore(teamID, gameState);

    return teamPlayers.map(player => ({
      playerID: player.id,
      score: gameState.newSnakes[player.id]?.length || 0,
      winningSquares: gameState.newSnakes[player.id] || [],
      teamID: teamID,
      teamScore: teamScore
    }));
  }

  private calculateTeamDrawWinners(teamIDs: string[], gameState: any): Winner[] {
    return teamIDs.flatMap(teamID => this.calculateTeamWinners(teamID, gameState));
  }

  private calculateTeamDrawWinnersFromTurn(teamIDs: string[], turn: Turn): Winner[] {
    return teamIDs.flatMap(teamID => this.calculateTeamWinnersFromTurn(teamID, turn));
  }

  private getTeamScore(teamID: string, gameState: any): number {
    return this.gameSetup.gamePlayers
      .filter(player => player.teamID === teamID)
      .reduce((total, player) => total + (gameState.newSnakes[player.id]?.length || 0), 0);
  }

  private getTeamScoreFromTurn(teamID: string, turn: Turn): number {
    return this.gameSetup.gamePlayers
      .filter(player => player.teamID === teamID)
      .reduce((total, player) => total + (turn.playerPieces[player.id]?.length || 0), 0);
  }

  private getTeamScores(gameState: any): Map<string, number> {
    const teamScores = new Map<string, number>();

    this.gameSetup.gamePlayers.forEach(player => {
      if (player.teamID) {
        const currentScore = teamScores.get(player.teamID) || 0;
        teamScores.set(player.teamID, currentScore + (gameState.newSnakes[player.id]?.length || 0));
      }
    });

    return teamScores;
  }

  private getTeamScoresFromTurn(turn: Turn): Map<string, number> {
    const teamScores = new Map<string, number>();

    this.gameSetup.gamePlayers.forEach(player => {
      if (player.teamID) {
        const currentScore = teamScores.get(player.teamID) || 0;
        teamScores.set(player.teamID, currentScore + (turn.playerPieces[player.id]?.length || 0));
      }
    });

    return teamScores;
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
        // If player is dead, they contribute 0 to team score
        const playerScore = gameState.deadPlayers.has(player.id) ? 0 : (gameState.newSnakes[player.id]?.length || 0);
        teamScores[player.teamID] += playerScore;
      }
    });
    
    // Second pass: assign individual scores to each player
    this.gameSetup.gamePlayers.forEach(player => {
      // Dead players get score 0, alive players get their snake length
      playerScores[player.id] = gameState.deadPlayers.has(player.id) ? 0 : (gameState.newSnakes[player.id]?.length || 0);
    });
    
    // Update the turn with new scores
    newTurn.scores = playerScores;
    newTurn.teamScores = teamScores;
    
    // Set the scoring unit for team-based display
    newTurn.scoringUnit = 'team';
    
    return newTurn;
  }

  private calculateTeamWinnersFromTurn(teamID: string, turn: Turn): Winner[] {
    const teamScore = this.getTeamScoreFromTurn(teamID, turn);

    return this.gameSetup.gamePlayers
      .filter(player => player.teamID === teamID)
      .map(player => ({
        playerID: player.id,
        score: turn.playerPieces[player.id]?.length || 0,
        winningSquares: turn.playerPieces[player.id] || [],
        teamID,
        teamScore,
      }));
  }

  private getAliveTeamsFromTurn(turn: Turn): string[] {
    const aliveTeams = new Set<string>();

    turn.alivePlayers.forEach(playerID => {
      const player = this.gameSetup.gamePlayers.find(p => p.id === playerID);
      if (player?.teamID) {
        aliveTeams.add(player.teamID);
      }
    });

    return Array.from(aliveTeams);
  }

  private calculatePreviousTurnTeamOutcome(): Winner[] {
    const previousTurn = this.gameState.turns[this.gameState.turns.length - 1];

    if (!previousTurn) {
      return [];
    }

    const aliveTeams = this.getAliveTeamsFromTurn(previousTurn);

    if (aliveTeams.length === 1) {
      return this.calculateTeamWinnersFromTurn(aliveTeams[0], previousTurn);
    }

    const teamScores = this.getTeamScoresFromTurn(previousTurn);

    if (teamScores.size === 0) {
      return [];
    }

    const maxScore = Math.max(...teamScores.values());
    const topTeams = Array.from(teamScores.entries())
      .filter(([, score]) => score === maxScore)
      .map(([teamID]) => teamID);

    if (topTeams.length === 1) {
      return this.calculateTeamWinnersFromTurn(topTeams[0], previousTurn);
    }

    return this.calculateTeamDrawWinnersFromTurn(topTeams, previousTurn);
  }
}
