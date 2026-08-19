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
        Eat 🎃 food to grow longer and restore health to full. Health is spent
        per square moved — a snake always moves, so it pays 1 every turn and
        dies when its health runs out. Entering a hazard tile costs a
        configurable chunk of health (default 100 — usually lethal). Max
        health is configurable per unit type (default 100).
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
      <Typography>
        Teams may also field chess pieces ♟♞♝♜♛♚. Pieces move like in chess,
        but every square travelled costs 1 health (a knight's jump costs a
        flat 1), and a piece that stays put spends nothing — holding ground
        is free. Eating food adds weight, and weight settles collisions: when
        units meet — including mid-flight during a turn — the heaviest
        survives and ties kill everyone involved.
      </Typography>
      <Typography>
        Pawns face a direction and may spend a turn rotating; they step
        forward, attack diagonally, and promote to queens at the configured
        weight — a promoting pawn trades all its mass for the crown and
        restarts at weight 1. A team fielding kings is eliminated the moment
        its last king dies.
      </Typography>
    </Stack>
  )
}
