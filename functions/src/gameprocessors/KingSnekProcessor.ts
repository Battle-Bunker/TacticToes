import { GameState, Winner, GameSetup, GamePlayer } from "@shared/types/Game";
import { TeamSnekProcessor } from "./TeamSnekProcessor";

export class KingSnekProcessor extends TeamSnekProcessor {
  constructor(gameState: GameState) {
    super(gameState);
  }

  static filterActivePlayers(setup: GameSetup): GamePlayer[] {
    return setup.gamePlayers.filter(player => player.teamID);
  }

  static getScoringUnit(setup: GameSetup): 'individual' | 'team' {
    return 'team';
  }

  private getKingForTeam(teamID: string): GamePlayer | undefined {
    return this.gameSetup.gamePlayers.find(player => player.teamID === teamID && player.isKing);
  }

  applyMoves(currentTurn: any, moves: any[]): any {
    const newTurn = super.applyMoves(currentTurn, moves);
    
    const currentAlivePlayers = new Set<string>(currentTurn.alivePlayers);
    const newAlivePlayers = new Set<string>(newTurn.alivePlayers);
    
    const deadPlayers = Array.from(currentAlivePlayers).filter(id => !newAlivePlayers.has(id));
    
    deadPlayers.forEach(playerID => {
      const player = this.gameSetup.gamePlayers.find(p => p.id === playerID);
      if (player && player.isKing && player.teamID) {
        this.gameSetup.gamePlayers.forEach(teammate => {
          if (teammate.teamID === player.teamID && teammate.id !== playerID && newAlivePlayers.has(teammate.id)) {
            newAlivePlayers.delete(teammate.id);
            delete newTurn.playerPieces[teammate.id];
            delete newTurn.playerHealth[teammate.id];
            delete newTurn.allowedMoves[teammate.id];
            newTurn.scores[teammate.id] = 0;
            if (newTurn.teamScores && player.teamID) {
              newTurn.teamScores[player.teamID] = 0;
            }
          }
        });
      }
    });
    
    newTurn.alivePlayers = Array.from(newAlivePlayers);
    
    return newTurn;
  }

  protected calculateSurvivalWinners(gameState: any): Winner[] {
    const individualWinners = this.gameSetup.gamePlayers.map(player => ({
      playerID: player.id,
      score: gameState.newSnakes[player.id]?.length || 0,
      winningSquares: gameState.newSnakes[player.id] ?? []
    }));

    const teamScores = new Map<string, number>();
    this.gameSetup.gamePlayers.forEach(player => {
      if (player.teamID && player.isKing) {
        const kingScore = gameState.newSnakes[player.id]?.length || 0;
        teamScores.set(player.teamID, kingScore);
      }
    });

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

  protected calculateWinners(gameState: any): Winner[] {
    const currentTurnNumber = this.gameState.turns.length;

    if (
      this.gameSetup.maxTurns !== undefined &&
      currentTurnNumber >= this.gameSetup.maxTurns
    ) {
      return this.calculateSurvivalWinners(gameState);
    }

    const aliveTeams = this.getKingSnekAliveTeams(gameState);
    if (aliveTeams.length === 1) {
      return this.calculateKingSnekTeamWinners(aliveTeams[0], gameState);
    }
      
    if (gameState.newAlivePlayers.length <= 1) {
      return this.calculateSurvivalWinners(gameState);
    }
    
    return [];
  }

  private getKingSnekAliveTeams(gameState: any): string[] {
    const aliveTeams = new Set<string>();
    
    gameState.newAlivePlayers.forEach((playerID: string) => {
      const player = this.gameSetup.gamePlayers.find(p => p.id === playerID);
      if (player && player.teamID) {
        aliveTeams.add(player.teamID);
      }
    });
    
    return Array.from(aliveTeams);
  }

  private calculateKingSnekTeamWinners(teamID: string, gameState: any): Winner[] {
    const teamPlayers = this.gameSetup.gamePlayers.filter(player => player.teamID === teamID);
    const king = this.getKingForTeam(teamID);
    
    const teamScore = king ? (gameState.newSnakes[king.id]?.length || 0) : 0;
    
    return teamPlayers.map(player => ({
      playerID: player.id,
      score: gameState.newSnakes[player.id]?.length || 0,
      winningSquares: gameState.newSnakes[player.id] || [],
      teamID: teamID,
      teamScore: teamScore
    }));
  }

  protected createNewTurn(currentTurn: any, gameState: any, winners: any[]): any {
    const newTurn = super.createNewTurn(currentTurn, gameState, winners);
    
    const teamScores: { [teamID: string]: number } = {};
    const playerScores: { [playerID: string]: number } = {};
    
    this.gameSetup.gamePlayers.forEach(player => {
      if (player.teamID && player.isKing) {
        const kingScore = gameState.deadPlayers.has(player.id) ? 0 : (gameState.newSnakes[player.id]?.length || 0);
        teamScores[player.teamID] = kingScore;
      }
    });

    this.gameSetup.gamePlayers.forEach(player => {
      playerScores[player.id] = gameState.deadPlayers.has(player.id) ? 0 : (gameState.newSnakes[player.id]?.length || 0);
    });
    
    newTurn.scores = playerScores;
    newTurn.teamScores = teamScores;
    newTurn.scoringUnit = 'team';
    
    return newTurn;
  }
}
