// src/pages/LadderPage/LadderLeaderboard.tsx

import {
  Box,
  CircularProgress,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material'
import React from 'react'
import { useNavigate } from 'react-router-dom'
import { CentaurLink } from '../../components/CentaurLink'
import { useLadder } from './LadderContext'
import { usePlayerInfo } from './usePlayerInfo'
import { formatCentaurName } from './utils'

interface Props {
  centaurId?: string
}

export const LadderLeaderboard: React.FC<Props> = ({ centaurId }) => {
  const navigate = useNavigate()
  const { leaderboard, loadingLeaderboard } = useLadder()
  const { centaurs } = usePlayerInfo(
    leaderboard.map(entry => entry.centaurId)
  )

  if (loadingLeaderboard) {
    return <CircularProgress size={24} />
  }

  if (leaderboard.length === 0) {
    return <Typography>No rankings available.</Typography>
  }

  return (
    <Box>
      <Typography variant="h5" gutterBottom>Leaderboard</Typography>
      <TableContainer>
        <Table size="small" sx={{ tableLayout: 'fixed' }}>
          <colgroup>
            <col style={{ width: '80px' }} />
            <col />
            <col style={{ width: '100px' }} />
          </colgroup>
          <TableHead>
            <TableRow>
              <TableCell>Rank</TableCell>
              <TableCell>Centaur</TableCell>
              <TableCell>MMR</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {leaderboard.map((entry, index) => (
              <TableRow
                key={entry.centaurId}
                sx={{
                  backgroundColor:
                    entry.centaurId === centaurId
                      ? 'rgba(0,0,0,0.08)'
                      : 'inherit',
                  cursor: 'pointer',
                  '&:hover': {
                    opacity: 0.8,
                  },
                }}
                onClick={() => navigate(`/ladder/${entry.centaurId}`)}
              >
                <TableCell>{index + 1}</TableCell>
                <TableCell>
                  <CentaurLink centaurId={entry.centaurId}>
                    {formatCentaurName(centaurs[entry.centaurId], entry.centaurId)}
                  </CentaurLink>
                </TableCell>
                <TableCell>{entry.ranking.currentMMR}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  )
}
