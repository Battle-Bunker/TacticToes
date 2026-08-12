// src/pages/LadderPage/utils.ts

import { Centaur } from '@shared/types/Game'

export const ordinalSuffix = (n: number): string => {
    const s = ['th', 'st', 'nd', 'rd']
    const v = n % 100
    return n + (s[(v - 20) % 10] || s[v] || s[0])
}

export const calculateWinRate = (wins: number, total: number): number => {
    if (total === 0) return 0
    return (wins / total) * 100
}

// Ranking history opponents are centaur ids, but tolerate snake ids
// (`centaurId#k`) by stripping the suffix before lookup.
export const baseCentaurId = (id: string): string => id.split('#')[0]

export const formatCentaurName = (
    centaur: Centaur | undefined,
    fallbackID: string
): string => centaur?.name || fallbackID
