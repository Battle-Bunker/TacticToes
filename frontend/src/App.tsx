import CloseIcon from "@mui/icons-material/Close"
import {
  AppBar,
  Box,
  Button,
  CircularProgress,
  Container,
  Dialog,
  DialogContent,
  DialogTitle,
  IconButton,
  Typography,
} from "@mui/material"
import { doc, updateDoc } from "firebase/firestore"
import React, { ErrorInfo, ReactNode, Suspense, useState } from "react"
import {
  Route,
  BrowserRouter as Router,
  Routes,
  useNavigate,
} from "react-router-dom"
import { UserProvider, useUser } from "./context/UserContext"
import { db } from "./firebaseConfig"
import Centaurs from "./pages/Centaurs"
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

const CenteredLoader: React.FC = () => (
  <Box
    sx={{
      display: "flex",
      justifyContent: "center",
      alignItems: "center",
      height: "100vh",
    }}
  >
    <CircularProgress />
  </Box>
)

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
  const { name, userID } = useUser()
  const [isProfileOpen, setIsProfileOpen] = useState<boolean>(false)
  const [updatedName, setUpdatedName] = useState<string>(name)
  const navigate = useNavigate()

  const handleProfileOpen = (): void => {
    setIsProfileOpen(true)
  }

  const handleProfileClose = async (): Promise<void> => {
    setIsProfileOpen(false)
    const trimmed = updatedName.trim()
    if (trimmed && trimmed !== name) {
      await updateDoc(doc(db, "users", userID), { name: trimmed })
    }
  }

  return (
    <>
      <AppBar position="static">
        <Container maxWidth="sm" sx={{ p: 1, display: "flex" }}>
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
            onClick={handleProfileOpen}
          >
            {name}
          </Button>
        </Container>
      </AppBar>
      <Container maxWidth="sm" sx={{ p: 1 }}>
        <Box width="100%">
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/session/:sessionName" element={<Sessionpage />} />
            <Route
              path="/session/:sessionName/:gameID"
              element={<GamePage />}
            />
            <Route path="/centaurs" element={<Centaurs />} />
            <Route path="/ladder" element={<LadderPage />} />
            <Route path="/ladder/:centaurId" element={<LadderPage />} />
          </Routes>
        </Box>
      </Container>

      {/* Profile Modal */}
      <Dialog
        open={isProfileOpen}
        onClose={handleProfileClose}
        fullWidth
        maxWidth="sm"
        PaperProps={{
          sx: {
            border: "2px solid black",
            borderRadius: 0,
            boxShadow: "none",
          },
        }}
      >
        <DialogTitle>
          Update Profile
          <IconButton
            aria-label="close"
            onClick={handleProfileClose}
            sx={{
              position: "absolute",
              right: 8,
              top: 8,
              color: (theme) => theme.palette.grey[500],
            }}
          >
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent sx={{ overflowX: "hidden" }}>
          <ProfilePage
            setUpdatedName={setUpdatedName}
            handleProfileClose={handleProfileClose}
          />
        </DialogContent>
      </Dialog>
    </>
  )
}

export default App
