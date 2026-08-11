// src/pages/LadderPage/LadderPlayerStats.tsx

import { Box, CircularProgress, Typography } from '@mui/material'
import React from 'react'
import { useLadder } from './LadderContext'
import { calculateWinRate } from './utils'

interface StatBoxProps {
    label: string
    value: string | number
}

const StatBox: React.FC<StatBoxProps> = ({ label, value }) => (
    <Box
        sx={{
            border: '2px solid #000',
            p: 1,
            backgroundColor: '#fff',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 1,
            height: 80,
        }}
    >
        <Typography
            variant="h5"
            sx={{
                fontWeight: 'bold',
                fontFamily: '"Roboto Mono", monospace',
            }}
        >
            {value}
        </Typography>
        <Typography
            variant="body2"
            sx={{
                textTransform: 'uppercase',
                letterSpacing: '0.1em',
                opacity: 0.7,
            }}
        >
            {label}
        </Typography>
    </Box>
)

export const LadderPlayerStats: React.FC = () => {
    const { selectedRanking, loadingSelected } = useLadder()

    if (loadingSelected) {
        return <CircularProgress size={24} />
    }

    if (!selectedRanking) {
        return <Typography>No statistics available.</Typography>
    }

    const winRate = calculateWinRate(
        selectedRanking.wins,
        selectedRanking.gamesPlayed
    )

    return (
        <Box
            sx={{
                display: 'grid',
                gridTemplateColumns: { xs: '1fr 1fr', sm: '1fr 1fr 1fr 1fr' },
                gap: 2,
            }}
        >
            <StatBox label="Games" value={selectedRanking.gamesPlayed} />
            <StatBox label="Wins" value={selectedRanking.wins} />
            <StatBox label="Losses" value={selectedRanking.losses} />
            <StatBox label="Win Rate" value={`${winRate.toFixed(0)}%`} />
        </Box>
    )
}
