import { Box, IconButton, Typography, Slider } from "@mui/material"
import { Clash, GamePlayer } from "@shared/types/Game"
import React, { useEffect, useMemo, useState } from "react"
import { useGameStateContext } from "../../context/GameStateContext"
import BoardCanvas from "../../board/BoardCanvas"
import { turnToBoard } from "../../board/turnToBoard"
import ClashDialog from "./ClashDialog"
import {
  ArrowBack,
  ArrowForward,
  FirstPage,
  LastPage,
} from "@mui/icons-material"

const GameGrid: React.FC = () => {
  const { gameState } = useGameStateContext()

  const [selectedTurnIndex, setSelectedTurnIndex] = useState<number>(-1)
  const [turnCount, setTurnCount] = useState<number>(0)

  const [clashReason, setClashReason] = useState<string>("")
  const [openClashDialog, setOpenClashDialog] = useState(false)
  const [clashPlayersList, setClashPlayersList] = useState<GamePlayer[]>([])

  // Follow the latest turn as new turns arrive
  useEffect(() => {
    if (gameState?.turns) {
      const newTurnCount = gameState.turns.length
      if (newTurnCount !== turnCount) {
        setTurnCount(newTurnCount)
        setSelectedTurnIndex(newTurnCount - 1)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameState?.turns?.length])

  const viewedTurnIndex = selectedTurnIndex >= 0 ? selectedTurnIndex : 0

  const board = useMemo(
    () =>
      gameState
        ? turnToBoard(gameState, viewedTurnIndex, {
            showWinningSquares: viewedTurnIndex === gameState.turns.length - 1,
          })
        : null,
    [gameState, viewedTurnIndex],
  )

  // Clash squares stay clickable whether or not a marker is drawn on them: the
  // dialog explains what happened there, and a survivor standing on the square
  // is exactly when that explanation is worth reading.
  const clashesAtIndex = useMemo(() => {
    const map: { [index: number]: Clash } = {}
    gameState?.turns[viewedTurnIndex]?.clashes?.forEach((clash) => {
      map[clash.index] = clash
    })
    return map
  }, [gameState, viewedTurnIndex])

  const handleSquareClick = (index: number) => {
    if (!gameState) return
    const clash = clashesAtIndex[index]
    if (!clash) return

    const playersInvolved = gameState.setup.gamePlayers.filter((player) =>
      clash.playerIDs.includes(player.id),
    )
    setClashReason(clash.reason)
    setClashPlayersList(playersInvolved)
    setOpenClashDialog(true)
  }

  // Navigation handlers
  const handlePrevTurn = () => {
    if (gameState?.turns && selectedTurnIndex > 0) {
      setSelectedTurnIndex(selectedTurnIndex - 1)
    }
  }

  const handleNextTurn = () => {
    if (gameState?.turns && selectedTurnIndex < gameState.turns.length - 1) {
      setSelectedTurnIndex(selectedTurnIndex + 1)
    }
  }

  const handleLatestTurn = () => {
    if (gameState?.turns) {
      setSelectedTurnIndex(gameState.turns.length - 1)
    }
  }

  const handleFirstTurn = () => {
    if (gameState?.turns) {
      setSelectedTurnIndex(0)
    }
  }

  const handleSliderChange = (_event: Event, newValue: number | number[]) => {
    setSelectedTurnIndex(newValue as number)
  }

  if (!board) return null

  return (
    <>
      <BoardCanvas board={board} onCellClick={handleSquareClick} />

      {/* Turn navigation controls with slider */}
      <Box
        sx={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          width: "100%",
          margin: "0 auto",
          mt: 2,
        }}
      >
        {/* Slider */}
        <Box sx={{ width: "100%", px: 2 }}>
          <Slider
            value={selectedTurnIndex}
            onChange={handleSliderChange}
            min={0}
            max={Math.max(0, (gameState?.turns?.length || 1) - 1)}
            step={1}
            disabled={!gameState?.turns || gameState.turns.length <= 1}
          />
        </Box>

        {/* Button controls */}
        <Box sx={{ display: "flex", alignItems: "center" }}>
          <IconButton onClick={handleFirstTurn} disabled={selectedTurnIndex <= 0}>
            <FirstPage />
          </IconButton>
          <IconButton onClick={handlePrevTurn} disabled={selectedTurnIndex <= 0}>
            <ArrowBack />
          </IconButton>
          <Typography variant="body2" sx={{ marginX: 2 }}>
            {gameState?.turns ? selectedTurnIndex + 1 : "Loading..."} of{" "}
            {gameState?.turns?.length || 0}
          </Typography>

          <IconButton
            onClick={handleNextTurn}
            disabled={
              !gameState?.turns || selectedTurnIndex >= gameState.turns.length - 1
            }
          >
            <ArrowForward />
          </IconButton>
          <IconButton
            onClick={handleLatestTurn}
            disabled={
              !gameState?.turns || selectedTurnIndex >= gameState.turns.length - 1
            }
          >
            <LastPage />
          </IconButton>
        </Box>
      </Box>

      <ClashDialog
        open={openClashDialog}
        onClose={() => setOpenClashDialog(false)}
        clashReason={clashReason}
        clashPlayersList={clashPlayersList}
        teams={gameState?.setup.teams || []}
      />
    </>
  )
}

export default GameGrid
