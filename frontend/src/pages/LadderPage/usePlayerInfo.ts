// src/pages/LadderPage/usePlayerInfo.ts

import { useState, useEffect, useRef } from 'react'
import { collection, query, where, onSnapshot } from 'firebase/firestore'
import { db } from '../../firebaseConfig'
import { Centaur } from '@shared/types/Game'
import { baseCentaurId } from './utils'

// Resolves centaur docs for a set of ids. Snake-id suffixes (`#k`) are
// stripped, and the returned map is keyed by centaur id.
export const usePlayerInfo = (centaurIDs: string[]) => {
    const [centaurs, setCentaurs] = useState<{ [id: string]: Centaur }>({})
    const [loadingCentaurs, setLoadingCentaurs] = useState(true)
    const previousCentaurs = useRef(centaurs)

    const uniqueIDs = Array.from(
        new Set(centaurIDs.map(baseCentaurId))
    ).sort()
    const idsKey = uniqueIDs.join(',')

    useEffect(() => {
        if (uniqueIDs.length === 0) {
            setLoadingCentaurs(false)
            return
        }

        setLoadingCentaurs(true)
        const unsubscribers: (() => void)[] = []

        // Batch IDs in groups of 10 (Firestore `in` limit)
        const batchSize = 10
        for (let i = 0; i < uniqueIDs.length; i += batchSize) {
            const batchIDs = uniqueIDs.slice(i, i + batchSize)
            const centaursQuery = query(
                collection(db, 'centaurs'),
                where('__name__', 'in', batchIDs)
            )
            const unsubscribe = onSnapshot(centaursQuery, (snapshot) => {
                const newCentaurs = { ...previousCentaurs.current }
                snapshot.forEach((doc) => {
                    newCentaurs[doc.id] = { ...(doc.data() as Centaur), id: doc.id }
                })
                setCentaurs(newCentaurs)
                previousCentaurs.current = newCentaurs
                setLoadingCentaurs(false)
            })
            unsubscribers.push(unsubscribe)
        }

        return () => {
            unsubscribers.forEach(unsubscribe => unsubscribe())
        }
    }, [idsKey]) // Only reset subscriptions when IDs actually change

    return { centaurs, loadingCentaurs }
}
