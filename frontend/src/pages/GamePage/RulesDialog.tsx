import React from "react"
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  Button,
} from "@mui/material"
import { TeamSnekRules } from "../../constants/Rules"

interface RulesDialogProps {
  open: boolean
  onClose: () => void
}

const RulesDialog: React.FC<RulesDialogProps> = ({ open, onClose }) => {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      PaperProps={{
        sx: {
          border: "2px solid black",
          borderRadius: 0,
          boxShadow: "none",
        },
      }}
    >
      <DialogTitle>Team Snek rules</DialogTitle>
      <DialogContent>
        <DialogContentText component="div">
          <TeamSnekRules />
        </DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  )
}

export default RulesDialog
