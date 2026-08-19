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
import { clashesAtCell, distinctClashes } from "../../board/clashes"
import { BoardModel, Cell } from "../../board/renderer"

// ── The clash inspector ─────────────────────────────────────────────────────
//
// The game server's own account of what collided on one square: for EVERY
// distinct collision there, why someone died, which within-turn sub-step it
// happened on (pieces walk their path a square at a time, so a slider that died
// on its third step did not die where it was aiming), and every unit that took
// part — marked with whether it walked away.
//
// Who died is READ OFF THE BOARD rather than off the record: the server records
// PARTICIPANTS, not victims, so a participant that is no longer among the
// board's units is one that did not survive. That makes this identical on the
// live board and on a scrubbed historic one, and it says nothing about
// ownership: a spectator reads a clash exactly as a player would.

interface ClashDialogProps {
  open: boolean
  onClose: () => void
  /** The square being inspected, in the board model's own coordinates. */
  cell: Cell | null
  board: BoardModel
}

const Participant: React.FC<{
  id: string
  board: BoardModel
  survived: boolean
}> = ({ id, board, survived }) => {
  const unit =
    board.units.find((u) => u.id === id) ??
    board.deadUnits.find((u) => u.id === id)
  const label = unit ? `${unit.teamName} ${unit.letter}`.trim() : id

  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1, py: 0.25 }}>
      <Box
        sx={{
          width: 12,
          height: 12,
          borderRadius: "3px",
          border: "1px solid rgba(0, 0, 0, 0.35)",
          backgroundColor: unit?.color ?? "#888888",
          flexShrink: 0,
        }}
      />
      <Typography
        sx={{
          fontSize: 14,
          flex: 1,
          minWidth: 0,
          textDecoration: survived ? "none" : "line-through",
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
          color: survived ? "success.main" : "error.main",
        }}
      >
        {survived ? "survived" : "died"}
      </Typography>
    </Box>
  )
}

const ClashDialog: React.FC<ClashDialogProps> = ({
  open,
  onClose,
  cell,
  board,
}) => {
  const clashes = cell ? distinctClashes(clashesAtCell(board, cell)) : []
  const aliveIDs = new Set(board.units.map((unit) => unit.id))

  return (
    <Dialog open={open && clashes.length > 0} onClose={onClose} sx={{ zIndex: 99999999 }}>
      <DialogTitle sx={{ pb: 1 }}>
        Clash at ({cell?.x}, {cell?.y})
      </DialogTitle>
      <DialogContent>
        {clashes.map((clash, i) => (
          <Box
            key={`${clash.reason}|${clash.subStep}|${clash.playerIDs.join(",")}`}
            sx={{
              mt: i === 0 ? 0 : 1.5,
              pt: i === 0 ? 0 : 1.5,
              borderTop: i === 0 ? "none" : "1px solid",
              borderColor: "divider",
            }}
          >
            <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
              <Typography sx={{ fontSize: 14 }}>
                {clash.reason || "Collision"}
              </Typography>
              {clash.subStep != null && (
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
                  sub-step {clash.subStep}
                </Box>
              )}
            </Box>
            <Box sx={{ mt: 0.5 }}>
              {clash.playerIDs.map((id) => (
                <Participant
                  key={id}
                  id={id}
                  board={board}
                  survived={aliveIDs.has(id)}
                />
              ))}
            </Box>
          </Box>
        ))}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  )
}

export default ClashDialog
