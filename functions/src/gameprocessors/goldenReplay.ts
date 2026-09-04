// THE GOLDEN REPLAY HARNESS — shared by settlementReplay.spec.ts and
// pieceReplay.spec.ts.
//
// Both files play a whole game turn by turn and pin the produced turn stream
// as a byte-for-byte fixture. What differs between them is the board, the
// scenario and the seed; the loop that drives `applyMoves` from a
// hand-built turn 0, the canonicaliser and the `UPDATE_GOLDEN` escape hatch
// do not differ at all. This is a test helper, not production code, so it
// lives outside `engine/` and the vendor spec does not apply to it.

import { readFileSync, writeFileSync } from "fs"
import { Timestamp } from "firebase-admin/firestore"
import { GameState, Move, StartedGameSetup, Turn } from "@shared/types/Game"
import { TeamSnekProcessor } from "./TeamSnekProcessor"

const mkGameState = (setup: StartedGameSetup, turns: Turn[]): GameState => ({
  setup,
  turns,
  walls: [],
  timeCreated: Timestamp.fromMillis(0),
  timeFinished: null,
})

export const mv = (playerID: string, move: number): Move => ({
  gameID: "replay",
  moveNumber: 0,
  playerID,
  move,
  timestamp: Timestamp.fromMillis(0),
})

/** A seeded LCG, so a replay owns its own randomness rather than borrowing. */
const seededRandom = (seed: number): (() => number) => {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

export interface ReplayScript {
  setup: StartedGameSetup
  startingTurn: Turn
  /** The cells staged this turn, by unit. Absent ids stage nothing. */
  moves: (turn: number, alive: string[]) => Move[]
  turns: number
  seed: number
}

/** Plays `script.turns` turns and returns every turn the processor produced. */
export const runReplay = (script: ReplayScript): Turn[] => {
  const original = Math.random
  Math.random = seededRandom(script.seed)
  try {
    const turns: Turn[] = [script.startingTurn]
    const produced: Turn[] = []
    for (let turn = 1; turn <= script.turns; turn++) {
      const current = turns[turns.length - 1]
      const processor = new TeamSnekProcessor(mkGameState(script.setup, turns))
      const moves = script.moves(turn, current.alivePlayers)
      const next = processor.applyMoves(current, moves)
      turns.push(next)
      produced.push(next)
    }
    return produced
  } finally {
    Math.random = original
  }
}

/**
 * Key order is not a wire fact (Firestore stores documents, not JSON text), so
 * the fixture is canonicalised with sorted keys. Array order IS a wire fact —
 * the clash stream and a piece's traversed path are both ordered — and is kept.
 */
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === "object") {
    const source = value as { [key: string]: unknown }
    const out: { [key: string]: unknown } = {}
    Object.keys(source)
      .sort()
      .forEach((key) => {
        out[key] = canonical(source[key])
      })
    return out
  }
  return value
}

export const serialise = (stream: Turn[]): string =>
  `${JSON.stringify(canonical(stream), null, 2)}\n`

/** Set UPDATE_GOLDEN=1 to re-record. Only ever legitimate before a move. */
export const check = (actual: string, path: string): void => {
  if (process.env.UPDATE_GOLDEN === "1") writeFileSync(path, actual)
  expect(actual).toBe(readFileSync(path, "utf8"))
}
