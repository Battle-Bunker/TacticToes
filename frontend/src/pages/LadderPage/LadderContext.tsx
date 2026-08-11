// src/pages/LadderPage/LadderContext.tsx

import React, { createContext, useContext, useEffect, useState } from 'react'
import { collection, doc, onSnapshot, orderBy, query } from 'firebase/firestore'
import { db } from '../../firebaseConfig'
import { Ranking } from '@shared/types/Game'
import { LeaderboardEntry } from './types'

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

    // Subscribe to the selected centaur's ranking doc
    useEffect(() => {
        if (!centaurId) {
            setSelectedRanking(null)
            setLoadingSelected(false)
            return
        }
        setLoadingSelected(true)
        const rankingRef = doc(db, 'rankings', centaurId)
        const unsubscribe = onSnapshot(rankingRef, (snapshot) => {
            setSelectedRanking(
                snapshot.exists() ? (snapshot.data() as Ranking) : null
            )
            setLoadingSelected(false)
        })

        return () => unsubscribe()
    }, [centaurId])

    // Subscribe to the leaderboard: all rankings ordered by MMR
    useEffect(() => {
        setLoadingLeaderboard(true)
        const rankingsQuery = query(
            collection(db, 'rankings'),
            orderBy('currentMMR', 'desc')
        )
        const unsubscribe = onSnapshot(rankingsQuery, (snapshot) => {
            const entries: LeaderboardEntry[] = []
            snapshot.forEach((docSnapshot) => {
                entries.push({
                    centaurId: docSnapshot.id,
                    ranking: docSnapshot.data() as Ranking,
                })
            })
            setLeaderboard(entries)
            setLoadingLeaderboard(false)
        })

        return () => unsubscribe()
    }, [])

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
