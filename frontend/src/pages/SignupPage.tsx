import React, { useState } from "react"
import { Box, Button, Container, TextField, Typography } from "@mui/material"
import { signInWithPopup, User } from "firebase/auth"
import { doc, setDoc } from "firebase/firestore"
import { auth, db, provider } from "../firebaseConfig"

interface SignupPageProps {
  user: User | null
}

const SignupPage: React.FC<SignupPageProps> = ({ user }) => {
  const [name, setName] = useState<string>(user?.displayName ?? "")
  const [message, setMessage] = useState<string>("")
  const [busy, setBusy] = useState<boolean>(false)

  const handleSignInWithGoogle = async () => {
    setMessage("")
    try {
      await signInWithPopup(auth, provider)
    } catch (error) {
      console.error("Error signing in with Google:", error)
      setMessage("Google sign-in failed. Try again.")
    }
  }

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!user) return

    const trimmed = name.trim()
    if (!trimmed) {
      setMessage("Friend, you need a name.")
      return
    }

    setBusy(true)
    setMessage("")
    try {
      await setDoc(doc(db, "users", user.uid), { name: trimmed }, { merge: true })
    } catch (error) {
      console.error("Error saving name:", error)
      setMessage("Couldn't save your name. Try again.")
      setBusy(false)
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

        {!user ? (
          <Button variant="contained" onClick={handleSignInWithGoogle}>
            Sign in with Google
          </Button>
        ) : (
          <Box
            component="form"
            onSubmit={handleSubmit}
            sx={{
              width: "100%",
              maxWidth: "600px",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
            }}
          >
            <TextField
              label="Name"
              variant="outlined"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={busy}
              fullWidth
            />
            <Button type="submit" variant="contained" disabled={busy} sx={{ mt: 2 }}>
              Let's go
            </Button>
          </Box>
        )}

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
