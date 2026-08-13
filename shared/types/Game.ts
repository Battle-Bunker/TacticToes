// @shared/types/Game.ts

export type Timestamp = any
export type FieldValue = any

export interface Winner {
  playerID: string
  score: number
  winningSquares: number[]
  mmrChange?: number
  newMMR?: number
  teamID: string
  teamScore: number
}

export interface Move {
  gameID: string
  moveNumber: number
  playerID: string
  move: number // Full-board index of the target square (perimeter included)
  timestamp: FieldValue | Timestamp // Must be a server timestamp
}

export interface MoveStatus {
  moveNumber: number
  alivePlayerIDs: string[]
  movedPlayerIDs: string[]
}

export interface Session {
  latestGameID: string | null
  timeCreated: Timestamp | FieldValue
  owner?: string | null
}

// A team is one centaur plus its snakes: id and name come from the centaur.
export interface Team {
  id: string // == centaur id
  name: string // snapshot of the centaur's name when added
  color: string
}

// Unit kinds. Absent unitType fields mean "snake" (legacy games).
export type UnitType = "snake" | "pawn" | "knight" | "bishop" | "rook" | "queen" | "king"

// Per-team unit counts. Absent → snakesPerTeam snakes (legacy behavior).
export interface UnitCounts {
  snake?: number
  pawn?: number
  knight?: number
  bishop?: number
  rook?: number
  queen?: number
  king?: number
}

// Per-type max health. Absent keys (or the whole map) mean 100.
export interface UnitMaxHealth {
  snake?: number
  pawn?: number
  knight?: number
  bishop?: number
  rook?: number
  queen?: number
  king?: number
}

export interface GameSetup {
  teams: Team[]
  snakesPerTeam: number
  unitsPerTeam?: UnitCounts // When present, snakesPerTeam is ignored by expansion
  pawnPromotionWeight?: number // Pawns promote to queens at this weight (default 10)
  maxHealthPerUnit?: UnitMaxHealth // per-type max health, default 100
  boardWidth: number
  boardHeight: number
  maxTurnTime: number // Time limit per turn in seconds
  firstTurnTime?: number // Time limit for turn 0 in seconds (defaults to 60)
  startRequested: boolean
  started: boolean // Set true when GameState is created to avoid double handling
  timeCreated: Timestamp | FieldValue
  maxTurns?: number
  hazardPercentage?: number // Percentage of the board to fill with hazards (defaults to 0)
  hazardDamage?: number // health lost per hazard square entered (default 100)
  teamClustersEnabled?: boolean
  fertileGroundEnabled?: boolean
  fertileGroundDensity?: number // Percentage of tiles that are fertile (0-100)
  fertileGroundClustering?: number // Clustering level 1-20 (1=scattered, 20=blobby, 10=default)
  presetFertileTiles?: number[]
  presetHazards?: number[]
  presetPlayerPositions?: { [playerID: string]: number }
  presetFood?: number[]
  usePreviewBoard?: boolean
  foodSpawnRate?: number // Expected food spawned per turn (0-5, defaults to 0.5)
  invulnerabilityPotionEnabled?: boolean
  invulnerabilityPotionSpawnRate?: number // 0.05 to 1, defaults to 0.15
  tournamentMode?: boolean
  scheduledStartTime?: Timestamp | null
  remainingRounds?: number
  interludeDuration?: number
}

// One snake on the board. Generated server-side at game start from
// teams x snakesPerTeam: the first snake of a team has id == team.id,
// the rest are `${team.id}#${k}` (k = 2..snakesPerTeam).
export interface GamePlayer {
  id: string
  teamID: string
  letter: string // "A".."Z", consecutive within the team
  unitType?: UnitType // Initial unit type; absent means "snake"
}

// The setup as embedded in a started game document.
export interface StartedGameSetup extends GameSetup {
  gamePlayers: GamePlayer[]
}

export interface GameState {
  setup: StartedGameSetup
  turns: Turn[]
  walls: number[] // Static board perimeter, written once at game creation
  timeCreated: Timestamp | FieldValue
  timeFinished: Timestamp | FieldValue | null
}

// users/{uid} — Google-authenticated account. Only `name` is stored.
export interface UserProfile {
  name: string
}

// centaurs/{id} — a centaur is a Firebase-connected snake controller.
export interface Centaur {
  id: string
  name: string
  owner: string // uid of the owning user
  public: boolean // whether other users may add this centaur to their games
  createdAt: Timestamp | FieldValue
}

export interface Turn {
  playerHealth: { [playerID: string]: number }
  startTime: Timestamp
  endTime: Timestamp
  scores: { [playerID: string]: number }
  alivePlayers: string[]
  food: number[]
  hazards: number[]
  playerPieces: { [playerID: string]: number[] } // Snake body (index 0 = head) or a chess piece's weight-stack (N copies of its square)
  clashes: Clash[]
  moves: { [playerID: string]: number } // Square each unit actually ended its move on (truncated sliders record their stop square)
  winners: Winner[]
  teamScores?: { [teamID: string]: number }
  teamClusterFallback?: boolean // Team clusters requested but fell back
  unitTypes?: { [playerID: string]: UnitType } // Current type per unit (changes on pawn promotion); absent in snake-only games
  unitFacing?: { [playerID: string]: { dx: number; dy: number } } // Pawn facing; updated when a pawn spends its turn rotating
  paths?: { [playerID: string]: number[] } // Squares each chess piece actually traversed this turn (snakes excluded)
  fertileTiles?: number[]
  invulnerabilityPotions?: number[]
  playerInvulnerabilityLevel?: { [playerID: string]: number }
  activeEffects?: ActiveEffect[]
}

export interface ActiveEffect {
  playerID: string
  type: "invulnerability_buff" | "invulnerability_debuff"
  level: number
  expiryTurn: number
  sourcePlayerID: string
}

export interface Clash {
  index: number
  playerIDs: string[]
  reason: string
  subStep?: number // Which within-turn sub-step an in-flight clash happened on (piece games only)
}

export interface GameResult {
  sessionID: string
  gameID: string
  timestamp: Timestamp
  previousMMR: number
  mmrChange: number
  placement: number
  opponents: OpponentInfo[]
}

// rankings/{centaurId}
export interface Ranking {
  currentMMR: number
  gamesPlayed: number
  wins: number
  losses: number
  gameHistory: GameResult[]
  lastUpdated: Timestamp | FieldValue
}

export interface OpponentInfo {
  playerID: string
  mmr: number
  placement: number
}
