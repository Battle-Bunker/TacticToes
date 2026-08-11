import { Box, Button, Container, TextField } from "@mui/material"
import { signOut } from "firebase/auth"
import React, { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useUser } from "../context/UserContext"
import { auth } from "../firebaseConfig"

interface ProfilePageProps {
  setUpdatedName: (name: string) => void
  handleProfileClose: () => void
}

const ProfilePage: React.FC<ProfilePageProps> = ({
  setUpdatedName,
  handleProfileClose,
}) => {
  const { name: initialName } = useUser()
  const [name, setName] = useState<string>(initialName)
  const navigate = useNavigate()

  useEffect(() => {
    setUpdatedName(name)
  }, [name, setUpdatedName])

  return (
    <Container sx={{ maxWidth: "100%" }}>
      <Box
        width="100%"
        maxWidth="600px"
        display="flex"
        flexDirection="column"
        alignItems="center"
        mx="auto"
      >
        <TextField
          label="Name"
          variant="outlined"
          value={name}
          onChange={(e) => setName(e.target.value)}
          fullWidth
          sx={{ mt: 1 }}
        />
        <Button
          color="primary"
          onClick={() => {
            navigate("/centaurs")
            handleProfileClose()
          }}
          sx={{ mt: 2 }}
        >
          Centaurs 🐍
        </Button>
        <Button
          onClick={async () => {
            await signOut(auth)
            window.location.reload()
          }}
          sx={{ mt: 2 }}
        >
          Sign out
        </Button>
      </Box>
    </Container>
  )
}

export default ProfilePage
