import { GameState, Move, Turn, Winner } from "@shared/types/Game";
import { SnekProcessor } from "./SnekProcessor";
import { logger } from "../logger";

export class TeamSnekProcessor extends SnekProcessor {
  private maxTurns: number = 100;
  constructor(gameState: GameState) {
    super(gameState);
    this.maxTurns = gameState.setup.maxTurns || 100;
  }



  firstTurn(): Turn {
    const baseTurn = super.firstTurn();

    // Add team-speicific initialization
    const teamScores: { [teamID: string]: number } = {};
    this.gameSetup.teams?.forEach((team) => {
      teamScores[team.id] = 0;
    });

    return {
      ...baseTurn,
      teamScores,
      turnNumber: 0,
      eliminatedTeams: [],
    };
  }

  applyMoves(currentTurn: Turn, moves: Move[]): Turn {
    const currentTurnNumber = (currentTurn.turnNumber || 0) + 1;
    
    // Check if we've exceeded max turns before processing moves
    if (currentTurnNumber > this.maxTurns) {
      logger.info(`TeamSnek: Max turns (${this.maxTurns}) exceeded. Game ending.`);
      
      // Calculate final team scores and determine winners
      const teamScores = this.calculateTeamScores(currentTurn.playerPieces);
      const eliminatedTeams = this.getEliminatedTeams(currentTurn.alivePlayers);
      const winners = this.determineTeamWinners(teamScores, eliminatedTeams, currentTurnNumber);
      
      return {
        ...currentTurn,
        teamScores,
        eliminatedTeams,
        winners,
        turnNumber: currentTurnNumber,
      };
    }
    
    const baseTurn = super.applyMoves(currentTurn, moves);

    logger.info(`TeamSnek: Base turn applied. ${baseTurn}`);

    // Calculate team scores
    const teamScores = this.calculateTeamScores(baseTurn.playerPieces);

    logger.info(`TeamSnek: Team scores calculated. ${teamScores}`);

    // Check for elimited teams
    const eliminatedTeams = this.getEliminatedTeams(baseTurn.alivePlayers);

    logger.info(`TeamSnek: Eliminated teams calculated. ${eliminatedTeams}`);

    // Check win conditions
    const winners = this.determineTeamWinners(
      teamScores,
      eliminatedTeams,
      currentTurnNumber,
    );
    logger.info(`TeamSnek: Winners determined. ${winners}`);

    return {
      ...baseTurn,
      teamScores,
      eliminatedTeams,
      winners,
      turnNumber: currentTurnNumber,
    };
  }
  private calculateTeamScores(playerPieces: { [playerID: string]: number[] }): {
    [teamID: string]: number;
  } {
    const teamScores: { [teamID: string]: number } = {};
    logger.info(`TeamSnek: Calculating team scores. ${playerPieces}`)

    this.gameSetup.teams?.forEach((team) => {
      let teamSnakeLength = 0;
      let opponentSnakeLength = 0;

      // Calculate aggregate length of team's surviving snakes
      team.playerIDs.forEach((playerID) => {
        if (playerPieces[playerID]) {
          teamSnakeLength += playerPieces[playerID].length;
        }
      });

      // Calculate average aggregate length of opponent teams
      const opponentTeams =
        this.gameSetup.teams?.filter((t) => t.id !== team.id) || [];
      opponentTeams.forEach((opponentTeam) => {
        let opponentLength = 0;
        opponentTeam.playerIDs.forEach((playerID) => {
          if (playerPieces[playerID]) {
            opponentLength += playerPieces[playerID].length;
          }
        });
        opponentSnakeLength += opponentLength;
      });

      const avgOpponentLength =
        opponentTeams.length > 0
          ? opponentSnakeLength / opponentTeams.length
          : 0;
      teamScores[team.id] = teamSnakeLength - avgOpponentLength;
    });

    return teamScores;
  }

  private getEliminatedTeams(alivePlayers: string[]): string[] {
    return (
      this.gameSetup.teams
        ?.filter(
          (team) =>
            !team.playerIDs.some((playerID) => alivePlayers.includes(playerID)),
        )
        .map((team) => team.id) || []
    );
  }

  private determineTeamWinners(
    teamScores: { [teamID: string]: number },
    eliminatedTeams: string[],
    turnNumber: number,
  ): Winner[] {
    const remainingTeams =
      this.gameSetup.teams?.filter(
        (team) => !eliminatedTeams.includes(team.id),
      ) || [];

    // Game ends when only one team remains or max turns reached
    if (remainingTeams.length <= 1 || turnNumber >= this.maxTurns) {
      // If max turns reached, determine winners by highest team score
      if (turnNumber >= this.maxTurns && remainingTeams.length > 1) {
        const maxScore = Math.max(...remainingTeams.map(team => teamScores[team.id] || 0));
        const winningTeams = remainingTeams.filter(team => (teamScores[team.id] || 0) === maxScore);
        
        return winningTeams.map((team) => ({
          playerID: team.playerIDs[0], // Representative player
          teamID: team.id,
          score: teamScores[team.id] || 0,
          teamScore: teamScores[team.id] || 0,
          winningSquares: [], // Could include all team snake positions
        }));
      }
      
      // If only one team remains, they win
      return remainingTeams.map((team) => ({
        playerID: team.playerIDs[0], // Representative player
        teamID: team.id,
        score: teamScores[team.id] || 0,
        teamScore: teamScores[team.id] || 0,
        winningSquares: [], // Could include all team snake positions
      }));
    }

    return [];
  }
}
