import { Box } from "@mui/material"
import React, { useCallback, useEffect, useRef } from "react"
import { BoardModel, getClickedCell, renderBoard, watchRenderScale } from "./renderer"
import { cellToIndex } from "./turnToBoard"

interface BoardCanvasProps {
  board: BoardModel
  /** Full-board index of the square a click landed on. */
  onCellClick?: (index: number) => void
  maxWidth?: number
}

/**
 * The board itself: one canvas the renderer owns. The element's CSS box is laid
 * out here (full width up to `maxWidth`, at the board's own aspect), and the
 * renderer sizes the backing store for the display, so a redraw is needed
 * whenever the box changes or the display's pixel ratio does.
 */
const BoardCanvas: React.FC<BoardCanvasProps> = ({
  board,
  onCellClick,
  maxWidth = 600,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const boardRef = useRef(board)
  boardRef.current = board

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (canvas) renderBoard(canvas, boardRef.current)
  }, [])

  useEffect(draw, [draw, board])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const observer = new ResizeObserver(draw)
    observer.observe(canvas)
    const stopWatchingScale = watchRenderScale(draw)
    return () => {
      observer.disconnect()
      stopWatchingScale()
    }
  }, [draw])

  const handleClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas || !onCellClick) return
    const cell = getClickedCell(canvas, board, event)
    if (cell) onCellClick(cellToIndex(cell, board.width, board.height))
  }

  return (
    <Box
      sx={{
        width: "100%",
        maxWidth,
        margin: "0 auto",
      }}
    >
      <canvas
        ref={canvasRef}
        onClick={handleClick}
        style={{
          display: "block",
          width: "100%",
          aspectRatio: `${board.width} / ${board.height}`,
        }}
      />
    </Box>
  )
}

export default BoardCanvas
