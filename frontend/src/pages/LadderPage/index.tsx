// src/pages/LadderPage/index.tsx

import { Box, Stack } from '@mui/material'
import { useParams } from 'react-router-dom'
import { LadderProvider } from './LadderContext'
import { LadderLeaderboard } from './LadderLeaderboard'
import { LadderPlayerStats } from './LadderPlayerStats'
import { LadderPreviousGames } from './LadderPreviousGames'
import { PlayerInfoHeader } from './PlayerInfoHeader'

const LadderPage = () => {
    const { centaurId } = useParams<{ centaurId: string }>()

    return (
        <Stack
            sx={{
                minHeight: "90vh",
                display: "flex",
                flexDirection: "column",
                justifyContent: "flex-start",
            }}
        >
            <LadderProvider centaurId={centaurId}>
                {centaurId && (
                    <>
                        <PlayerInfoHeader centaurId={centaurId} />
                        <Box sx={{ mt: 3 }}>
                            <LadderPlayerStats />
                        </Box>
                    </>
                )}
                <Box sx={{ mt: 3 }}>
                    <LadderLeaderboard centaurId={centaurId} />
                </Box>
                {centaurId && (
                    <Box sx={{ mt: 3 }}>
                        <LadderPreviousGames />
                    </Box>
                )}
            </LadderProvider>
        </Stack>
    )
}

export default LadderPage
