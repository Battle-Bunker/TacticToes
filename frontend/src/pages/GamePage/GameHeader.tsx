import React, { useState } from "react"
import { Box, Button, Typography } from "@mui/material"
import RulesDialog from "./RulesDialog"
import { useGameStateContext } from "../../context/GameStateContext"

const GameHeader: React.FC = () => {
  const { sessionName } = useGameStateContext()

  const [openRulesDialog, setOpenRulesDialog] = useState(false)

  const handleShare = async () => {
    if (!navigator.share) return
    await navigator.share({
      title: "Tactic toes",
      text: "This game is completely unrelated to toes.",
      url: `/session/${sessionName}`,
    })
  }

  return (
    <Box>
      {/* Header */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <Typography
          variant="h5"
          sx={{
            flexGrow: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {sessionName}
        </Typography>
        <Box sx={{ display: "flex", gap: 2 }}>
          <Button
            onClick={() => setOpenRulesDialog(true)}
            sx={{
              height: 30,
              backgroundColor: "#ffd1dc", // Pastel pink
              color: "#000",
              whiteSpace: "nowrap",
              "&:hover": {
                backgroundColor: "#ffb6c1", // Slightly darker pastel pink
              },
            }}
          >
            📖 Rules
          </Button>
          <Button
            onClick={handleShare}
            sx={{
              height: 30,
              backgroundColor: "#b3e5fc", // Pastel blue
              color: "#000",
              whiteSpace: "nowrap",
              "&:hover": {
                backgroundColor: "#81d4fa", // Slightly darker pastel blue
              },
            }}
          >
            🧑‍🤝‍🧑 Invite
          </Button>
        </Box>
      </Box>

      <RulesDialog
        open={openRulesDialog}
        onClose={() => setOpenRulesDialog(false)}
      />
    </Box>
  )
}

export default GameHeader
