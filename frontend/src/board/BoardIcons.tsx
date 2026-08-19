import React from "react"
import {
  ANVIL_COLORS,
  ANVIL_ICON,
  HAZARD_COLORS,
  HAZARD_ICON,
  ICON_COLORS,
  UNIT_ICONS,
  UnitIconKey,
} from "./renderer"

// The board's marks, as SVG, for the parts of the page that are not the board:
// one unit icon, one anvil, one hazard triangle, drawn from THE SAME path data
// the canvas renderer draws them from. Sharing the data rather than redrawing it
// is what keeps a scoreboard row and the cell it describes showing the same
// mark — a second copy of a rook would drift the first time either was touched.

/**
 * A unit's icon: the same layered mark the renderer paints on the unit's head
 * cell, white with a dark rim so it reads on any team colour.
 */
export const UnitIcon: React.FC<{ unitType: UnitIconKey; size?: number }> = ({
  unitType,
  size = 14,
}) => (
  <svg
    viewBox="0 0 24 24"
    width={size}
    height={size}
    style={{ display: "block" }}
    aria-hidden="true"
  >
    {(UNIT_ICONS[unitType] || UNIT_ICONS.snake).map((layer, i) => {
      const color = ICON_COLORS[layer.color] || ICON_COLORS.base
      if (layer.op === "stroke") {
        return (
          <path
            key={i}
            d={layer.d}
            fill="none"
            stroke={color}
            strokeWidth={layer.w || 2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )
      }
      // Filled layers stroke their dark outline FIRST, so the rim sits behind
      // the fill exactly as it does on the canvas.
      return (
        <React.Fragment key={i}>
          {layer.outline && (
            <path
              d={layer.d}
              fill="none"
              stroke={ICON_COLORS.line}
              strokeWidth={2.4}
              strokeLinejoin="round"
            />
          )}
          <path d={layer.d} fill={color} />
        </React.Fragment>
      )
    })}
  </svg>
)

/** The WEIGHT mark: a silver anvil, sized to a line of text. */
export const AnvilIcon: React.FC<{ height?: number }> = ({ height = 12 }) => (
  <svg
    viewBox={`0 0 ${ANVIL_ICON.w} ${ANVIL_ICON.h}`}
    height={height}
    width={(height * ANVIL_ICON.w) / ANVIL_ICON.h}
    style={{ display: "block", flexShrink: 0 }}
    aria-hidden="true"
  >
    <path
      d={ANVIL_ICON.d}
      fill={ANVIL_COLORS.fill}
      stroke={ANVIL_COLORS.line}
      strokeWidth={1.8}
      strokeLinejoin="round"
    />
  </svg>
)

/**
 * The EXTRA-VULNERABLE mark: the hazard triangle, its exclamation punched
 * through by the even-odd rule over a white backing — the same two-pass trick
 * the canvas uses, so the mark can never drift out of register.
 */
export const HazardIcon: React.FC<{ height?: number }> = ({ height = 12 }) => (
  <svg
    viewBox={`0 0 ${HAZARD_ICON.w} ${HAZARD_ICON.h}`}
    height={height}
    width={(height * HAZARD_ICON.w) / HAZARD_ICON.h}
    style={{ display: "block", flexShrink: 0 }}
    aria-hidden="true"
  >
    <path d={HAZARD_ICON.d} fill={HAZARD_COLORS.inner} fillRule="nonzero" />
    <path d={HAZARD_ICON.d} fill={HAZARD_COLORS.fill} fillRule="evenodd" />
  </svg>
)
