import { Box, SxProps, Theme } from "@mui/material"
import { Clash } from "@shared/types/Game"
import React from "react"
import { UnitType } from "@shared/types/Game"
import { GameLogicProps, GameLogicReturn } from "./GameGrid"
import { teamColorMap } from "../../hooks/useTeamColors"
import { getFertileTileColor } from "../../utils/fertileTileColor"
import { pieceGlyph } from "../../utils/unitGlyphs"

const BORDER_WIDTH = 4 // Width of the outline border and corner size

interface BorderStyles {
  borderTop: string
  borderRight: string
  borderBottom: string
  borderLeft: string
}

interface CellProps {
  children?: React.ReactNode
  sx?: SxProps<Theme>
  onClick?: () => void
  cornerColor?: string
}

const Cell: React.FC<CellProps> = ({ children, sx, onClick, cornerColor = "white" }) => (
  <Box
    onClick={onClick}
    sx={{
      position: "relative",
      width: "100%",
      height: "100%",
      padding: 0,
      margin: 0,
      boxSizing: "border-box",
    }}
  >
    <Box
      onClick={onClick}
      sx={{
        position: "relative",
        width: "100%",
        height: "100%",
        padding: 0,
        margin: 0,
        boxSizing: "border-box",
        ...sx,
      }}
    >
      {children}
    </Box>

    {[
      { top: 0, left: 0 },
      { top: 0, right: 0 },
      { bottom: 0, left: 0 },
      { bottom: 0, right: 0 },
    ].map((position, index) => (
      <Box
        key={index}
        sx={{
          position: "absolute",
          width: BORDER_WIDTH,
          height: BORDER_WIDTH,
          backgroundColor: cornerColor,
          zIndex: 2,
          ...position,
        }}
      />
    ))}
  </Box>
)

interface SnakeSegmentInfo {
  hasHead: boolean
  hasTail: boolean
  count: number
}

interface CellSnakeSegments {
  [position: number]: {
    [playerID: string]: SnakeSegmentInfo
  }
}

const GameLogic = ({
  gameState,
  cellSize,
  selectedTurnIndex,
}: GameLogicProps): GameLogicReturn => {
  const cellContentMap: { [index: number]: JSX.Element } = {}
  const cellBackgroundMap: { [index: number]: string } = {}
  const clashesAtPosition: { [index: number]: Clash } = {}
  const selectedTurn = gameState.turns[selectedTurnIndex]

  if (!selectedTurn) {
    return {
      cellContentMap,
      cellBackgroundMap,
      clashesAtPosition,
    }
  }

  const { playerPieces, clashes, food, hazards, fertileTiles, invulnerabilityPotions, playerInvulnerabilityLevel } =
    selectedTurn
  // Walls are static for the whole game and live on the game doc, not the turn.
  const walls = gameState.walls

  // Map clashes to positions
  if (clashes) {
    clashes.forEach((clash) => {
      clashesAtPosition[clash.index] = clash
    })
  }

  const cellSnakeSegments: CellSnakeSegments = {}

  const getGamePlayer = (playerID: string) =>
    gameState.setup.gamePlayers.find((gp) => gp.id === playerID)

  // A unit's current type: the turn's live type map wins (pawns promote),
  // then the initial type from setup; absent everywhere means "snake".
  const getUnitType = (playerID: string): UnitType =>
    selectedTurn.unitTypes?.[playerID] ??
    getGamePlayer(playerID)?.unitType ??
    "snake"

  const teamColors = teamColorMap(gameState.setup.teams)

  // Per-type max health (configurable in setup, default 100).
  const maxHealthFor = (type: UnitType): number =>
    gameState.setup.maxHealthPerUnit?.[type] ?? 100

  // A prominent health bar anchored at the bottom of a unit's key cell
  // (snake head / piece square). Dead units render no bar.
  const healthBar = (playerID: string): JSX.Element | null => {
    if (!selectedTurn.alivePlayers.includes(playerID)) return null
    const health = selectedTurn.playerHealth[playerID]
    if (health === undefined) return null
    const fraction = Math.max(
      0,
      Math.min(1, health / maxHealthFor(getUnitType(playerID))),
    )
    const fillColor =
      fraction < 0.1 ? "#e53935" : fraction < 0.25 ? "#fb8c00" : "#43a047"
    return (
      <Box
        sx={{
          position: "absolute",
          bottom: "4%",
          left: "5%",
          width: "90%",
          height: "15%",
          backgroundColor: "rgba(0, 0, 0, 0.5)",
          borderRadius: "2px",
          overflow: "hidden",
          zIndex: 3,
          pointerEvents: "none",
        }}
      >
        <Box
          sx={{
            width: `${fraction * 100}%`,
            height: "100%",
            backgroundColor: fillColor,
          }}
        />
      </Box>
    )
  }

  const getSnakeColor = (playerID: string): string => {
    const teamID = getGamePlayer(playerID)?.teamID
    return (teamID !== undefined ? teamColors.get(teamID) : undefined) ?? "white"
  }

  const getOutlineColor = (playerID: string): string => {
    const level = playerInvulnerabilityLevel?.[playerID] ?? 0
    if (level > 0) return "#00BFFF"
    if (level < 0) return "#FF3333"
    return "white"
  }

  const getSnakeBorders = (
    position: number,
    index: number,
    positions: number[],
    borderColor: string = "white",
  ): BorderStyles => {
    const gridWidth = gameState.setup.boardWidth
    const prevPos = index > 0 ? positions[index - 1] : null
    const nextPos = index < positions.length - 1 ? positions[index + 1] : null

    const borders: BorderStyles = {
      borderTop: `${BORDER_WIDTH}px solid ${borderColor}`,
      borderRight: `${BORDER_WIDTH}px solid ${borderColor}`,
      borderBottom: `${BORDER_WIDTH}px solid ${borderColor}`,
      borderLeft: `${BORDER_WIDTH}px solid ${borderColor}`,
    }

    if (prevPos !== null) {
      if (prevPos === position - 1) borders.borderLeft = "none"
      if (prevPos === position + 1) borders.borderRight = "none"
      if (prevPos === position - gridWidth) borders.borderTop = "none"
      if (prevPos === position + gridWidth) borders.borderBottom = "none"
    }

    if (nextPos !== null) {
      if (nextPos === position - 1) borders.borderLeft = "none"
      if (nextPos === position + 1) borders.borderRight = "none"
      if (nextPos === position - gridWidth) borders.borderTop = "none"
      if (nextPos === position + gridWidth) borders.borderBottom = "none"
    }

    return borders
  }

  // Cells occupied by living chess pieces (rendered separately below); the
  // snake border-joining / length-label / stacked-tail logic must not run
  // for them.
  const pieceCells = new Set<number>()

  // Collect snake segments
  Object.entries(playerPieces).forEach(([playerID, positions]) => {
    if (getUnitType(playerID) !== "snake") return
    const snakeColor = getSnakeColor(playerID)

    // Iterate through positions in reverse order
    for (let index = positions.length - 1; index >= 0; index--) {
      const position = positions[index]
      const isHead = index === 0
      const isTail = index === positions.length - 1

      if (!cellSnakeSegments[position]) {
        cellSnakeSegments[position] = {}
      }

      if (!cellSnakeSegments[position][playerID]) {
        cellSnakeSegments[position][playerID] = {
          hasHead: isHead,
          hasTail: isTail,
          count: 1,
        }
      } else {
        cellSnakeSegments[position][playerID].count += 1
        // Preserve head information if this segment is the head
        if (isHead) {
          cellSnakeSegments[position][playerID].hasHead = true
        }
      }

      cellBackgroundMap[position] = snakeColor
    }
  })

  // Render snake segments
  Object.entries(cellSnakeSegments).forEach(([positionStr, playersInCell]) => {
    const position = parseInt(positionStr)

    Object.entries(playersInCell).forEach(([playerID, segmentInfo]) => {
      const { hasHead, hasTail, count } = segmentInfo as SnakeSegmentInfo
      const positions = playerPieces[playerID]

      const outlineColor = getOutlineColor(playerID)
      const borders = getSnakeBorders(
        position,
        positions.indexOf(position),
        positions,
        outlineColor,
      )

      let content: JSX.Element | null = null

      const snakeColor = getSnakeColor(playerID)

      const commonBoxStyle: SxProps<Theme> = {
        ...borders,
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        backgroundColor: snakeColor,
        padding: 0,
        margin: 0,
      }

      if (hasHead) {
        const letter = getGamePlayer(playerID)?.letter ?? "?"

        content = (
          <Cell
            key={`head-${playerID}-${position}-${selectedTurnIndex}`}
            sx={commonBoxStyle}
            cornerColor={outlineColor}
          >
            <span
              style={{
                fontSize: cellSize * 0.65,
                lineHeight: 1,
                zIndex: 2,
                color: "white",
                fontWeight: 900,
                fontFamily: "sans-serif",
                textShadow:
                  "0 0 3px rgba(0, 0, 0, 0.9), 0 1px 2px rgba(0, 0, 0, 0.7)",
                // Sit slightly higher so the bottom-anchored health bar
                // never collides with the letter.
                transform: "translateY(-10%)",
              }}
            >
              {letter}
            </span>
            {healthBar(playerID)}
          </Cell>
        )
      } else if (positions[1] === position) {
        content = (
          <Cell
            key={`body-length-${playerID}-${position}-${selectedTurnIndex}`}
            sx={commonBoxStyle}
            cornerColor={outlineColor}
          >
            <Box
              sx={{
                fontSize: cellSize * 0.6,
                lineHeight: 1,
                color: "black",
                fontWeight: "bold",
                zIndex: 2,
              }}
            >
              {positions.length}
            </Box>
          </Cell>
        )
      } else if (hasTail && count > 1) {
        content = (
          <Cell
            key={`tail-${playerID}-${position}`}
            sx={commonBoxStyle}
            cornerColor={outlineColor}
          >
            <Box
              sx={{
                fontSize: cellSize * 0.6,
                lineHeight: 1,
                color: "black",
                fontWeight: "bold",
                zIndex: 2,
              }}
            >
              {count}
            </Box>
          </Cell>
        )
      } else {
        content = (
          <Cell
            key={`body-${playerID}-${position}`}
            sx={commonBoxStyle}
            cornerColor={outlineColor}
          />
        )
      }

      if (content) {
        cellContentMap[position] = content
      }
    })
  })

  // Render chess pieces: a piece is a weight-stack (N copies of one square),
  // drawn as a single cell with the piece glyph, a letter badge, a weight
  // badge when the stack is taller than 1, and a facing marker for pawns.
  Object.entries(playerPieces).forEach(([playerID, positions]) => {
    const unitType = getUnitType(playerID)
    if (unitType === "snake" || positions.length === 0) return

    const position = positions[0]
    const weight = positions.length
    const glyph = pieceGlyph(unitType) ?? "?"
    const teamColor = getSnakeColor(playerID)
    const outlineColor = getOutlineColor(playerID)
    const letter = getGamePlayer(playerID)?.letter ?? "?"

    pieceCells.add(position)
    cellBackgroundMap[position] = teamColor

    const badgeStyle: SxProps<Theme> = {
      position: "absolute",
      fontSize: Math.max(7, cellSize * 0.25),
      lineHeight: 1,
      color: "black",
      fontWeight: "bold",
      zIndex: 3,
    }

    let facingMarker: JSX.Element | null = null
    const facing =
      unitType === "pawn" ? selectedTurn.unitFacing[playerID] : undefined
    if (facing) {
      const { dx, dy } = facing
      const arrow = dy < 0 ? "▲" : dy > 0 ? "▼" : dx < 0 ? "◀" : dx > 0 ? "▶" : null
      const placement: SxProps<Theme> =
        dy < 0
          ? { top: 0, left: "50%", transform: "translateX(-50%)" }
          : dy > 0
            // Above the bottom-anchored health bar
            ? { bottom: "18%", left: "50%", transform: "translateX(-50%)" }
            : dx < 0
              ? { left: 0, top: "50%", transform: "translateY(-50%)" }
              : { right: 0, top: "50%", transform: "translateY(-50%)" }
      if (arrow) {
        facingMarker = (
          <Box
            sx={{
              position: "absolute",
              fontSize: Math.max(7, cellSize * 0.25),
              lineHeight: 1,
              color: "white",
              textShadow: "0 0 2px rgba(0, 0, 0, 0.9)",
              zIndex: 3,
              ...placement,
            }}
          >
            {arrow}
          </Box>
        )
      }
    }

    cellContentMap[position] = (
      <Cell
        key={`piece-${playerID}-${position}-${selectedTurnIndex}`}
        sx={{
          border: `${BORDER_WIDTH}px solid ${outlineColor}`,
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          backgroundColor: teamColor,
          padding: 0,
          margin: 0,
        }}
        cornerColor={outlineColor}
      >
        <span
          style={{
            fontSize: cellSize * 0.7,
            lineHeight: 1,
            zIndex: 2,
            color: "white",
            fontWeight: 900,
            fontFamily: "sans-serif",
            textShadow:
              "0 0 3px rgba(0, 0, 0, 0.9), 0 1px 2px rgba(0, 0, 0, 0.7)",
            // Sit slightly higher so the bottom-anchored health bar never
            // collides with the glyph.
            transform: "translateY(-10%)",
          }}
        >
          {glyph}
        </span>
        <Box sx={{ ...badgeStyle, top: 1, left: 2 }}>{letter}</Box>
        {weight > 1 && (
          <Box sx={{ ...badgeStyle, bottom: "18%", right: 2 }}>{weight}</Box>
        )}
        {facingMarker}
        {healthBar(playerID)}
      </Cell>
    )
  })

  // Common style for non-snake cells
  const commonCellStyle: SxProps<Theme> = {
    fontSize: cellSize * 0.8,
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    padding: 0,
    margin: 0,
    boxSizing: "border-box",
  }

  // Place fertile ground tiles (grass-like background)
  if (fertileTiles && fertileTiles.length > 0) {
    const fertileSet = new Set(fertileTiles)
    const boardWidth = gameState.setup.boardWidth
    fertileTiles.forEach((position) => {
      if (!cellBackgroundMap[position]) {
        cellBackgroundMap[position] = getFertileTileColor(position, boardWidth, fertileSet)
      }
    })
  }

  // Place food
  food?.forEach((position) => {
    cellContentMap[position] = (
      <Box key={`food-${position}`} sx={commonCellStyle}>
        🎃
      </Box>
    )
  })

  // Place invulnerability potions
  invulnerabilityPotions?.forEach((position) => {
    cellContentMap[position] = (
      <Box key={`potion-${position}`} sx={commonCellStyle}>
        <img
          src="/invulnerability-potion.png"
          alt="Invulnerability Potion"
          style={{
            width: cellSize * 0.8,
            height: cellSize * 0.8,
            objectFit: "contain",
          }}
        />
      </Box>
    )
  })

  // Place walls
  walls.forEach((position) => {
    cellContentMap[position] = (
      <Box key={`wall-${position}`} sx={commonCellStyle}>
        🧱
      </Box>
    )
    cellBackgroundMap[position] = "#8B4513" // Brown color for walls
  })

  // Place hazards (rendered as red squares)
  hazards?.forEach((position) => {
    if (!cellContentMap[position]) {
      cellContentMap[position] = (
        <Box
          key={`hazard-${position}`}
          sx={{
            ...commonCellStyle,
            backgroundColor: "#ff4d4d",
            width: "100%",
            height: "100%",
          }}
        />
      )
    }
    if (!cellBackgroundMap[position]) {
      cellBackgroundMap[position] = "#ff4d4d"
    }
  })

  // Place clashes (only where no living unit exists)
  clashes?.forEach((clash) => {
    const position = clash.index
    if (!cellSnakeSegments[position] && !pieceCells.has(position)) {
      cellContentMap[position] = (
        <Box key={`clash-${position}`} sx={commonCellStyle}>
          💀
        </Box>
      )
      cellBackgroundMap[position] = "#d3d3d3"
    }
  })

  return {
    cellContentMap,
    cellBackgroundMap,
    clashesAtPosition,
  }
}

export default GameLogic
