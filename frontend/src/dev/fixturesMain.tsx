import CssBaseline from "@mui/material/CssBaseline"
import { ThemeProvider } from "@mui/material/styles"
import React from "react"
import ReactDOM from "react-dom/client"
import "@fontsource/roboto-mono"
import { theme } from "../theme"
import BoardFixturesPage from "./BoardFixturesPage"

// ── Entry point: the board fixture harness ──────────────────────────────────
//
// Its OWN entry, served by the dev server at /dev-fixtures.html and never named
// in the production build's inputs, so it is not part of the app that ships.
//
// Separate for one concrete reason: the app's entry pulls in the Firebase
// client, which refuses to load without a configured project — and a bench for
// looking at board marks should run on a laptop with no project, no game and no
// sign-in. It wears the app's real theme, so what is reviewed here is what
// ships.

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <BoardFixturesPage />
    </ThemeProvider>
  </React.StrictMode>,
)
