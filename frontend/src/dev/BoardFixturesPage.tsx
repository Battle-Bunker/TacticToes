import { Box, Container, Typography } from "@mui/material"
import React, { useState } from "react"
import BoardCanvas from "../board/BoardCanvas"
import { isInspectable } from "../board/clashes"
import { BoardModel, Cell, DeathVictim } from "../board/renderer"
import { turnToBoard } from "../board/turnToBoard"
import ClashDialog from "../pages/GamePage/ClashDialog"
import { FIXTURES, FIXTURE_TURN_INDEX, Fixture } from "./boardFixtures"

// ── The fixture harness ─────────────────────────────────────────────────────
//
// Every turn-feedback mark the board can draw, on one page, from hand-written
// turn documents — no server, no game, no waiting for the right collision to
// happen. Each card runs the REAL pipeline: fixture Turn → turnToBoard →
// renderer → the same ClashDialog the game uses, so what is on this page is
// what a spectator sees.
//
// Dev-only, on its own HTML entry: run `npm run dev` and open
// /dev-fixtures.html. It is not an input of the production build, so none of
// this reaches the shipped app. `?only=<fixture id>` renders a single card,
// which is how the screenshots are taken one scenario at a time.

const BOARD_PX = 520

const victim = (
  id: string,
  color: string,
  style: DeathVictim["style"],
  cause: DeathVictim["cause"],
): DeathVictim => ({
  id,
  letter: "A",
  teamName: "Team",
  color,
  cause,
  style,
  subStep: 1,
})

/** A one-cell board carrying exactly one mark, for the legend. */
const legendBoard = (partial: Partial<BoardModel>): BoardModel => ({
  width: 1,
  height: 1,
  turn: 1,
  walls: [],
  hazards: [],
  fertileTiles: [],
  winningSquares: [],
  food: [],
  invulnerabilityPotions: [],
  teams: [],
  units: [],
  deaths: [],
  clashes: [],
  severed: [],
  recoveries: [],
  uncertainties: [],
  recordNotes: [],
  deadUnits: [],
  ...partial,
})

const ORIGIN: Cell = { x: 0, y: 0 }

const LIVING_UNIT = {
  id: "u",
  letter: "A",
  teamID: "t",
  teamName: "Team",
  color: "#2e7d32",
  unitType: "snake" as const,
  body: [ORIGIN],
  weight: 3,
  health: 80,
  maxHealth: 100,
  invulnerabilityLevel: 0,
}

const LEGEND: { label: string; board: BoardModel }[] = [
  {
    label: "Combat death — solid disc, victim's colour, white ✗",
    board: legendBoard({
      deaths: [
        { cell: ORIGIN, victims: [victim("a", "#1565c0", "combat", "contest")] },
      ],
    }),
  },
  {
    label: "…with the survivor standing on it — the mark steps into a corner badge",
    board: legendBoard({
      units: [LIVING_UNIT],
      deaths: [
        { cell: ORIGIN, victims: [victim("a", "#1565c0", "combat", "contest")] },
      ],
    }),
  },
  {
    label: "Fatal exhaustion — hollow ring, drained middle, FLAT bar",
    board: legendBoard({
      deaths: [
        {
          cell: ORIGIN,
          victims: [victim("a", "#d32f2f", "exhausted", "exhaustion")],
        },
      ],
    }),
  },
  {
    label:
      "Exhausted and RECOVERED — same drained middle, bar kicking up, on a unit still standing",
    board: legendBoard({
      units: [{ ...LIVING_UNIT, color: "#d32f2f" }],
      recoveries: [
        {
          cell: ORIGIN,
          playerID: "a",
          letter: "A",
          teamName: "Team",
          color: "#d32f2f",
          cause: "exhaustion",
        },
      ],
    }),
  },
  {
    label: "Pile-up — one wedge per victim, carrying the count",
    board: legendBoard({
      deaths: [
        {
          cell: ORIGIN,
          victims: [
            victim("a", "#2e7d32", "combat", "contest"),
            victim("b", "#6a1b9a", "combat", "contest"),
            victim("c", "#1565c0", "combat", "contest"),
          ],
        },
      ],
    }),
  },
  {
    label: "Sever damage — owner's colour, hatched, dashed, bitten. Nobody died",
    board: legendBoard({
      severed: [
        {
          cell: ORIGIN,
          ownerID: "a",
          letter: "A",
          teamName: "Team",
          color: "#1565c0",
        },
      ],
    }),
  },
  {
    label: "Clash ring — this square was adjudicated; click it",
    board: legendBoard({
      clashes: [
        {
          cell: ORIGIN,
          kind: "contest",
          playerIDs: [],
          victimIDs: [],
          subStep: 1,
          reason: "",
          complete: true,
        },
      ],
    }),
  },
  {
    label: "Uncertainty — the record is incomplete, and no team owns this mark",
    board: legendBoard({
      uncertainties: [{ cell: ORIGIN, note: "" }],
    }),
  },
]

const Legend: React.FC = () => (
  <Box sx={{ border: "2px solid #000", p: 2, mb: 4 }}>
    <Typography sx={{ fontWeight: 700, mb: 1 }}>The marks</Typography>
    <Box
      sx={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
        gap: 1.5,
      }}
    >
      {LEGEND.map((entry) => (
        <Box
          key={entry.label}
          sx={{ display: "flex", alignItems: "center", gap: 1.5 }}
        >
          <Box sx={{ flex: "0 0 auto" }}>
            <BoardCanvas board={entry.board} fixedWidth={56} />
          </Box>
          <Typography sx={{ fontSize: 13 }}>{entry.label}</Typography>
        </Box>
      ))}
    </Box>
  </Box>
)

const FixtureCard: React.FC<{ fixture: Fixture }> = ({ fixture }) => {
  const [inspected, setInspected] = useState<Cell | null>(null)
  const board = turnToBoard(fixture.gameState, FIXTURE_TURN_INDEX)
  if (!board) return null

  return (
    <Box
      data-fixture={fixture.id}
      sx={{ border: "2px solid #000", p: 2, mb: 4, backgroundColor: "#fff" }}
    >
      <Typography sx={{ fontWeight: 700, fontSize: 18 }}>
        {fixture.title}
      </Typography>
      <Typography sx={{ fontSize: 13, color: "text.secondary", mt: 0.5 }}>
        WIRE · {fixture.blurb}
      </Typography>
      <Typography sx={{ fontSize: 13, mt: 0.5 }}>
        BOARD · {fixture.expected}
      </Typography>
      {board.recordNotes.length > 0 && (
        <Box sx={{ mt: 1, p: 1, border: "2px dashed #7a8290" }}>
          {board.recordNotes.map((note) => (
            <Typography key={note} sx={{ fontSize: 13, color: "#4b5563" }}>
              {note}
            </Typography>
          ))}
        </Box>
      )}
      <Box sx={{ mt: 1.5 }} data-board={fixture.id}>
        <BoardCanvas
          board={board}
          fixedWidth={BOARD_PX}
          onCellClick={(cell) => {
            if (isInspectable(board, cell)) setInspected(cell)
          }}
        />
      </Box>
      <ClashDialog
        open={inspected !== null}
        onClose={() => setInspected(null)}
        cell={inspected}
        board={board}
      />
    </Box>
  )
}

const BoardFixturesPage: React.FC = () => {
  const only = new URLSearchParams(window.location.search).get("only")
  const shown = only ? FIXTURES.filter((f) => f.id === only) : FIXTURES

  return (
    <Container maxWidth="lg" sx={{ py: 2 }}>
      {!only && (
        <>
          <Typography variant="h5" sx={{ fontWeight: 700, mb: 1 }}>
            Turn feedback — every mark the board can draw
          </Typography>
          <Typography sx={{ fontSize: 14, mb: 2 }}>
            Hand-written turn documents through the real board pipeline. Deaths
            come from the turn's death registry, damage from its severed cells,
            and every fate in the inspector is named by the record — nothing on
            this page is inferred from where units ended up standing.
          </Typography>
          <Legend />
        </>
      )}
      {shown.map((fixture) => (
        <FixtureCard key={fixture.id} fixture={fixture} />
      ))}
    </Container>
  )
}

export default BoardFixturesPage
