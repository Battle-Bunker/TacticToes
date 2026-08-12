import { Box } from "@mui/material"
import React from "react"

interface GridCellProps {
  index: number
  cellSize: number
  cellContent: React.ReactNode
  backgroundColor: string
  isWinningSquare: boolean
  hasClash: boolean
  onClick: (index: number) => void
}

const GridCell: React.FC<GridCellProps> = React.memo(
  ({
    index,
    cellSize,
    cellContent,
    backgroundColor,
    isWinningSquare,
    hasClash,
    onClick,
  }) => {
    return (
      <Box
        onClick={() => onClick(index)}
        sx={{
          width: "100%",
          paddingBottom: "100%",
          position: "relative",
          border: "1px solid black",
          cursor: hasClash ? "pointer" : "default",
          backgroundColor: isWinningSquare ? "green" : backgroundColor || "white",
          transition: "background-color 0.3s",
          boxSizing: "border-box",
        }}
      >
        <Box
          sx={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            fontSize: `${cellSize}px`,
            textAlign: "center",
            userSelect: "none",
            zIndex: 1,
          }}
        >
          {!isWinningSquare && cellContent}
        </Box>
      </Box>
    )
  },
)

export default GridCell
