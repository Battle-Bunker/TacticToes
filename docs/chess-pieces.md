# The turn engine (spec v2)

Every game — snake-only, pure chess, or mixed — resolves its turn in ONE
engine: `functions/src/gameprocessors/engine/turnEngine.ts`. There is no
snake path and no piece path. Game config allows any number of each unit type
per team, including zero snakes (the pure chess variant) and zero pieces (the
classic variant).

## Owner decisions (locked)

- **Roster**: pawn, knight, bishop, rook, queen, king — plus snakes.
- **One engine, property-driven**: the engine never asks what KIND a unit is.
  Unit-kind names survive only in the movement grammar
  (`engine/moveGrammar.ts`), spawn config, regicide (kings) and promotion
  (pawns).
- **Stationary units are contested by weight** ("piece = head"): any unit
  entering an occupied cell fights the occupant by invulnerability tier first,
  then weight. Trail (snake) *bodies* are walls: an equal-or-lower-tier mover
  dies on them, a strictly-higher-tier mover severs.
- **A mid-path winner stops on the kill cell**: capture ends the move, and the
  mover pays health only for cells actually entered.
- **Food is eaten at the destination only**: a slider passing over food leaves
  it on the board. Eating happens in the end-of-turn food phase.
- **Regicide**: a team whose config includes kings is eliminated when its last
  king dies — all its remaining units are removed that turn. Teams configured
  without kings play pure attrition.

## Unit model

The engine sees one kind of thing, a unit with behavioural properties:

- `leavesTrail` — occupancy trails the head, and the trail cells are
  body-walls that can be severed. True for snakes only.
- `traversesEdges` — false for jumps (knights), which therefore never contest
  an edge. It is the ONLY thing that exempts a unit from an edge exchange:
  having a trail does not.
- `path` — the cells to enter, ONE PER SUB-STEP. "Snakes move only in
  sub-step 1" is not a rule: it is what a path of length 1 means.
- `weightAtTurnStart`, `tier` — frozen for the whole turn (see below).
- `health` — the only thing that advances within the turn.
- `status` — `active | stopped | exhausted | dead`. Exhausted is not dead:
  see "Exhaustion is provisional death" below.

Occupancy on the wire (`Turn.playerPieces`) is unchanged: a snake's body
(index 0 = head), or a piece's weight-stack (`weight` copies of its cell).
Weight = array length, so scoring, team scores, winner adjudication and the
wire format all work unchanged.

Pieces start at weight 1, snakes at 3. Eating: +1 weight and health restored
to the type's configured max. A promoting pawn is the one place weight goes
down without a death: it returns to weight 1 as a queen. Weight never decays.
Nothing is gained from a kill.

## Frozen state

**All collision adjudication reads the tier and weight each unit held at the
START of the turn.**

Board occupancy changes within the turn ONLY through movement (a trail sweep
including the tail pop, a piece stack teleporting) and halting — **never
through removal**. Dead units, exhausted units and severed segments all stay
on the board until the collision phase (every sub-step) has finished — the
dead as collision objects, the exhausted as their live selves.

Consequences worth stating outright:

- A corpse still blocks, and still fights, for the rest of the turn.
- A snake severed at sub-step 2 still fights at its pre-sever weight at
  sub-step 7, and its cut segments still block until the turn ends.
- Growth and promotion happen after the collision phase, so nothing this turn
  is ever adjudicated against a weight that changed this turn.

## Sub-step loop: snapshot → resolve → apply

Sub-step count = the longest path staged this turn. Per sub-step:

1. **Advance** every mover with a cell for this sub-step (trail units pop the
   tail before the head lands; piece stacks teleport). The tail pop is
   unconditional — nothing later in the sub-step puts a tail back.
2. **Detect** every collision event against the post-advance snapshot: edge
   exchanges, cell co-arrivals, arrivals onto living body/trail cells,
   arrivals onto persistent collision objects.
3. **Adjudicate** each event against that snapshot and the frozen tier/weight
   ALONE. No adjudication may read anything a sibling adjudication wrote, so
   the outcome is identical under any unit ordering.
4. **Apply** the whole batch at once: deaths (victims halt in place and
   persist as collision objects), edge-loser fallbacks, capture-stops, sever
   registrations, durable-cell registrations.
5. **Health phase**, strictly after the collisions (see below).

Adjudication proceeds in fixed TIERS within one sub-step — edge exchanges
(they decide who actually completed a crossing), then walls, then
self-collisions, then arrivals, then living bodies. Each tier is a pure
function of the snapshot plus the tiers before it; within a tier, every event
sees the board as that tier found it. That is what makes a whole sub-step
order-independent rather than iteration-order dependent.

### Collision rules

Tier first, then frozen weight; **at most one unique strict maximum
survives**, and any tie leaves nobody standing.

- **Edge exchange** — two units whose HEADS exchange through the same edge in
  one sub-step. **This is uniform across every unit — trails make no
  difference.** The only exemption is `traversesEdges === false`, i.e. a jump:
  a knight crosses no edge. (In current geometry no unit can actually exchange
  heads with a knight, since an L-offset never lands on an adjacent cell; the
  exemption is stated for the rule, not for a live case.) The contest is
  head-to-head and is settled before either head reaches the far side, so
  neither unit is ever charged for the cell it did not enter.
  - Unique winner: it completes into the loser's start-of-sub-step head cell
    and capture-stops (if it had path remaining). It is registered as the
    SURVIVOR of that cell, not re-adjudicated against the pile it just made
    there; a later arrival contests the winner plus that pile in one
    cumulative contest, as usual.
  - Loser: **squashed against its own neck.** It dies at the cell its head
    held at the start of the sub-step — its clash record, its `paths` entry
    and its `moves` cell are all that cell, never the one it tried to swap
    into. Only the HEAD is reverted: **the tail pop is unconditional and
    stands**, because tails depart deterministically and are never contingent
    on a contest ahead of the head. So a swap-losing trail unit's final
    occupancy is its start-of-turn body MINUS the popped tail cell — which for
    a length-1 unit is nothing at all: it cleared its cell completely and was
    squashed against empty space. It is still a collision object at its death
    cell for the rest of the turn. Pieces have no trail, so their whole stack
    simply reverts.
  - Tie: both are squashed at their own head cells, one clash record each.
  - Consequence: two length-≥2 snakes exchanging heads resolve by frozen tier
    then frozen WEIGHT — not by running into each other's necks. A piece
    exchanging heads with a snake is the same contest. Head *chasing* (the
    target moves away, or perpendicular) is not an exchange and still resolves
    through the body-wall rules below: you cannot chase a head, because by the
    time you arrive the cell it left is its neck.
- **Cell contest** — every head-class occupant of a cell somebody arrived at
  (arrivers and stationary units alike) plus everything the cell's pile holds.
  The unique maximum survives (and stops, if it was mid-path); everyone else
  dies there.
- **Living body/trail cells** — an arriving unit at tier ≤ the owner's tier
  dies there (`bodyBlock`). A strictly higher tier SEVERS (`sever`,
  non-fatal — the owner is not a victim) and capture-stops. Severed segments
  REMAIN blocking as the owner's body for the rest of the collision phase; the
  truncation and the weight loss apply only at end of turn. Several severs on
  one owner: each is recorded, and at end of turn the LOWEST cut index wins —
  the deepest bite. `Turn.severedCells` lists the cells actually removed from
  survivors. Every owner at a cell is judged together, and "living owner"
  means living as the body tier found the board — so two snakes that run into
  each other's necks both die, whichever order the roster lists them in.
- **Persistent collision objects (the wrestling rule)** — from the moment a
  unit dies, its ENTIRE remaining occupancy becomes durable
  collision cells, as does any cell where a fatal contest happened. A unit
  arriving at such a cell on a later sub-step joins that cell's CUMULATIVE
  contest against every prior participant there, on frozen tier and weight. It
  survives only as the unique strict maximum of the whole pile (and then
  capture-stops there); otherwise it dies there and joins the pile. Units that
  crossed the cell before its first death are unaffected.
- **Walls** kill any mover that enters one (checked for every mover, though in
  practice only trail units can: piece destinations are grammar-validated).
  **Self-collision** applies to trail units only — a piece stack is all on one
  cell by construction.

### Health, per sub-step

Health loss is tied to movement, not turns. There is no per-turn tick, and
nothing is settled at end of turn any more.

- **Movement cost**: 1 health per cell entered, charged in the sub-step where
  it is entered. A snake enters exactly one cell per turn, so it still pays
  1/turn. A knight's jump is one cell entered, so a flat 1. Staying or
  rotating enters nothing and costs nothing.
- **Hazard damage**: `GameSetup.hazardDamage` (default 100 — usually lethal,
  configurable) per hazard cell entered, charged the same sub-step. A unit
  that does not move at all and stands on a hazard pays exactly one dose, at
  sub-step 1.
- **Exhaustion**: health ≤ 0 makes the unit `exhausted` — see the section
  below. It halts immediately at the cell it reached, stays a live collision
  incumbent, and may or may not die for it.
- **Units halt mid-ray from running out of health.** A slider that cannot
  afford its ray halts where the health ran out and never reaches its staged
  destination — so food waiting there is no rescue. Cost is charged as it is
  spent; only food on the cell it actually halted on can bring it back.
- An edge-contest loser is never charged for the cell it did not enter.

### Exhaustion is provisional death

Health at or below zero mid-turn does **not** kill. It stops MOVEMENT, and
nothing else:

- The unit becomes `exhausted` and halts on the cell it had reached. Whatever
  is left of its path is abandoned.
- It stays **fully alive on the board** for the rest of the collision phase.
  It is not a corpse and does not go into any durable pile: it contests as
  itself. It still beats a lighter arrival on frozen tier and weight — a dying
  animal is still dangerous — and a heavier arrival can still kill it. That
  kill is an ordinary **collision** death (`contest`), not an exhaustion one,
  and the unit appears in `Turn.deaths` exactly once, with that cause.
- **Exhaustion kills only if the unit is still at or below zero at END OF
  TURN.** Food is the only heal in the game, and it is eaten at a unit's final
  cell in the end-of-turn food phase — which now runs BEFORE exhaustion is
  settled. So, with no carve-out anywhere: an exhausted unit whose halt cell
  holds food eats, restores to its type's max, grows, and survives — halted,
  short of where it was going, but alive. An exhausted unit anywhere else dies
  on its halt cell, entering `Turn.deaths` with cause `"exhaustion"` (movement
  cost) or `"hazard"` (a hazard dose), and the sub-step it halted on.

A snake at 1 health stepping onto food therefore exhausts on the food cell and
comes straight back. A slider that cannot afford its ray still dies, unless it
happens to halt on food — food further along the ray is no use to a unit that
never reaches it.

**On the wire**, the halt is always visible. The engine emits a clash at the
halt cell with kind `"exhaustion"` or `"hazard"` the moment it happens:

- if the exhaustion proves fatal, the unit is in that record's `victimIDs`,
  and there is a matching `Turn.deaths` entry;
- if the unit recovers — or is killed by something else first — `victimIDs`
  stays **empty**, the same non-fatal shape a `sever` uses. The record is then
  purely the explanation for why the unit stopped short of its staged path.

### Eating

Eating happens in the end-of-turn food phase: every unit still on the board
and standing on food consumes it, restores health to its current kind's
configured max (`maxHealthPerUnit`, default 100) and gains one weight/length.
It no longer replaces the movement cost — that was already charged in-sim.
The phase runs after the collision dead are removed but BEFORE exhaustion is
settled, which is the whole mechanism by which an exhausted unit recovers.

## Movement grammar

Moves stay a single destination cell index on the wire (`Move.move`). The path
is derived: a unique straight ray for rook/bishop/queen, a single jump for the
knight, a single step for king/pawn, a single orthogonal step for a snake.

Every unit carries an orientation (`Turn.orientation`). At spawn every unit
faces toward the board centre, chosen from its kind's legal orientation set;
each turn thereafter a unit that moved faces the direction of its FIRST step,
a unit that held keeps its orientation, and pawns change orientation only via
their rotation action. For pawns alone, orientation is also
engine-legality-bearing.

- **Snake**: one orthogonal step. It is the one kind allowed to stage a wall
  cell — walking into the perimeter is a legal, fatal move. Staging its own
  cell is not a move. Its default action (nothing legal staged) is to
  **continue straight** one step along its orientation, wherever that leads.
- **Rook**: any distance along a row/column. **Bishop**: along a diagonal.
  **Queen**: either. Range is unlimited (health cost is the limiter).
- **Knight**: the 8 L-jumps; touches only its destination.
- **King**: 1 step in any of the 8 directions.
- **Pawn**: each turn exactly one of —
  - step 1 cell **straight forward**;
  - step 1 cell **diagonal-forward**, to attack or eat only — legal only when
    that cell holds food or another unit at the start of the turn (if the
    occupant moves away in flight, the pawn still completes the staged step
    onto the vacated cell: moves are simultaneous);
  - **rotate 90°** left or right: a full-turn action, no movement, no
    movement health cost. Staged on the wire as the pawn's left/right *side*
    cell, meaning "face that way". **Rotation is signalling, and the side cell
    is never entered, so it is legal wherever that cell falls — including onto
    the perimeter wall.** Turning around fully costs two turns;
  - stay (also the default).

  The cell directly behind is never legal. **Promotion**: at weight ≥
  `pawnPromotionWeight` (config, default 10) a pawn becomes a queen, keeping
  id, letter, orientation and current health (clamped down to the queen's
  configured max) and **resetting to weight 1**.
- **Pieces have no momentum**: staying is legal, free, and the default when a
  piece stages nothing or stages an illegal destination.
- A piece destination is illegal if it is not on a legal ray/jump/step, or if
  it is not interior. Illegal → the kind's default action.
- Chess-style blocking does not exist at staging time: moves are simultaneous
  and hidden, so a "blocker" may itself move away. Whether a path is actually
  blocked is discovered in flight. There is **no friendly exemption anywhere**.

## End of turn

After the collision phase, in this order:

1. the COLLISION dead leave the board (severs already truncated survivors
   inside the engine, writing `Turn.severedCells`). Exhausted units stay — they
   still have the food phase ahead of them;
2. food and growth, for every surviving unit standing on food, **exhausted
   units included**;
3. exhaustion is settled: anything still at or below zero dies on the cell it
   halted on;
4. ally buff expiry for vulnerable units — see below;
5. regicide;
6. orientation rewrite (so dead units drop out, and a pawn promoting this turn
   keeps its pawn orientation);
7. potion collection, food/potion spawning, effect expiry;
8. pawn promotion;
9. winners, then turn assembly.

**Vulnerable-collision buff expiry**: when a unit whose frozen tier is below
zero DIES — for any cause — or SURVIVES A SEVER, its team-mates'
invulnerability buffs are rescheduled to expire at the end of this turn. One
encoding, fed by the engine's typed events, covering every game. (Previously
the piece path never fired it for a severed snake.)

## Wire format

- `GameSetup.unitsPerTeam?: { snake?, pawn?, knight?, bishop?, rook?, queen?,
  king? }` — counts per team. Absent → `snakesPerTeam` snakes.
- `GamePlayer.unitType?: UnitType` — absent means `"snake"`.
- `Turn.unitTypes?` — current kind per unit (changes on pawn promotion);
  written only for games that field pieces.
- `Turn.orientation` — per-unit orientation, every unit in every game. Dead
  units drop out.
- `Turn.paths?` — cells each PIECE actually entered this turn, in order (for
  animation/inspection). A dead piece's path ends at the cell it died on.
  Trail units are excluded, and so is any piece that entered nothing.
- **`Turn.deaths: { [playerID]: { cell, subStep, cause } }`** — the
  authoritative death registry, and the ONLY source renderers use to draw
  deaths. Every unit removed this turn appears here. An exhausted unit
  appears only if its exhaustion proved fatal — see below.
  `cause` is a `ClashKind`.
- **`Turn.severedCells?: { [playerID]: number[] }`** — cells cut from each
  SURVIVING trail unit this turn (non-fatal damage, for damage indicators).
  Absent when no sever truncated anything. A sever whose owner died the same
  turn is recorded as a clash but truncates nothing, so it never appears here.
- **`Turn.clashes: Clash[]`** — one adjudicated event at one cell:
  - `index` — the cell;
  - `subStep` — which sub-step it happened on (1 for whole-move units);
  - `kind` — `contest | edge | bodyBlock | sever | hazard | exhaustion | wall
    | self | regicide`;
  - `playerIDs` — every unit involved, survivors included;
  - `victimIDs` — the subset that died HERE. Empty for a sever, and empty for
    an exhaustion that the unit recovered from or outlived;
  - `survivorID?` — the unique unit left standing at this cell, when there is
    one. Withdrawn when the named unit was condemned in the same sub-step (two
    snakes can annihilate each other simultaneously);
  - `reason` — display text ONLY. Rendering decisions key on `kind` and the id
    lists, never on this string.
  An edge-contest tie spans two cells and emits one record per cell.
- `turn.moves` remains one integer per player: **the cell the unit actually
  ended its move on**. This is the death-square guarantee: anything that died
  records the cell it died on — the last cell it actually reached, never a
  staged destination it was blocked from entering — and `Turn.deaths[id].cell`
  agrees.

## Scoring & elimination

- Score = weight (`playerPieces[id].length`), so team score = sum of weights.
  Note the start asymmetry: a snake spawns worth 3, a piece worth 1.
- Promotion costs score: the promoting team's score drops by
  `pawnPromotionWeight - 1` that turn, and adjudication reads the
  post-promotion board.
- A team is alive while any of its units is alive — plus regicide for teams
  configured with kings. Weight never reaches 0 by promotion, so promoting can
  never eliminate a unit or a team.

## Implementer judgment calls (reported, not escalated)

- Spawning uses the shared placement machinery (radial team slices when team
  clusters are on), with pieces interleaved among snakes.
- Pieces participate fully in the invulnerability system (potions at the
  destination cell, ally buffs, debuffs, tiers).
- Self-collision checks skip pieces (a stack is all on one cell by
  construction).
- Board capacity guard counts total units per team.
- A unit that never moves pays its stationary hazard dose inside the engine,
  at sub-step 1, so ALL health accounting lives in one place — and a piece
  that exhausts on a hazard while standing still is an incumbent like any
  other exhausted unit — and recovers if it happens to be standing on food.
