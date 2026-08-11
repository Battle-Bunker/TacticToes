import { Box, Button, Stack, Typography } from "@mui/material"
import React, { ChangeEvent, useState } from "react"
import { useNavigate } from "react-router-dom"
import TypingEffectInput from "../components/TypingEffectInput"

const HomePage: React.FC = () => {
  const navigate = useNavigate()
  const [sessionName, setSessionName] = useState("")
  const [error, setError] = useState("")

  const handleSessionNameChange = (e: ChangeEvent<HTMLInputElement>) => {
    const lowercaseValue = e.target.value.toLowerCase().replace(/[^a-z0-9]/g, "")
    setSessionName(lowercaseValue)
  }

  const handleNewGame = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    e.stopPropagation()

    if (sessionName === "") {
      setError("Friend, you need a session name.")
      return
    }
    navigate(`/session/${sessionName}`)
  }

  return (
    <Stack
      sx={{
        minHeight: "90vh",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
      }}
    >
      <Box>
        <Typography pt={10} variant="h4" align="left" gutterBottom>
          Team Snek: a game entirely unrelated to toes*
        </Typography>
        <Typography pt={2} variant="body2" align="left" gutterBottom>
          Pick a word for your session. If you want to watch with someone, use
          the same word.
        </Typography>
        <form onSubmit={handleNewGame} style={{ width: "100%" }}>
          <Box display="flex" alignItems="center" mt={3}>
            <TypingEffectInput
              value={sessionName}
              onChange={handleSessionNameChange}
            />
          </Box>
          <Button
            type="submit"
            fullWidth
            variant="contained"
            sx={{ mt: 2, fontSize: "32px" }}
          >
            Play
          </Button>
        </form>
        <Typography sx={{ pt: 2 }} color="error">
          {error}
        </Typography>
      </Box>


    </Stack>
  )
}

export default HomePage
