import React from "react"
import { Stack, Typography } from "@mui/material"

export const TeamSnekRules: React.FC = () => {
  return (
    <Stack spacing={2}>
      <Typography>
        Each team is a centaur controlling a squad of snakes. All snakes move
        simultaneously every turn; humans spectate.
      </Typography>
      <Typography>
        Eat 🎃 food to grow longer and restore health. Health drains every
        turn — much faster on hazard tiles — and a snake dies when it runs out.
      </Typography>
      <Typography>
        Hitting a wall or a snake's body is fatal. Head-to-head, the shorter
        snake dies; equal lengths kill both. Invulnerability potions protect a
        snake from collisions for a while.
      </Typography>
      <Typography>
        Team score is the combined length of the team's surviving snakes at the
        end of the game.
      </Typography>
      <Typography>
        The game ends when at most one team has snakes left, or when the turn
        limit is reached — highest team score wins.
      </Typography>
    </Stack>
  )
}
