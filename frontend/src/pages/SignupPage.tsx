import React, { useState } from "react"
import { Box, Button, Container, Typography } from "@mui/material"
import { signInWithPopup } from "firebase/auth"
import { auth, provider } from "../firebaseConfig"

const SignupPage: React.FC = () => {
  const [message, setMessage] = useState<string>("")

  const handleSignInWithGoogle = async () => {
    setMessage("")
    try {
      await signInWithPopup(auth, provider)
    } catch (error) {
      console.error("Error signing in with Google:", error)
      setMessage("Google sign-in failed. Try again.")
    }
  }

  return (
    <Container sx={{ mt: 1 }}>
      <Box
        width="100%"
        display="flex"
        flexDirection="column"
        alignItems="center"
      >
        <Typography variant="h4" sx={{ my: 4 }}>
          Hi. Glad you're here.
        </Typography>

        <Button variant="contained" onClick={handleSignInWithGoogle}>
          Sign in with Google
        </Button>

        {message && (
          <Typography color="error" sx={{ mt: 2 }}>
            {message}
          </Typography>
        )}
      </Box>
    </Container>
  )
}

export default SignupPage
