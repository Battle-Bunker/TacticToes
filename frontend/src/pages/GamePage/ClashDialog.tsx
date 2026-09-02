import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Typography,
} from "@mui/material"
import React from "react"
import {
  INCOMPLETE_RECORD_LINE,
  ParticipantStatus,
  STATUS_LABEL,
  UNCERTAIN_RING_COLOR,
  clashHeadline,
  clashesAtCell,
  deathHeadline,
  deathsAtCell,
  distinctClashes,
  participantStatus,
  recoveriesAtCell,
  seversAtCell,
  uncertaintiesAtCell,
} from "../../board/clashes"
import { BoardClash, BoardModel, Cell } from "../../board/renderer"

// ── The square inspector ────────────────────────────────────────────────────
//
// The game server's own account of one square: who died on it and of what, what
// was adjudicated there, whose body was cut there and survived — and, where the
// record is missing something, that it is missing something.
//
// EVERY line here is read off the turn's own records: the death registry says
// who died, and each clash record names its victims and its survivor. Nothing
// is derived from where units are standing at the end of the turn. The board
// and this panel therefore cannot disagree, which they used to: a severed snake
// is alive but not on the square, and a corpse's square can be occupied by
// whoever arrived a sub-step later.
//
// It says nothing about control or ownership: a spectator reads a square
// exactly as a player would.

interface ClashDialogProps {
  open: boolean
  onClose: () => void
  /** The square being inspected, in the board model's own coordinates. */
  cell: Cell | null
  board: BoardModel
}

// Spelled out rather than taken from the palette: this app's theme repurposes
// `success.main` as a near-white surface colour, so a status label painted with
// it disappears. A verdict has to be readable.
const STATUS_COLOR: Record<ParticipantStatus, string> = {
  died: "#c62828",
  stood: "#2e7d32",
  shortened: "#e65100",
  recovered: "#00695c",
  survived: "#2e7d32",
  unknown: UNCERTAIN_RING_COLOR,
}

const Swatch: React.FC<{ color: string }> = ({ color }) => (
  <Box
    sx={{
      width: 12,
      height: 12,
      borderRadius: "3px",
      border: "1px solid rgba(0, 0, 0, 0.35)",
      backgroundColor: color,
      flexShrink: 0,
    }}
  />
)

const SubStepChip: React.FC<{ subStep: number }> = ({ subStep }) => (
  <Box
    title="Within-turn sub-step: pieces resolve a turn one square of their path at a time"
    sx={{
      fontSize: 11,
      fontWeight: 700,
      borderRadius: "8px",
      border: "1px solid",
      borderColor: "warning.dark",
      color: "warning.dark",
      padding: "0 6px",
      whiteSpace: "nowrap",
    }}
  >
    sub-step {subStep}
  </Box>
)

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({
  title,
  children,
}) => (
  <Box sx={{ mt: 1.5, "&:first-of-type": { mt: 0 } }}>
    <Typography
      sx={{
        fontSize: 11,
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: "0.08em",
        color: "text.secondary",
        mb: 0.5,
      }}
    >
      {title}
    </Typography>
    {children}
  </Box>
)

/** One unit named by a record, with the fate the RECORD gives it. */
const Participant: React.FC<{
  id: string
  board: BoardModel
  status: ParticipantStatus
}> = ({ id, board, status }) => {
  const unit =
    board.units.find((u) => u.id === id) ??
    board.deadUnits.find((u) => u.id === id)
  const label = unit ? `${unit.teamName} ${unit.letter}`.trim() : id

  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1, py: 0.25 }}>
      <Swatch color={unit?.color ?? "#888888"} />
      <Typography
        sx={{
          fontSize: 14,
          flex: 1,
          minWidth: 0,
          textDecoration: status === "died" ? "line-through" : "none",
        }}
      >
        {label}
      </Typography>
      <Typography
        sx={{
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          fontWeight: 700,
          color: STATUS_COLOR[status],
        }}
      >
        {STATUS_LABEL[status]}
      </Typography>
    </Box>
  )
}

const ClashRecord: React.FC<{
  clash: BoardClash
  board: BoardModel
  severedOwnerIDs: Set<string>
  /** False when the panel already carries the incomplete-record notice above. */
  sayIncomplete: boolean
}> = ({ clash, board, severedOwnerIDs, sayIncomplete }) => (
  <Box sx={{ mt: 1, "&:first-of-type": { mt: 0 } }}>
    <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
      <Typography sx={{ fontSize: 14, fontWeight: 700 }}>
        {clashHeadline(clash.kind)}
      </Typography>
      <SubStepChip subStep={clash.subStep} />
    </Box>
    {clash.reason && (
      <Typography sx={{ fontSize: 13, color: "text.secondary" }}>
        {clash.reason}
      </Typography>
    )}
    {!clash.complete && sayIncomplete && (
      <Typography sx={{ fontSize: 13, color: UNCERTAIN_RING_COLOR }}>
        {INCOMPLETE_RECORD_LINE}
      </Typography>
    )}
    <Box sx={{ mt: 0.5 }}>
      {clash.playerIDs.map((id) => (
        <Participant
          key={id}
          id={id}
          board={board}
          status={participantStatus(clash, id, severedOwnerIDs)}
        />
      ))}
    </Box>
  </Box>
)

const ClashDialog: React.FC<ClashDialogProps> = ({
  open,
  onClose,
  cell,
  board,
}) => {
  const clashes = cell ? distinctClashes(clashesAtCell(board, cell)) : []
  const deathMark = cell ? deathsAtCell(board, cell) : null
  const severs = cell ? seversAtCell(board, cell) : []
  const recoveries = cell ? recoveriesAtCell(board, cell) : []
  const doubts = cell ? uncertaintiesAtCell(board, cell) : []
  const severedOwnerIDs = new Set(board.severed.map((s) => s.ownerID))
  const hasAnything =
    clashes.length > 0 ||
    !!deathMark ||
    severs.length > 0 ||
    recoveries.length > 0 ||
    doubts.length > 0

  return (
    <Dialog
      open={open && hasAnything}
      onClose={onClose}
      sx={{ zIndex: 99999999 }}
    >
      <DialogTitle sx={{ pb: 1 }}>
        Square ({cell?.x}, {cell?.y})
      </DialogTitle>
      <DialogContent>
        {doubts.length > 0 && (
          <Box
            sx={{
              mb: 1.5,
              p: 1,
              border: "2px dashed",
              borderColor: UNCERTAIN_RING_COLOR,
              color: "text.secondary",
            }}
          >
            <Typography sx={{ fontSize: 13, fontWeight: 700 }}>
              {INCOMPLETE_RECORD_LINE}
            </Typography>
            {doubts.map((doubt, i) => (
              <Typography key={i} sx={{ fontSize: 13 }}>
                {doubt.note}
              </Typography>
            ))}
          </Box>
        )}

        {deathMark && (
          <Section
            title={
              deathMark.victims.length > 1
                ? `Died here (${deathMark.victims.length})`
                : "Died here"
            }
          >
            {deathMark.victims.map((victim) => (
              <Box key={victim.id} sx={{ py: 0.4 }}>
                <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                  <Swatch color={victim.color} />
                  <Typography
                    sx={{
                      fontSize: 14,
                      flex: 1,
                      minWidth: 0,
                      textDecoration: "line-through",
                    }}
                  >
                    {`${victim.teamName} ${victim.letter}`.trim()}
                  </Typography>
                  <SubStepChip subStep={victim.subStep} />
                </Box>
                <Typography
                  sx={{ fontSize: 13, color: "text.secondary", pl: 2.5 }}
                >
                  {deathHeadline(victim.cause)}
                </Typography>
              </Box>
            ))}
          </Section>
        )}

        {recoveries.length > 0 && (
          <Section title="Exhausted here">
            {recoveries.map((recovery) => (
              <Box
                key={recovery.playerID}
                sx={{ display: "flex", alignItems: "center", gap: 1, py: 0.25 }}
              >
                <Swatch color={recovery.color} />
                <Typography sx={{ fontSize: 14, flex: 1, minWidth: 0 }}>
                  {`${recovery.teamName} ${recovery.letter}`.trim()} ran out of
                  health{recovery.cause === "hazard" ? " on hazard damage" : ""}{" "}
                  and halted here — recovered by eating, and finished the turn
                  alive.
                </Typography>
              </Box>
            ))}
          </Section>
        )}

        {severs.length > 0 && (
          <Section title="Severed here">
            {severs.map((sever) => (
              <Box
                key={sever.ownerID}
                sx={{ display: "flex", alignItems: "center", gap: 1, py: 0.25 }}
              >
                <Swatch color={sever.color} />
                <Typography sx={{ fontSize: 14, flex: 1, minWidth: 0 }}>
                  {`${sever.teamName} ${sever.letter}`.trim()} lost this cell —
                  survived, shortened by{" "}
                  {board.severed.filter((s) => s.ownerID === sever.ownerID).length}{" "}
                  cell
                  {board.severed.filter((s) => s.ownerID === sever.ownerID)
                    .length === 1
                    ? ""
                    : "s"}
                  .
                </Typography>
              </Box>
            ))}
          </Section>
        )}

        {clashes.length > 0 && (
          <Section title={clashes.length > 1 ? "Records" : "Record"}>
            {clashes.map((clash) => (
              <ClashRecord
                key={`${clash.kind}|${clash.subStep}|${clash.playerIDs.join(",")}|${clash.victimIDs.join(",")}|${clash.survivorID ?? ""}`}
                clash={clash}
                board={board}
                severedOwnerIDs={severedOwnerIDs}
                sayIncomplete={doubts.length === 0}
              />
            ))}
          </Section>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  )
}

export default ClashDialog
