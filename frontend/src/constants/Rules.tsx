import React from "react"
import { Stack, Typography } from "@mui/material"

export const Connect4Rules: React.FC = () => {
  return (
    <Stack spacing={2}>
      <Typography>Connect 4, but everyone moves at the same time.</Typography>
      <Typography>
        Get four in a row to win. You have to place squares on top of a previous
        piece.
      </Typography>
      <Typography>
        If two people pick the same square, that square is blocked for the rest
        of the game.
      </Typography>
      <Typography>
        If two people win simultaneously, the winning squares all become
        blocked.
      </Typography>
    </Stack>
  )
}

export const LongBoiRules: React.FC = () => {
  return (
    <Stack spacing={2}>
      <Typography>
        Form the longest single path by connecting squares up, down, left, or
        right.
      </Typography>
      <Typography>Diagonal connections and branches don't count.</Typography>
      <Typography>
        If two people pick the same square, that square is blocked for the rest
        of the game.
      </Typography>
    </Stack>
  )
}

export const TacticToesRules: React.FC = () => {
  return (
    <Stack spacing={2}>
      <Typography>
        Get 4 squares in a row to win. You can place squares anywhere.
      </Typography>
      <Typography>
        If two people pick the same square, that square is blocked for the rest
        of the game.
      </Typography>
      <Typography>
        If two people win simultaneously, the winning squares all become
        blocked.
      </Typography>
    </Stack>
  )
}

export const SnekRules: React.FC = () => {
  return (
    <Stack spacing={2}>
      <Typography>Multiplayer Nokia snake.</Typography>
      <Typography>
        If you hit an opponent's body, your own body, or a wall you die.
      </Typography>
      <Typography>
        If you run into someone head to head, the shorter snake dies.
      </Typography>
      <Typography>Eat apples to get longer.</Typography>
    </Stack>
  )
}

export const TeamSnekRules: React.FC = () => {
  return (
    <Stack spacing={2}>
      <Typography>Team-based snake game where players work together!</Typography>
      <Typography>
        Team score is the combined length of all snakes on the team.
      </Typography>
      <Typography>
        Standard snake rules apply: hit walls, bodies, or lose head-to-head (shorter dies).
      </Typography>
      <Typography>Eat apples to grow longer. Work together to maximize your team's total length!</Typography>
    </Stack>
  )
}

export const KingSnekRules: React.FC = () => {
  return (
    <Stack spacing={2}>
      <Typography>Team-based snake with a twist: each team has a King!</Typography>
      <Typography>
        👑 Select one player per team as the King. If the King dies, the entire team is eliminated.
      </Typography>
      <Typography>
        Team score is determined by the King's snake length only, not the whole team.
      </Typography>
      <Typography>
        Standard snake rules apply: hit walls, bodies, or lose head-to-head (shorter dies).
      </Typography>
      <Typography>Eat apples to grow longer. Protect your King!</Typography>
    </Stack>
  )
}

export const ColorClashRules: React.FC = () => {
  return (
    <Stack spacing={2}>
      <Typography>
        ColourClash is a board game where players compete to create the largest
        area of their color.
      </Typography>
      <Typography>Players start in different corners of the board.</Typography>
      <Typography>
        On your turn, place a piece next to one of your existing pieces.
      </Typography>
      <Typography>The game ends when no one can make a move.</Typography>
      <Typography>
        The player with the largest connected color area wins!
      </Typography>
      <Typography>
        Strategy tip: Expand your area while blocking opponents. Think ahead!
      </Typography>
    </Stack>
  )
}

export const ReversiRules: React.FC = () => {
  return (
    <Stack spacing={2}>
      <Typography>
        Reversi is a strategy board game for two players, played on an 8x8 grid.
      </Typography>
      <Typography>
        Players take turns placing pieces on the board with their color facing
        up.
      </Typography>
      <Typography>
        When you place a piece such that it brackets one or more of your
        opponent's pieces in a straight line (horizontally, vertically, or
        diagonally), those pieces are flipped to your color.
      </Typography>
      <Typography>
        The game ends when neither player can make a valid move. The player with
        the most pieces on the board wins.
      </Typography>
      <Typography>
        Note: this game only works with two players. Chatgpt kinda mid....
      </Typography>
    </Stack>
  )
}
