// import { Timestamp } from "firebase-admin/firestore";
// import { TeamSnekProcessor } from "./TeamSnekProcessor";
// import {
//   GamePlayer,
//   GameSetup,
//   GameState,
//   GameType,
//   Player,
//   Team,
//   Turn,
// } from "@shared/types/Game";
// import { expect, describe, it } from "@jest/globals";

// jest.mock("firebase-admin/firestore", () => ({
//   Timestamp: {
//     fromMillis: (ms: number) => ({ toMillis: () => ms }),
//     now: () => ({ toMillis: () => Date.now() }),
//   },
// }));

// jest.mock("../logger", () => ({
//   logger: {
//     info: jest.fn(),
//     debug: jest.fn(),
//     warn: jest.fn(),
//     error: jest.fn(),
//     fatal: jest.fn(),
//   },
// }));

// const nowTs = () => Timestamp.fromMillis(Date.now());

// const mkGameState = (overrides?: {
//   maxTurns?: number;
//   boardWidth?: number;
//   boardHeight?: number;
//   maxTurnTime?: number;
//   gameType?: GameType;
//   players?: Player[];
//   teams?: Team[];
//   gamePlayers?: GamePlayer[];
//   gameMode?: "individual" | "team";
// }): GameState => {
//   const gamePlayers: GamePlayer[] = overrides?.gamePlayers ?? [
//     { id: "p1", type: "human", teamID: "t1" },
//     { id: "p2", type: "human", teamID: "t2" },
//   ];

//   // 2) Build valid Team[] (must include id, name, color, playerIDs)
//   const teams: Team[] = overrides?.teams ?? [
//     { id: "t1", name: "Team 1", color: "#FF0000", playerIDs: ["p1"] },
//     { id: "t2", name: "Team 2", color: "#0000FF", playerIDs: ["p2"] },
//   ];
//   const baseSetup: GameSetup = {
//     gameType: overrides?.gameType ?? "teamsnek",
//     gamePlayers,
//     boardWidth: overrides?.boardWidth ?? 7,
//     boardHeight: overrides?.boardHeight ?? 7,
//     playersReady: [], // required by your type; empty is fine
//     maxTurnTime: overrides?.maxTurnTime ?? 5,
//     startRequested: false, // required boolean
//     started: true, // set true to reflect “created” state
//     timeCreated: Timestamp.now(), // required timestamp
//     teams, // our valid teams
//     maxTurns: overrides?.maxTurns ?? 100, // TeamSnek reads this
//     gameMode: overrides?.gameMode ?? "team", // sensible default for TeamSnek
//   };

//   return {
//     setup: baseSetup,
//     turns: [],
//     timeCreated: nowTs(),
//     timeFinished: null,
//   };
// };

// // // Utility: choose a move that will collide with a wall (guaranteed on 3x3 board).
// // const chooseWallMoveFor = (turn: Turn, playerId: string): number => {
// //     const walls = new Set<number>(turn.walls)
// //     const options = turn.allowedMoves[playerId]
// //     const wallMove = options.find((o) => walls.has(o))
// //     if (wallMove == null) {
// //       throw new Error("No wall-adjacent move found — use a 3x3 board for this test.")
// //     }
// //     return wallMove
// //   }

// //   // Freeze Math.random so food spawning (0.5 chance) is deterministic.
// //   let realRandom: () => number
// //   beforeAll(() => {
// //     realRandom = Math.random
// //     Math.random = () => 0.99 // never spawn food
// //   })
// //   afterAll(() => {
// //     Math.random = realRandom
// //   })
// // const perimeterCount = (W: number, H: number) => 2 * W + 2 * (H - 2)

// // describe("TeamSnekProcessor — First Turn Tests", () => {
// //     it("constructs without crashing with minimal valid GameState", () => {
// //         const gameState = mkGameState()
// //         const processor = new TeamSnekProcessor(gameState)
// //         console.log("processor", processor)
// //         expect(processor).toBeInstanceOf(TeamSnekProcessor)
// //     })

// //     // Testing first turn
// //     it("adds team-specific fields correctly (teamScores, turnNumber=0, eliminatedTeams=[])", () => {
// //         const gameState = mkGameState()
// //         const processor = new TeamSnekProcessor(gameState)
// //         const turn = processor.firstTurn()
// //         console.log("firstTurn", turn)

// //         // Team score exists
// //         expect(turn).toHaveProperty("teamScores")

// //         // turnNumber starts at 0
// //         expect(turn.turnNumber).toEqual(0)

// //         // Eliminated teams is an empty array
// //         expect(turn.eliminatedTeams).toEqual([])
// //     })

// //     it("includes all the base Snek fields with sane initial values", () => {
// //         const gs = mkGameState()
// //         const proc = new TeamSnekProcessor(gs)
// //         const turn = proc.firstTurn()

// //         // Everyone starts alive
// //         const expectedAlive = gs.setup.gamePlayers.map(p => p.id).sort()
// //         expect([...turn.alivePlayers].sort()).toEqual(expectedAlive)

// //         // Each player has a snake of length 3, and score mirrors length
// //         gs.setup.gamePlayers.forEach(p => {
// //           expect(turn.playerPieces[p.id]).toBeDefined()
// //           expect(turn.playerPieces[p.id].length).toBe(3)
// //           expect(turn.scores[p.id]).toBe(3)
// //         })

// //         // No hazards, no clashes, no moves, no winners on the first turn
// //         expect(turn.hazards).toEqual([])
// //         expect(turn.clashes).toEqual([])
// //         expect(turn.moves).toEqual({})
// //         expect(turn.winners).toEqual([])

// //         // Food and walls are arrays
// //         expect(Array.isArray(turn.food)).toBe(true)
// //         expect(Array.isArray(turn.walls)).toBe(true)

// //         // Start/end times exist and the duration equals maxTurnTime * 1000
// //         const startMs = (turn.startTime as any).toMillis()
// //         const endMs = (turn.endTime as any).toMillis()
// //         expect(endMs - startMs).toBe(gs.setup.maxTurnTime * 1000)
// //       })

// //       it("respects board invariants (walls perimeter, indices in range, center food present)", () => {
// //         const gs = mkGameState({ boardWidth: 7, boardHeight: 7 }) // odd sizes → single center cell
// //         const proc = new TeamSnekProcessor(gs)
// //         const turn = proc.firstTurn()

// //         const { boardWidth: W, boardHeight: H } = gs.setup
// //         const totalCells = W * H
// //         const inRange = (i: number) => i >= 0 && i < totalCells

// //         // Walls count equals perimeter count
// //         expect(turn.walls.length).toBe(perimeterCount(W, H))

// //         // All indices (snakes + food + walls) are within board bounds
// //         Object.values(turn.playerPieces).forEach(snake => {
// //           snake.forEach(idx => expect(inRange(idx)).toBe(true))
// //         })
// //         turn.food.forEach(idx => expect(inRange(idx)).toBe(true))
// //         turn.walls.forEach(idx => expect(inRange(idx)).toBe(true))

// //         // Center cell is included in food (per your initializeFood contract)
// //         const centerIndex = Math.floor(H / 2) * W + Math.floor(W / 2)
// //         expect(turn.food).toContain(centerIndex)

// //         // No food on walls, and no food on any snake segment
// //         const occupied = new Set<number>(turn.walls)
// //         Object.values(turn.playerPieces).forEach(snake => snake.forEach(i => occupied.add(i)))
// //         turn.food.forEach(f => {
// //           expect(occupied.has(f)).toBe(false)
// //         })
// //       })

// //       it("handles 'no teams' gracefully (teamScores={}, eliminatedTeams=[])", () => {
// //         const gs = mkGameState({ teams: [] }) // explicitly no teams
// //         const proc = new TeamSnekProcessor(gs)
// //         const turn = proc.firstTurn()

// //         // teamScores should be an empty object
// //         expect(turn.teamScores).toEqual({})
// //         // eliminatedTeams should be an empty array
// //         expect(turn.eliminatedTeams).toEqual([])
// //       })
// // })
