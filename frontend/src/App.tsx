import {
  AppBar,
  Box,
  Button,
  Container,
  Typography,
} from "@mui/material"
import React, { ErrorInfo, ReactNode, Suspense } from "react"
import {
  Route,
  BrowserRouter as Router,
  Routes,
  useNavigate,
} from "react-router-dom"
import { CenteredLoader } from "./components/CenteredLoader"
import { UserProvider, useUser } from "./context/UserContext"
import GamePage from "./pages/GamePage/index"
import HomePage from "./pages/HomePage"
import LadderPage from "./pages/LadderPage"
import ProfilePage from "./pages/ProfilePage"
import Sessionpage from "./pages/SessionPage"

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  hasError: boolean
}

class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(err: Error): ErrorBoundaryState {
    console.log(err)
    return { hasError: true }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error("Caught an error:", error, errorInfo)
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return <h1>Something went wrong. Please refresh the page.</h1>
    }

    return this.props.children
  }
}

const App: React.FC = () => {
  return (
    <ErrorBoundary>
      <UserProvider>
        <Router>
          <Suspense fallback={<CenteredLoader />}>
            <AppContent />
          </Suspense>
        </Router>
      </UserProvider>
    </ErrorBoundary>
  )
}

const AppContent: React.FC = () => {
  const { name } = useUser()
  const navigate = useNavigate()

  return (
    <>
      <AppBar position="static">
        <Container maxWidth="lg" sx={{ p: 1, display: "flex" }}>
          <Button
            color="primary"
            sx={{
              height: 30,
              minWidth: "auto",
              padding: 0,
              px: 1,
              mr: 2,
            }}
            onClick={() => navigate("/")}
          >
            🐍 team snek
          </Button>
          <Typography
            variant="h6"
            color="primary"
            sx={{ flexGrow: 1, textDecoration: "none" }}
          />
          <Button
            color="primary"
            sx={{ height: 30, minWidth: "auto", px: 1 }}
            onClick={() => navigate("/ladder")}
          >
            🪜
          </Button>
          <Button
            color="primary"
            sx={{ height: 30 }}
            onClick={() => navigate("/profile")}
          >
            {name}
          </Button>
        </Container>
      </AppBar>
      {/* The app's column. Wider than the old "sm" (600px) so the board has
          room to be read at a cell size its units can write their numbers on;
          the board itself may be dragged wider still and simply overflows this
          column, which clips nothing. */}
      <Container maxWidth="lg" sx={{ p: 1 }}>
        <Box width="100%">
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/session/:sessionName" element={<Sessionpage />} />
            <Route
              path="/session/:sessionName/:gameID"
              element={<GamePage />}
            />
            <Route path="/profile" element={<ProfilePage />} />
            <Route path="/centaurs" element={<ProfilePage />} />
            <Route path="/ladder" element={<LadderPage />} />
            <Route path="/ladder/:centaurId" element={<LadderPage />} />
          </Routes>
        </Box>
      </Container>
    </>
  )
}

export default App
