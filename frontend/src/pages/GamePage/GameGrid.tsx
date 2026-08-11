import { Box, IconButton, Typography, Slider } from "@mui/material"
import { GamePlayer, GameState } from "@shared/types/Game"
import React, { useEffect, useLayoutEffect, useRef, useState } from "react"
import { useGameStateContext } from "../../context/GameStateContext"
import ClashDialog from "./ClashDialog"
import GridCell from "./GridCell"
import SnakeGameLogic from "./SnakeGameLogic"
import {
  ArrowBack,
  ArrowForward,
  FirstPage,
  LastPage,
} from "@mui/icons-material"

export interface GameLogicProps {
  gameState: GameState
  gridWidth: number
  cellSize: number
  selectedTurnIndex: number
}

export interface ClashInfo {
  reason: string
  playerIDs: string[]
}

export interface GameLogicReturn {
  cellContentMap: { [index: number]: JSX.Element }
  cellBackgroundMap: { [index: number]: string }
  clashesAtPosition: { [index: number]: ClashInfo }
}

const GameGrid: React.FC = () => {
  const { gameState, latestTurn } = useGameStateContext()

  const winners = latestTurn?.winners || []
  const gridWidth = gameState?.setup.boardWidth || 8
  const gridHeight = gameState?.setup.boardHeight || 8
  const totalCells = gridWidth * gridHeight
  const winningSquaresSet = new Set(
    winners.flatMap((winner) => winner.winningSquares),
  )

  const [selectedTurnIndex, setSelectedTurnIndex] = useState<number>(-1)
  const [turnCount, setTurnCount] = useState<number>(0)

  const [clashReason, setClashReason] = useState<string>("")
  const [openClashDialog, setOpenClashDialog] = useState(false)
  const [clashPlayersList, setClashPlayersList] = useState<GamePlayer[]>([])
  const [gameLogicReturn, setGameLogicReturn] = useState<
    GameLogicReturn | undefined
  >()
  const gridRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState<number>(0)

  const cellSize = containerWidth ? containerWidth / gridWidth : 0

  useLayoutEffect(() => {
    const updateContainerWidth = () => {
      if (gridRef.current) {
        setContainerWidth(gridRef.current.offsetWidth)
      }
    }
    updateContainerWidth()
    window.addEventListener("resize", updateContainerWidth)
    return () => {
      window.removeEventListener("resize", updateContainerWidth)
    }
  }, [gridWidth, selectedTurnIndex])

  const handleSquareClick = (index: number) => {
    if (!gameState) return

    const clash = gameLogicReturn?.clashesAtPosition[index]
    if (!clash) return

    const playersInvolved = gameState.setup.gamePlayers.filter((player) =>
      clash.playerIDs.includes(player.id),
    )
    setClashReason(clash.reason)
    setClashPlayersList(playersInvolved)
    setOpenClashDialog(true)
  }

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

  useEffect(() => {
    if (gameState) {
      setGameLogicReturn(
        SnakeGameLogic({
          gameState,
          gridWidth,
          cellSize,
          selectedTurnIndex: selectedTurnIndex >= 0 ? selectedTurnIndex : 0,
        }),
      )
    }
  }, [gameState, gridWidth, cellSize, selectedTurnIndex])

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

  if (!gameLogicReturn) return null

  return (
    <>
      <Box
        ref={gridRef}
        sx={{
          display: "grid",
          gridTemplateColumns: `repeat(${gridWidth}, 1fr)`,
          width: "100%",
          maxWidth: 600,
          margin: "0 auto",
          border: "2px solid black",
          boxSizing: "border-box",
        }}
      >
        {Array.from({ length: totalCells }).map((_, index) => (
          <GridCell
            key={index}
            index={index}
            cellSize={cellSize}
            cellContent={gameLogicReturn.cellContentMap[index]}
            backgroundColor={gameLogicReturn.cellBackgroundMap[index]}
            isWinningSquare={
              selectedTurnIndex === turnCount - 1 &&
              winningSquaresSet.has(index)
            }
            hasClash={Boolean(gameLogicReturn.clashesAtPosition[index])}
            onClick={handleSquareClick}
          />
        ))}
      </Box>

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
