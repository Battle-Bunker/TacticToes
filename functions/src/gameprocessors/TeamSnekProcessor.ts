import { GameState, Move, Turn, Winner } from "@shared/types/Game";
import { SnekProcessor } from "./SnekProcessor";


export class TeamSnekProcessor extends SnekProcessor {
  private maxTurns: number = 100
  constructor(gameState: GameState) {
    super(gameState)
    this.maxTurns = gameState.setup.maxTurns || 100
  }

  firstTurn(): Turn{
    const baseTurn = super.firstTurn()

    // Add team-speicific initialization   
    const teamScores: { [teamID: string]: number } = {}
    this.gameSetup.teams?.forEach((team) => {
      teamScores[team.id] = 0
    })

    return {
        ...baseTurn,
        teamScores,
        turnNumber: 0,
        eliminatedTeams: [],
    }
  }

  applyMoves(currentTurn: Turn, moves: Move[]): Turn {
    const baseTurn = super.applyMoves(currentTurn, moves)

    // Calculate team scores
    const teamScores = this.calculateTeamScores(baseTurn.playerPieces)

    // Check for elimited teams
    const eliminatedTeams = this.getEliminatedTeams(baseTurn.alivePlayers)

       // Check win conditions
       const winners = this.determineTeamWinners(
        teamScores,
        eliminatedTeams,
        baseTurn.turnNumber || 0
      );
  
      return {
        ...baseTurn,
        teamScores,
        eliminatedTeams,
        winners,
        turnNumber: (baseTurn.turnNumber || 0) + 1,
      };

  }
  private calculateTeamScores(playerPieces: { [playerID: string]: number[] }): {
    [teamID: string]: number;
  } {
    const teamScores: { [teamID: string]: number } = {};

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
            !team.playerIDs.some((playerID) => alivePlayers.includes(playerID))
        )
        .map((team) => team.id) || []
    );
  }

  private determineTeamWinners(
    teamScores: { [teamID: string]: number },
    eliminatedTeams: string[],
    turnNumber: number
  ): Winner[] {
    const remainingTeams =
      this.gameSetup.teams?.filter(
        (team) => !eliminatedTeams.includes(team.id)
      ) || [];

    // Game ends when only one team remains or max turns reached
    if (remainingTeams.length <= 1 || turnNumber >= this.maxTurns) {
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