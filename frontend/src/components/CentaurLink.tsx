import React from "react"
import { Link } from "react-router-dom"

/**
 * Canonical link to a centaur's ladder page: inherits the surrounding text
 * color and underlines on hover. Extra layout styles come in via `style`.
 * Clicks do not bubble, so the link can sit inside larger clickable areas
 * (e.g. a leaderboard row) without navigating twice.
 */
export const CentaurLink: React.FC<{
  centaurId: string
  style?: React.CSSProperties
  children: React.ReactNode
}> = ({ centaurId, style, children }) => (
  <Link
    to={`/ladder/${centaurId}`}
    style={{ color: "inherit", textDecoration: "none", ...style }}
    onClick={(e) => e.stopPropagation()}
    onMouseEnter={(e: React.MouseEvent<HTMLAnchorElement>) => {
      e.currentTarget.style.textDecoration = "underline"
    }}
    onMouseLeave={(e: React.MouseEvent<HTMLAnchorElement>) => {
      e.currentTarget.style.textDecoration = "none"
    }}
  >
    {children}
  </Link>
)
