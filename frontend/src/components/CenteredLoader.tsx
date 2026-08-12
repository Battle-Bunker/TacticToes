import { Box, CircularProgress } from "@mui/material"
import React from "react"

/**
 * Full-viewport centered content; renders a spinner unless children are
 * provided.
 */
export const CenteredLoader: React.FC<{ children?: React.ReactNode }> = ({
  children,
}) => (
  <Box
    sx={{
      display: "flex",
      justifyContent: "center",
      alignItems: "center",
      height: "100vh",
    }}
  >
    {children ?? <CircularProgress />}
  </Box>
)
