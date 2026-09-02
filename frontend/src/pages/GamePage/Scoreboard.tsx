import { Box, Typography } from "@mui/material"
import React, { useEffect, useRef, useState } from "react"
import { AnvilIcon, HazardIcon, UnitIcon } from "../../board/BoardIcons"
import {
  BoardModel,
  BoardTeam,
  BoardUnit,
  RosterUnit,
  STAT_ICON,
  energyBarColor,
  energyFraction,
  invulnerabilityMark,
  invulnerabilityTurnsRemaining,
} from "../../board/renderer"

// ── The scoreboard ──────────────────────────────────────────────────────────
//
// One team group per team, each headed by that team's NAME and its SCORE, and
// listing every unit the team has ever had: letter, type, weight, energy and
// any invulnerability, with the dead kept in place — struck through, greyed,
// scoring nothing.
//
// Everything here is read off the BOARD BEING SHOWN, never off a stored
// summary: scrub back to turn 12 and the scoreboard is turn 12's, which is the
// whole reason the score is summed here rather than taken from the turn's
// `teamScores` field. It is a spectator's scoreboard — nothing on it says who
// is controlling what, and no row is a control.

/** One row: a unit that is on the board, or one the board has dropped. */
type Row =
  | { dead: false; unit: BoardUnit }
  | { dead: true; unit: RosterUnit }

/** Letter rank order (A, B, C…), with the id as the tiebreak. */
const byLetter = (a: Row, b: Row): number =>
  a.unit.letter === b.unit.letter
    ? a.unit.id.localeCompare(b.unit.id)
    : a.unit.letter.localeCompare(b.unit.letter)

/**
 * A team's SCORE, computed exactly as the game engine computes it
 * (TeamSnekProcessor.getTeamScore): the summed weight of its LIVING units — a
 * snake's body length, a piece's stack weight. A dead unit contributes nothing,
 * which is why only the units still on the board are summed.
 */
const teamScore = (units: BoardUnit[]): number =>
  units.reduce((total, unit) => total + unit.weight, 0)

/** How long the copy control wears its confirmation before reverting. */
const COPY_FEEDBACK_MS = 1100

/**
 * One unit's internal document id, as a control on that unit's own row: the id
 * on hover, the id on the clipboard on click. The ids are what a centaur's
 * author sees in their own logs and sends in their own moves, so a spectator
 * watching a game they are debugging wants them to hand — and an id beside the
 * unit it names beats a corner tooltip listing every id at once.
 */
const IdCopyButton: React.FC<{ id: string }> = ({ id }) => {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle")
  const timer = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (timer.current != null) window.clearTimeout(timer.current)
    },
    [],
  )

  const flash = (next: "copied" | "failed") => {
    setState(next)
    if (timer.current != null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setState("idle"), COPY_FEEDBACK_MS)
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(id)
      flash("copied")
    } catch {
      // An insecure context, or a browser that refused the permission: a
      // refusal shows as a cross rather than as silence.
      flash("failed")
    }
  }

  const color =
    state === "copied" ? "#2e7d32" : state === "failed" ? "#c62828" : "#757575"

  return (
    <Box
      component="button"
      type="button"
      onClick={copy}
      title={`${id}\nClick to copy`}
      aria-label="Copy unit id"
      sx={{
        flexShrink: 0,
        alignSelf: "flex-start",
        background: "transparent",
        border: "1px solid",
        borderColor: color,
        borderRadius: "4px",
        color,
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: "0.04em",
        padding: "2px 5px",
        lineHeight: 1.2,
        cursor: "pointer",
        fontFamily: "inherit",
        "&:hover": { color: "#212121", borderColor: "#212121" },
      }}
    >
      {state === "copied" ? "✓" : state === "failed" ? "✕" : "ID"}
    </Box>
  )
}

/** One stat on a row: its symbol, then its number. */
const Stat: React.FC<{
  title: string
  children: React.ReactNode
}> = ({ title, children }) => (
  <Box
    title={title}
    sx={{ display: "inline-flex", alignItems: "center", gap: 0.5 }}
  >
    {children}
  </Box>
)

const UnitRow: React.FC<{ row: Row; turn: number }> = ({ row, turn }) => {
  const { unit, dead } = row
  const invulnLevel = dead ? 0 : unit.invulnerabilityLevel
  // The row writes the buff's TURNS, the same number the unit's own body plate
  // writes: its LEVEL is already spelled out by the unit's outline colour on
  // the board. No expiry on the wire (or a level already lapsed at the turn
  // being shown) means there is no countdown to write.
  const invulnTurns =
    !dead && invulnLevel !== 0
      ? invulnerabilityTurnsRemaining(unit, turn)
      : null
  const frac = dead ? 0 : energyFraction(unit)

  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 1,
        backgroundColor: "grey.100",
        borderRadius: "6px",
        p: 1,
        mb: 0.75,
        opacity: dead ? 0.45 : 1,
        filter: dead ? "grayscale(0.6)" : "none",
      }}
    >
      <Box
        sx={{
          width: 20,
          height: 20,
          borderRadius: "4px",
          border: "2px solid #444",
          backgroundColor: unit.color,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <UnitIcon unitType={unit.unitType} size={14} />
      </Box>

      <Box sx={{ flex: 1, minWidth: 0 }}>
        {/* The heading already names the team, so the row is its unit's
            LETTER — the handle players use out loud. */}
        <Typography
          sx={{
            fontWeight: 600,
            fontSize: 13,
            lineHeight: 1.3,
            textDecoration: dead ? "line-through" : "none",
          }}
        >
          {unit.letter}
          {dead && (
            <Box component="span" sx={{ color: "text.disabled", fontWeight: 400 }}>
              {" (dead)"}
            </Box>
          )}
        </Typography>
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 0.75,
            fontSize: 11,
            color: "text.secondary",
          }}
        >
          <Stat title="Weight">
            <AnvilIcon height={12} />
            {unit.weight}
          </Stat>
          {!dead && (
            <Stat title="Energy">
              <Box component="span" sx={{ color: energyBarColor(frac) }}>
                {STAT_ICON.energy}
              </Box>
              <Box
                sx={{
                  width: 48,
                  height: 8,
                  backgroundColor: "#dcdcdc",
                  border: "1px solid rgba(0, 0, 0, 0.25)",
                  borderRadius: "4px",
                  overflow: "hidden",
                }}
              >
                <Box
                  sx={{
                    width: `${frac * 100}%`,
                    height: "100%",
                    backgroundColor: energyBarColor(frac),
                  }}
                />
              </Box>
              {unit.energy}
            </Stat>
          )}
          {invulnTurns != null && (
            <Stat title="Invulnerability">
              {invulnerabilityMark(invulnLevel).icon ?? <HazardIcon height={12} />}
              {invulnTurns}
            </Stat>
          )}
        </Box>
      </Box>

      <IdCopyButton id={unit.id} />
    </Box>
  )
}

const TeamGroup: React.FC<{
  team: BoardTeam
  rows: Row[]
  score: number
  turn: number
}> = ({ team, rows, score, turn }) => (
  <Box>
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 1,
        m: "4px 0 8px",
        pb: 0.5,
        borderBottom: "1px solid",
        borderColor: "divider",
      }}
    >
      <Box
        sx={{
          width: 12,
          height: 12,
          borderRadius: "3px",
          border: "1px solid rgba(0, 0, 0, 0.35)",
          backgroundColor: team.color,
          flexShrink: 0,
        }}
      />
      {/* The team's HUMAN name, taken from the game setup — never its document
          id, which is a key rather than a name. */}
      <Typography
        title={team.name}
        sx={{
          fontWeight: 700,
          fontSize: 13,
          textTransform: "uppercase",
          letterSpacing: "0.5px",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {team.name}
      </Typography>
      {/* The headline number, pinned to the far end so every team's score is
          found in one column — the place it occupied in the table this
          replaces. */}
      <Box
        title="Team score: total weight of this team's living units"
        sx={{
          ml: "auto",
          flexShrink: 0,
          fontSize: 16,
          fontWeight: 800,
          fontVariantNumeric: "tabular-nums",
          backgroundColor: "rgba(0, 0, 0, 0.08)",
          borderRadius: "5px",
          padding: "1px 8px",
        }}
      >
        {score}
      </Box>
    </Box>
    {rows.map((row) => (
      <UnitRow key={row.unit.id} row={row} turn={turn} />
    ))}
  </Box>
)

const Scoreboard: React.FC<{ board: BoardModel }> = ({ board }) => {
  const groups = board.teams.map((team) => {
    const living = board.units.filter((unit) => unit.teamID === team.id)
    const rows: Row[] = [
      ...living.map((unit) => ({ dead: false, unit }) as Row),
      ...board.deadUnits
        .filter((unit) => unit.teamID === team.id)
        .map((unit) => ({ dead: true, unit }) as Row),
    ].sort(byLetter)
    return { team, rows, score: teamScore(living) }
  })

  return (
    <Box
      sx={{
        my: 2,
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
        gap: 2,
        alignItems: "start",
      }}
    >
      {groups.map(({ team, rows, score }) => (
        <TeamGroup
          key={team.id}
          team={team}
          rows={rows}
          score={score}
          turn={board.turn}
        />
      ))}
    </Box>
  )
}

export default Scoreboard
