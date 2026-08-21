import { Box } from "@mui/material"
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { isInspectable } from "./clashes"
import {
  BoardModel,
  Cell,
  getClickedCell,
  getTagAt,
  renderBoard,
  watchRenderScale,
} from "./renderer"

interface BoardCanvasProps {
  board: BoardModel
  /** The square a click landed on, in the board model's own coordinates. */
  onCellClick?: (cell: Cell) => void
  /**
   * A width the caller pins the board to, in CSS pixels. The board is then that
   * wide and wears no grip — for surfaces that lay several boards out
   * side by side (the fixture harness) rather than giving one board the page.
   */
  fixedWidth?: number
}

// ── Board size ───────────────────────────────────────────────────────────────
// The board's size is ONE number: the canvas element's CSS WIDTH in pixels. The
// height follows from the board's own aspect, and the renderer reads that box,
// backs the bitmap at the display's resolution and re-derives the cell size — so
// every size the grip is dragged to is drawn through the normal render path at
// full resolution. A stale bitmap is never stretched to fit, which is the one
// way a resize could blur.
//
// Size matters here beyond taste: a unit writes its numbers on its own body only
// while a cell is big enough to read them in, and real games run 21x21 and 25x25
// on a page column that used to be 600px wide. That is ~22px cells — under the
// floor — which is why those boards showed no body plates at all and every unit
// fell back to a tag. Room IS the feature.
const BOARD_WIDTH_KEY = "boardWidthPx"
const BOARD_WIDTH_MIN = 320
const BOARD_WIDTH_MAX = 2000
const BOARD_WIDTH_DEFAULT = 900
// The gutter kept between the board and the window's edges, so a board dragged
// past its column still never puts the page into horizontal scroll.
const VIEWPORT_GUTTER = 16

const readStoredWidth = (): number => {
  try {
    const stored = parseInt(
      window.localStorage.getItem(BOARD_WIDTH_KEY) ?? "",
      10,
    )
    if (Number.isFinite(stored)) return stored
  } catch {
    // Storage unavailable (private mode, blocked): session-only default.
  }
  return BOARD_WIDTH_DEFAULT
}

const storeWidth = (width: number) => {
  try {
    window.localStorage.setItem(BOARD_WIDTH_KEY, String(width))
  } catch {
    // Storage unavailable: the size lives for this session only.
  }
}

/** The widest board this window can show right now. */
const maxBoardWidth = (): number => {
  const available =
    typeof window === "undefined"
      ? BOARD_WIDTH_MAX
      : window.innerWidth - VIEWPORT_GUTTER * 2
  return Math.max(BOARD_WIDTH_MIN, Math.min(BOARD_WIDTH_MAX, available))
}

/**
 * The board itself: one canvas the renderer owns, in a frame the reader can
 * resize by its bottom-right grip.
 *
 * The frame is centred on the page column but is NOT bound by it — it takes the
 * width it is given and overflows the column evenly to both sides (the column
 * clips nothing), clamped only by the window. So the board can be dragged wider
 * than the text around it while the slider, the turn controls and everything
 * else below stay exactly where the column puts them.
 */
const BoardCanvas: React.FC<BoardCanvasProps> = ({
  board,
  onCellClick,
  fixedWidth,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const boardRef = useRef(board)
  boardRef.current = board

  // What the reader ASKED for, which outlives a window too narrow to honour it:
  // the clamp is applied on the way to the element, never to the preference, so
  // widening the window restores the size they chose.
  const [widthPref, setWidthPref] = useState(readStoredWidth)
  const [windowWidth, setWindowWidth] = useState(() =>
    typeof window === "undefined" ? BOARD_WIDTH_MAX : window.innerWidth,
  )
  const width = useMemo(() => {
    if (fixedWidth) return Math.round(fixedWidth)
    // windowWidth is read for its effect on the clamp; maxBoardWidth is the one
    // place the two are combined.
    void windowWidth
    return Math.round(
      Math.max(BOARD_WIDTH_MIN, Math.min(maxBoardWidth(), widthPref)),
    )
  }, [fixedWidth, widthPref, windowWidth])
  const height = Math.round((width * board.height) / board.width)

  // ── Tag hover ──────────────────────────────────────────────────────────────
  // Tags are always shown when warranted on this spectator board, so the pointer
  // has exactly one thing to say: resting on a TAG asks it to step aside. The
  // renderer keeps publishing the rect of a tag that has stepped aside, which is
  // what lets the pointer be seen leaving it.
  const [tagHoverUnitId, setTagHoverUnitId] = useState<string | null>(null)
  const tagHoverRef = useRef(tagHoverUnitId)
  tagHoverRef.current = tagHoverUnitId
  // The last pointer position over the board, or null when it is elsewhere. The
  // hover is re-derived from it after every render: tags move as turns land and
  // as the board is resized, so a still pointer can end up over something else.
  const pointerRef = useRef<{ clientX: number; clientY: number } | null>(null)

  // A clash cell can be clicked for the server's account of what happened
  // there, so the pointer says so over one — the mark on the board is the
  // affordance, and the cursor is what confirms it before the click.
  const [overClashCell, setOverClashCell] = useState(false)

  const syncHover = useCallback(() => {
    const canvas = canvasRef.current
    const pos = pointerRef.current
    const next = canvas && pos ? getTagAt(canvas, pos) : null
    setTagHoverUnitId((prev) => (prev === next ? prev : next))
    const cell =
      canvas && pos ? getClickedCell(canvas, boardRef.current, pos) : null
    const onClash = !!cell && isInspectable(boardRef.current, cell)
    setOverClashCell((prev) => (prev === onClash ? prev : onClash))
  }, [])

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (canvas) {
      renderBoard(canvas, boardRef.current, {
        tagHoverUnitId: tagHoverRef.current,
      })
    }
  }, [])

  useEffect(draw, [draw, board, tagHoverUnitId, width, height])
  // After the draw above — effects run in order — so the hit-test reads the tag
  // rects this frame actually published.
  useEffect(syncHover)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const observer = new ResizeObserver(draw)
    observer.observe(canvas)
    const stopWatchingScale = watchRenderScale(draw)
    const onWindowResize = () => setWindowWidth(window.innerWidth)
    window.addEventListener("resize", onWindowResize)
    // No further pointer events arrive once the window loses focus, so the
    // hover is stale the moment it happens.
    const onBlur = () => {
      pointerRef.current = null
      syncHover()
    }
    window.addEventListener("blur", onBlur)
    return () => {
      observer.disconnect()
      stopWatchingScale()
      window.removeEventListener("resize", onWindowResize)
      window.removeEventListener("blur", onBlur)
    }
  }, [draw, syncHover])

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    pointerRef.current = { clientX: event.clientX, clientY: event.clientY }
    syncHover()
  }

  const handlePointerLeave = () => {
    pointerRef.current = null
    syncHover()
  }

  const handleClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas || !onCellClick) return
    const cell = getClickedCell(canvas, board, event)
    if (cell) onCellClick(cell)
  }

  // ── The grip ───────────────────────────────────────────────────────────────
  // A drag on the bottom-right corner resizes the board. The pointer is captured
  // so the drag survives leaving the grip, and a burst of pointermoves is
  // coalesced onto ONE animation frame: at most one full-resolution re-render
  // per frame, which is what keeps a fast drag smooth instead of queueing
  // renders behind the pointer. The chosen size is persisted on release, not on
  // every frame.
  const dragRef = useRef<{ x: number; y: number; width: number } | null>(null)
  const pendingRef = useRef<number | null>(null)
  const frameRef = useRef<number | null>(null)
  const [dragging, setDragging] = useState(false)
  const aspect = board.height / board.width

  const handleGripDown = (event: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = { x: event.clientX, y: event.clientY, width }
    setDragging(true)
    event.currentTarget.setPointerCapture?.(event.pointerId)
    event.preventDefault()
    event.stopPropagation()
  }

  const handleGripMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = dragRef.current
    if (!start) return
    event.stopPropagation()
    // A corner grip follows the pointer on whichever axis it has travelled
    // furthest, with the vertical delta read back through the board's own aspect
    // so one drag scales the frame along its diagonal.
    const delta = Math.max(
      event.clientX - start.x,
      (event.clientY - start.y) / (aspect || 1),
    )
    pendingRef.current = start.width + delta
    if (frameRef.current != null) return
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null
      if (pendingRef.current == null) return
      setWidthPref(Math.round(pendingRef.current))
      pendingRef.current = null
    })
  }

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return
    dragRef.current = null
    setDragging(false)
    try {
      event.currentTarget.releasePointerCapture?.(event.pointerId)
    } catch {
      // Already released with the pointer itself.
    }
    if (frameRef.current != null) {
      window.cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
    const settled = Math.round(
      Math.max(
        BOARD_WIDTH_MIN,
        Math.min(BOARD_WIDTH_MAX, pendingRef.current ?? widthPref),
      ),
    )
    pendingRef.current = null
    setWidthPref(settled)
    storeWidth(settled)
  }

  const gripStripes = (color: string) =>
    `linear-gradient(135deg, transparent 52%, ${color} 52%, ${color} 62%, ` +
    `transparent 62%, transparent 72%, ${color} 72%, ${color} 82%, transparent 82%)`

  return (
    <Box
      sx={{
        width: "100%",
        display: "flex",
        justifyContent: "center",
        // The frame inside is free to be wider than this column and overflows it
        // evenly on both sides; nothing here clips it.
        overflow: "visible",
      }}
    >
      <Box
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
        sx={{
          position: "relative",
          flex: "0 0 auto",
          width,
          height,
        }}
      >
        <canvas
          ref={canvasRef}
          onClick={handleClick}
          style={{
            display: "block",
            width: "100%",
            height: "100%",
            cursor: onCellClick && overClashCell ? "pointer" : "default",
          }}
        />
        {!fixedWidth && (
        <Box
          role="separator"
          aria-label="Resize board"
          onPointerDown={handleGripDown}
          onPointerMove={handleGripMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          sx={{
            position: "absolute",
            right: 0,
            bottom: 0,
            width: 18,
            height: 18,
            cursor: "nwse-resize",
            touchAction: "none",
            zIndex: 2,
            borderBottomRightRadius: "4px",
            background: gripStripes(dragging ? "#1976d2" : "#888"),
            "&:hover": { background: gripStripes("#1976d2") },
          }}
        />
        )}
      </Box>
    </Box>
  )
}

export default BoardCanvas
