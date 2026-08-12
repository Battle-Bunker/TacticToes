import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  List,
  ListItem,
  ListItemText,
} from "@mui/material"
import { GamePlayer, Team } from "@shared/types/Game"
import React from "react"

interface ClashDialogProps {
  open: boolean
  onClose: () => void
  clashReason: string
  clashPlayersList: GamePlayer[]
  teams: Team[]
}

const ClashDialog: React.FC<ClashDialogProps> = ({
  open,
  onClose,
  clashReason,
  clashPlayersList,
  teams,
}) => {
  return (
    <Dialog open={open} onClose={onClose} sx={{ zIndex: 99999999 }}>
      <DialogTitle>Clash Details</DialogTitle>
      <DialogContent>
        <DialogContentText>{clashReason}</DialogContentText>
        <List>
          {clashPlayersList.map((gamePlayer) => {
            const team = teams.find((t) => t.id === gamePlayer.teamID)
            if (!team) return null
            return (
              <ListItem key={gamePlayer.id}>
                <ListItemText primary={`${team.name} ${gamePlayer.letter}`} />
              </ListItem>
            )
          })}
        </List>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  )
}

export default ClashDialog
