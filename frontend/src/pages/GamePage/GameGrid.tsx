import { Box, IconButton, Typography, Slider } from "@mui/material"
import React, { useEffect, useMemo, useState } from "react"
import { useGameStateContext } from "../../context/GameStateContext"
import BoardCanvas from "../../board/BoardCanvas"
import { isInspectable } from "../../board/clashes"
import { Cell } from "../../board/renderer"
import { turnToBoard } from "../../board/turnToBoard"
import ClashDialog from "./ClashDialog"
import Scoreboard from "./Scoreboard"
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

  const [inspectedClashCell, setInspectedClashCell] = useState<Cell | null>(null)

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

  // Any square the turn's records can say something about is clickable: one
  // that was adjudicated, one somebody died on, one cut off a snake that lived,
  // and one the record could not account for. A survivor standing on the square
  // is exactly when that explanation is worth reading, and one square can hold
  // several records — the inspector keeps every one of them.
  const handleSquareClick = (cell: Cell) => {
    if (!board || !isInspectable(board, cell)) return
    setInspectedClashCell(cell)
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

      <Scoreboard board={board} />

      <ClashDialog
        open={inspectedClashCell !== null}
        onClose={() => setInspectedClashCell(null)}
        cell={inspectedClashCell}
        board={board}
      />
    </>
  )
}

export default GameGrid
