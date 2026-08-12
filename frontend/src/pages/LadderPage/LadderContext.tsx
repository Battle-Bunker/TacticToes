// src/pages/LadderPage/LadderContext.tsx

import React, { createContext, useContext, useEffect, useState } from 'react'
import { collection, doc, orderBy, query } from 'firebase/firestore'
import { db } from '../../firebaseConfig'
import { Ranking } from '@shared/types/Game'
import { LeaderboardEntry } from './types'
import { useFirestoreSubscription } from '../../hooks/useFirestoreSubscription'

interface LadderContextType {
    selectedRanking: Ranking | null
    leaderboard: LeaderboardEntry[]
    loadingSelected: boolean
    loadingLeaderboard: boolean
}

const LadderContext = createContext<LadderContextType>({
    selectedRanking: null,
    leaderboard: [],
    loadingSelected: true,
    loadingLeaderboard: true,
})

export const useLadder = () => useContext(LadderContext)

interface Props {
    children: React.ReactNode
    centaurId?: string
}

export const LadderProvider: React.FC<Props> = ({ children, centaurId }) => {
    const [selectedRanking, setSelectedRanking] = useState<Ranking | null>(null)
    const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([])
    const [loadingSelected, setLoadingSelected] = useState(true)
    const [loadingLeaderboard, setLoadingLeaderboard] = useState(true)

    // Reset/arm the loading flag when the selected centaur changes; the
    // subscription below resolves it.
    useEffect(() => {
        if (!centaurId) {
            setSelectedRanking(null)
            setLoadingSelected(false)
            return
        }
        setLoadingSelected(true)
    }, [centaurId])

    // Subscribe to the selected centaur's ranking doc
    useFirestoreSubscription({
        buildTarget: () => (centaurId ? doc(db, 'rankings', centaurId) : null),
        deps: [centaurId],
        logLabel: 'selected ranking',
        includeMetadataChanges: false,
        onSnapshot: (snapshot) => {
            setSelectedRanking(
                snapshot.exists() ? (snapshot.data() as Ranking) : null
            )
            setLoadingSelected(false)
        },
    })

    // Subscribe to the leaderboard: all rankings ordered by MMR.
    // loadingLeaderboard starts true and this once-per-mount subscription
    // resolves it.
    useFirestoreSubscription({
        buildTarget: () =>
            query(collection(db, 'rankings'), orderBy('currentMMR', 'desc')),
        deps: [],
        logLabel: 'leaderboard',
        includeMetadataChanges: false,
        onSnapshot: (snapshot) => {
            const entries: LeaderboardEntry[] = []
            snapshot.forEach((docSnapshot) => {
                entries.push({
                    centaurId: docSnapshot.id,
                    ranking: docSnapshot.data() as Ranking,
                })
            })
            setLeaderboard(entries)
            setLoadingLeaderboard(false)
        },
    })

    return (
        <LadderContext.Provider value={{
            selectedRanking,
            leaderboard,
            loadingSelected,
            loadingLeaderboard,
        }}>
            {children}
        </LadderContext.Provider>
    )
}
