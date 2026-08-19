# Chess pieces in Team Snek

Chess pieces are optional unit types that coexist with snakes on the board.
Game config allows any number of each unit type per team, including zero
snakes (the pure chess variant).

## Owner decisions (locked)

- **Roster**: pawn, knight, bishop, rook, queen, king — plus snakes.
- **Stationary pieces are contested by weight** ("piece = head"): any unit
  entering a piece's square fights it by invulnerability tier first, then
  weight. Snake *bodies* remain absolute walls exactly as today (equal-tier
  mover dies; strictly-higher-tier mover severs).
- **A mid-path winner stops on the kill square**: capture ends the move, and
  the mover pays health only for squares actually traversed.
- **Food is eaten at the destination only**: a slider passing over food
  leaves it on the board. Eating happens in the existing post-collision food
  phase.
- **Regicide**: a team whose config includes kings is eliminated when its
  last king dies — all its remaining units are removed that turn. Teams
  configured without kings play pure attrition, as today.

## Unit model

- A chess piece occupies one square, represented in `Turn.playerPieces` as a
  stack: `weight` copies of that square (the engine's existing idiom for
  "mass on one cell" — snakes spawn as `[pos, pos, pos]`). Weight = array
  length, so scoring, team scores, winner adjudication, and the wire format
  all work unchanged.
- Pieces start at weight 1. Eating food: +1 weight (push a duplicate) and
  health restored to 100, same as snakes. A promoting pawn is the one place
  weight goes down without a death: it returns to weight 1 as a queen.
- A snake's weight is its length, including stacked tail segments. Severing
  reduces it automatically.
- Weight never decays. Nothing is gained from a kill. Dead units vanish
  without a drop.

## Movement

Moves stay a single destination square index on the wire (`Move.move`).
The path is derived: unique straight ray for rook/bishop/queen, single jump
for the knight, single step for king/pawn.

Every unit in every game carries an orientation (`Turn.orientation`) —
snake-only games included. At spawn every unit faces toward the board
centre, chosen from its type's legal orientation set; each turn
thereafter a unit that moved faces the way it moved, a unit that held
keeps its orientation, and pawns change orientation only via their rotation action.
For pawns alone, orientation is also engine-legality-bearing (see below).

- **Rook**: any distance along a row/column. **Bishop**: along a diagonal.
  **Queen**: either. Range is unlimited (health cost is the limiter).
- **Knight**: the 8 L-jumps; touches only its destination.
- **King**: 1 step in any of the 8 directions.
- **Pawn**: has an orientation, assigned at spawn (toward the board centre, like
  every unit). Each turn a pawn may do exactly one of:
  - step 1 square **straight forward**;
  - step 1 square **diagonal-forward**, but only to attack or eat — legal
    only when that square holds food or another unit at the start of the
    turn (if the occupant moves away in flight, the pawn still completes
    the staged step onto the vacated square — moves are simultaneous);
  - **rotate 90°** left or right, a full-turn action with no movement and
    no movement health cost. On the wire this is staged as the pawn's
    left/right *side* square (never a legal step for a pawn), meaning
    "face that way"; `turn.moves` records the pawn's own square (it did
    not move) and the new orientation appears in `Turn.orientation`. Turning
    around fully costs two turns;
  - stay (also the default).
  The square directly behind is never a legal destination.
  **Promotion**: at weight ≥ `pawnPromotionWeight` (config, default 10) a
  pawn becomes a queen. It keeps id, letter, orientation and current health
  (clamped down to the queen's configured max if it was carrying more), and
  **resets to weight 1** — its stack collapses to the single square it
  occupies. The accumulated mass is the price of the queen's mobility. The
  queen's `maxHealthPerUnit` entry therefore applies to any game with pawns,
  whether or not queens are fielded at spawn.
- **Staying still is legal and free** of movement cost. It is also the
  default when a piece stages nothing or stages an illegal destination
  (pieces have no momentum; the snake default of "continue straight" has no
  analog). The applied move is recorded in `turn.moves` as the piece's own
  square.
- A destination is illegal if it is not on a legal ray/jump/step, or if any
  traversed square is out of bounds or a wall. Illegal → stay.
- Chess-style blocking does not exist at staging time: moves are
  simultaneous and hidden, so a "blocker" may itself move away. Whether a
  path is actually blocked is discovered in flight. There is no friendly
  exemption anywhere, matching the engine.

## Health

Health loss is tied to movement, not turns — there is no universal per-turn
tick.

- **Snakes** always move exactly 1 cell per turn, so a snake pays 1 health
  on every non-eating turn (the same net drain as before).
- **Pieces** pay 1 health per square actually traversed: sliders pay 1 per
  square entered, the knight's jump costs a flat 1 total, a king/pawn step
  costs 1, and staying or rotating costs 0. A stationary piece spends
  nothing — low-max-health kings are cheap to hold and risky to move.
- **Eating** at the final square restores health to the unit type's
  configured max (`maxHealthPerUnit`, default 100) instead of paying costs.
- All of this resolves in one **central health-accounting function** shared
  by the snake-only path and the chess path (the food phase at the end of
  the turn): eat → restore to type max, else
  `health -= movementCost + stationaryHazardDose`, and ≤ 0 dies on its
  final square with the "Died due to zero health" clash. (A piece may
  therefore complete a move it cannot afford and die on arrival.) The
  snake-only path calls the same function with no chess state and reduces
  exactly to the original 1/turn starvation tick.

### Hazard damage

- Hazards deal `GameSetup.hazardDamage` (default 100 — usually lethal, but
  configurable 1..1000) instead of certain death.
- **Per-square entry dose**: a mover pays one dose for every hazard square
  it enters, deducted immediately at the sub-step where it happens. Snakes
  pay on head entry, as before — they always move, so the entry dose is the
  only hazard charge they ever pay.
- **Mid-flight death**: a mover whose health hits ≤ 0 on a hazard square
  dies right there (the "Entered hazard" clash records the square and
  sub-step). A mover that survives the dose keeps going — a slider can
  cross a hazard field and come out the other side, paying per square.
- **Stationary dose**: a piece that did not move this turn and sits on a
  hazard square takes exactly one dose in the central health function.
  There is no double-dosing: a mover that stopped ON a hazard square
  already paid on entry and pays nothing extra that turn.

## Within-turn sub-step simulation

Piece games resolve each turn as a sequence of sub-steps; sub-step count =
the longest path staged this turn.

- **Sub-step 1**: snakes make their entire move (tail pops first, exactly as
  today), knights land, kings/pawns step, sliders advance their first
  square.
- **Sub-steps 2..k**: sliders advance one square each; everything else is a
  stationary occupant.
- Dead units vacate immediately: their squares are free from the moment they
  die, including for later arrivals in the same turn.
- **Same-square meeting**: all units on a square where someone arrived this
  sub-step are adjudicated together — invulnerability tier first (everyone
  below the top tier dies), then weight among the top tier: the unique
  heaviest survives, any tie kills all (the existing at-most-one-survivor
  rule).
- **Snake bodies** (segments behind the head, including stacked tails) stay
  walls: an equal-or-lower-tier unit entering one dies; a strictly higher
  tier severs the snake at the contacted segment. A severing slider stops on
  that square (capture-stops).
- **Edge swaps**: two pieces exchanging squares through the same edge in the
  same sub-step collide in flight (tier, then weight; winner finishes on its
  target square and stops; tie kills both). Knights never swap — a jump does
  not traverse edges. Snake-vs-piece and snake-vs-snake swaps need no rule:
  the snake's body sweeps in behind its head, so the piece (or other snake)
  hits a body segment, which resolves by the body rules above.
- Perpendicular diagonal crossings that never share a square do not collide;
  collisions are square-based.
- Two units crossing the same square at different sub-steps do not collide.
- **Hazards** dose a mover `hazardDamage` per hazard square entered, at any
  sub-step (mid-flight); ≤ 0 health dies on that square, survivors keep
  going. Snakes are dosed on head entry. See "Hazard damage" above.
- Weights are fixed for the whole simulation (growth happens in the food
  phase, after collisions — same as today's snakes; promotion's weight reset
  is later still, after regicide and orientation, so nothing this turn is
  adjudicated against the reset weight).

Snake-only games (no piece units configured) resolve in a single pass:
every snake moves exactly one square per turn, so there is nothing for
sub-steps to order.

## Wire format

- `GameSetup.unitsPerTeam?: { snake?, pawn?, knight?, bishop?, rook?,
  queen?, king? }` — counts per team. Absent → `snakesPerTeam` snakes.
  When present, `snakesPerTeam` is ignored by expansion.
- `GamePlayer.unitType?: UnitType` — absent means `"snake"`.
- `Turn.unitTypes?: { [playerID]: UnitType }` — current type per unit
  (changes on pawn promotion); absent in snake-only games.
- `Turn.orientation: { [playerID]: { dx, dy } }` — per-unit orientation,
  written for **every** unit in **every** game, snake-only games
  included. Rewritten every turn: a unit that moved faces
  the direction it moved — sliders/king the unit step (e.g. `{1,0}`,
  `{1,1}`), knight its exact L-offset (e.g. `{1,-2}`), snake head minus
  neck — while units that stayed keep their previous orientation and dead units
  drop out. Pawns are the exception: forward and diagonal steps never
  rotate them; only their rotation action changes orientation. Spawn (turn 0):
  every unit faces toward the board centre, chosen from its type's legal
  orientation set (snake/rook/pawn: the 4 orthogonals; bishop: the 4
  diagonals; queen/king: all 8; knight: its 8 L-offsets) — the candidate
  with minimal angle to the spawn→centre vector, ties (spawn on a symmetry
  axis, or exactly at centre) resolved uniformly at random.
- `Turn.paths?: { [playerID]: number[] }` — squares each piece actually
  traversed this turn (for animation/inspection). A dead piece's path ends
  at the square it died on. Snakes are not included, and neither is a
  piece that did not move (it has no traversed squares).
- `Clash.subStep?: number` — which sub-step an in-flight clash happened on.
- `turn.moves` remains one integer per player: the square the unit actually
  ended its move on (a truncated slider records its stop square). This is
  the death-square guarantee for clients: a piece that dies mid-path
  records the square it died on — never its origin or staged destination —
  and the clash recording the death carries the same square (with its
  `subStep`). A dead snake records its attempted head square.

## Scoring & elimination

- Piece score = weight (`playerPieces[id].length`), so team score = sum of
  weights, and turn-limit/MMR adjudication work unchanged. Note the start
  asymmetry: a snake spawns worth 3, a piece worth 1.
- Promotion costs score: the promoting team's score drops by
  `pawnPromotionWeight - 1` on that turn. Adjudication reads the post-promotion
  board, so a promotion on the final turn is scored at weight 1.
- A team is alive while any of its units is alive — plus the regicide rule
  for teams configured with kings. Weight never reaches 0 by promotion (the
  queen stands on its square at weight 1), so promoting can never eliminate a
  unit or a team.

## Implementer judgment calls (reported, not escalated)

- Spawning uses the shared placement machinery (radial team slices when team
  clusters are on), with pieces interleaved among snakes. Chess-style
  formations can come later.
- Pieces participate fully in the invulnerability system (potions at the
  destination square, ally buffs, debuffs, tiers).
- Knight movement health cost is a flat 1 total for the jump (there is no
  universal per-turn tick to add on top).
- Self-collision checks skip pieces (a stack is all on one square by
  construction).
- Board capacity guard now counts total units per team.
