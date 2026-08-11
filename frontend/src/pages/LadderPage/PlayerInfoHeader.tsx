// src/pages/LadderPage/PlayerInfoHeader.tsx

import { Box, CircularProgress, Typography } from '@mui/material'
import React from 'react'
import { useLadder } from './LadderContext'
import { usePlayerInfo } from './usePlayerInfo'
import { formatCentaurName } from './utils'

interface Props {
    centaurId: string
}

export const PlayerInfoHeader: React.FC<Props> = ({ centaurId }) => {
    const { selectedRanking, loadingSelected } = useLadder()
    const { centaurs, loadingCentaurs } = usePlayerInfo([centaurId])
    const centaur = centaurs[centaurId]

    if (loadingCentaurs || loadingSelected) {
        return (
            <Box
                sx={{
                    p: 2,
                    border: '2px solid #000',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 2,
                    height: '70px',
                }}
            >
                <CircularProgress size={24} />
                <Typography variant="h5">Loading...</Typography>
            </Box>
        )
    }

    return (
        <Box
            sx={{
                p: 2,
                display: 'flex',
                height: '70px',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 2,
                border: '2px solid #000',
            }}
        >
            <Typography variant="h5">
                {formatCentaurName(centaur, centaurId)}
            </Typography>
            {selectedRanking && (
                <Typography
                    variant="h5"
                    sx={{ fontFamily: '"Roboto Mono", monospace' }}
                >
                    {selectedRanking.currentMMR} MMR
                </Typography>
            )}
        </Box>
    )
}
