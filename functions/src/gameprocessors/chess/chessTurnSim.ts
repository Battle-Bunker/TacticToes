import { Clash, UnitType } from "@shared/types/Game"

/**
 * Within-turn sub-step simulation for games that include chess pieces.
 *
 * Sub-step 1: snakes make their entire move (tail pops first, exactly like
 * the single-pass engine), knights land, kings/pawns step, sliders advance
 * their first square. Sub-steps 2..k: sliders advance one square each.
 * Collisions are adjudicated where and when units actually meet; dead units
 * vacate immediately.
 *
 * Rules (see docs/chess-pieces.md):
 * - Any square where someone arrived is contested by every unit standing on
 *   it: invulnerability tier first, then weight (body/stack length); the
 *   unique heaviest at the top tier survives, any tie kills all.
 * - Snake body segments (index > 0) stay walls: equal-or-lower-tier movers
 *   die on them, strictly-higher-tier movers sever the snake and stop.
 * - A surviving mover stops on any square where a kill happened.
 * - Two pieces exchanging squares through the same edge collide in flight
 *   (knights jump and never swap; snakes resolve via their swept-in body).
 * - Hazards deal hazardDamage per square entered, at any sub-step (snakes:
 *   head entry). A mover whose health hits zero or below dies on the square
 *   where it happened; a survivor keeps going.
 */

export interface SimUnit {
  id: string
  type: UnitType
  isSnake: boolean
  /** Snake body or piece weight-stack. Mutated in place (moves, severs). */
  body: number[]
  tier: number
  /** Squares to traverse this turn, in order. Empty = stay/rotate. */
  path: number[]
  /** Current health. Hazard entry doses are deducted during the sim. */
  health: number
}

export interface ChessTurnSimResult {
  clashes: Clash[]
  deadIDs: Set<string>
  /** Tier at death, for the vulnerable-collision buff-expiry rule. */
  deadTiers: Map<string, number>
  /**
   * Squares each piece actually entered (movement health cost + Turn.paths).
   * A dead piece's list ends at the square it died on.
   */
  traversed: Map<string, number[]>
  /**
   * Final square of every piece (truncated sliders stop early). Authoritative
   * for dead pieces too: a piece that dies mid-path records the square it
   * died on — never its origin or staged destination.
   */
  finalSquare: Map<string, number>
  /** Post-hazard health of every unit (the food phase settles movement costs). */
  healths: Map<string, number>
}

interface RuntimeUnit extends SimUnit {
  alive: boolean
  stopped: boolean
  movedFrom: number | null // square vacated this sub-step (movers only)
  traversed: number[]
}

export const runChessTurnSim = (
  simUnits: SimUnit[],
  boardWidth: number,
  boardHeight: number,
  hazards: number[],
  walls: number[],
  hazardDamage: number,
): ChessTurnSimResult => {
  const clashes: Clash[] = []
  const deadIDs = new Set<string>()
  const deadTiers = new Map<string, number>()
  const hazardSet = new Set(hazards)
  const wallSet = new Set(walls)

  const units: RuntimeUnit[] = simUnits.map((u) => ({
    ...u,
    alive: true,
    stopped: false,
    movedFrom: null,
    traversed: [],
  }))

  const kill = (unit: RuntimeUnit, reason: string, playerIDs: string[], subStep: number): void => {
    if (!unit.alive) return
    unit.alive = false
    deadIDs.add(unit.id)
    deadTiers.set(unit.id, unit.tier)
    const cells = new Set(unit.body)
    cells.forEach((index) => {
      clashes.push({ index, playerIDs, reason, subStep })
    })
  }

  // Tier first, then weight; at most one survivor. Returns whether anyone died.
  const contestSquare = (participants: RuntimeUnit[], subStep: number): boolean => {
    if (participants.length < 2) return false
    const ids = participants.map((u) => u.id)
    const maxTier = Math.max(...participants.map((u) => u.tier))
    let anyDeath = false
    participants.forEach((u) => {
      if (u.tier < maxTier) {
        kill(u, "Head-on collision (lower invulnerability level died)", ids, subStep)
        anyDeath = true
      }
    })
    const top = participants.filter((u) => u.alive && u.tier === maxTier)
    if (top.length > 1) {
      const maxWeight = Math.max(...top.map((u) => u.body.length))
      const heaviest = top.filter((u) => u.body.length === maxWeight)
      const survivor = heaviest.length === 1 ? heaviest[0] : null
      top.forEach((u) => {
        if (u === survivor) return
        kill(u, "Head-on collision (lighter unit(s) died)", ids, subStep)
        anyDeath = true
      })
    }
    return anyDeath
  }

  const maxSubSteps = Math.max(1, ...units.map((u) => (u.isSnake ? 1 : u.path.length)))

  for (let subStep = 1; subStep <= maxSubSteps; subStep++) {
    const movers = units.filter(
      (u) =>
        u.alive &&
        !u.stopped &&
        u.path.length >= subStep &&
        (u.isSnake ? subStep === 1 : true),
    )
    if (movers.length === 0) break

    // 1. Advance every mover (snakes: tail pops before the head lands).
    movers.forEach((m) => {
      const to = m.path[subStep - 1]
      m.movedFrom = m.body[0]
      if (m.isSnake) {
        m.body.pop()
        m.body.unshift(to)
      } else {
        m.body.fill(to)
        m.traversed.push(to)
      }
    })

    // 2. Wall collisions (snakes only — piece destinations are pre-validated).
    movers.forEach((m) => {
      if (m.alive && m.isSnake && wallSet.has(m.body[0])) {
        kill(m, "Collided with wall", [m.id], subStep)
      }
    })

    // 3. Hazards: every hazard square entered costs hazardDamage on the
    // spot. A mover at zero or below dies on that square; a survivor keeps
    // going (and pays again for each further hazard square it enters).
    movers.forEach((m) => {
      if (m.alive && hazardSet.has(m.body[0])) {
        m.health -= hazardDamage
        if (m.health <= 0) {
          kill(m, "Entered hazard", [m.id], subStep)
        }
      }
    })

    // 4. Self-collisions (snakes only; a piece stack cannot self-collide).
    movers.forEach((m) => {
      if (m.alive && m.isSnake && m.body.slice(1).includes(m.body[0])) {
        kill(m, "Collided with own body", [m.id], subStep)
      }
    })

    // 5. In-flight edge swaps between pieces (knights jump; snakes leave a
    // swept-in body behind, which the square contest below handles).
    for (let i = 0; i < movers.length; i++) {
      for (let j = i + 1; j < movers.length; j++) {
        const a = movers[i]
        const b = movers[j]
        if (!a.alive || !b.alive) continue
        if (a.isSnake || b.isSnake || a.type === "knight" || b.type === "knight") continue
        if (a.movedFrom === b.body[0] && b.movedFrom === a.body[0]) {
          const anyDeath = contestSquare([a, b], subStep)
          if (anyDeath) {
            if (a.alive) a.stopped = true
            if (b.alive) b.stopped = true
          }
        }
      }
    }

    // 6. Per-square contests wherever a mover arrived this sub-step.
    const arrivalSquares = new Set<number>()
    movers.forEach((m) => {
      if (m.alive) arrivalSquares.add(m.body[0])
    })

    arrivalSquares.forEach((square) => {
      // Head-class occupants: pieces, and snake heads (moving or stationary).
      const headUnits = units.filter((u) => u.alive && u.body[0] === square)
      const anyDeath = contestSquare(headUnits, subStep)
      if (anyDeath) {
        headUnits.forEach((u) => {
          if (u.alive && !u.isSnake && u.traversed.length < u.path.length) u.stopped = true
        })
      }

      // Surviving arrivers vs snake body segments at this square. Higher
      // tiers act first so a sever can clear the square for lower tiers,
      // matching the tiered single-pass engine.
      const arrivers = movers
        .filter((m) => m.alive && m.body[0] === square)
        .sort((a, b) => b.tier - a.tier)
      arrivers.forEach((m) => {
        if (!m.alive) return
        units.forEach((owner) => {
          if (!m.alive) return
          if (!owner.alive || !owner.isSnake || owner.id === m.id) return
          const segIdx = owner.body.indexOf(square, 1)
          if (segIdx === -1) return
          if (m.tier > owner.tier) {
            const severed = owner.body.splice(segIdx)
            new Set(severed).forEach((index) => {
              clashes.push({
                index,
                playerIDs: [m.id, owner.id],
                reason: "Body severed by invulnerable snake",
                subStep,
              })
            })
            if (!m.isSnake) m.stopped = true // capture-stops
          } else if (m.tier === owner.tier) {
            kill(m, "Collided with another snake's body", [m.id, owner.id], subStep)
          } else {
            kill(m, "Collided with higher invulnerability snake's body", [m.id, owner.id], subStep)
          }
        })
      })
    })

    movers.forEach((m) => {
      m.movedFrom = null
    })
  }

  const traversed = new Map<string, number[]>()
  const finalSquare = new Map<string, number>()
  const healths = new Map<string, number>()
  units.forEach((u) => {
    healths.set(u.id, u.health)
    if (u.isSnake) return
    traversed.set(u.id, u.traversed)
    finalSquare.set(u.id, u.body[0])
  })

  return { clashes, deadIDs, deadTiers, traversed, finalSquare, healths }
}
