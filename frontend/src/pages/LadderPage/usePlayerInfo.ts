// src/pages/LadderPage/usePlayerInfo.ts

import { useState, useEffect, useRef } from 'react'
import { doc, onSnapshot } from 'firebase/firestore'
import { db } from '../../firebaseConfig'
import { Centaur } from '@shared/types/Game'
import { baseCentaurId } from './utils'

// Resolves centaur docs for a set of ids. Snake-id suffixes (`#k`) are
// stripped, and the returned map is keyed by centaur id.
//
// One document listener per id rather than batched
// where('__name__', 'in', ...) queries: under the Firestore rules, queries
// are `list` operations (auth-only, to block anonymous enumeration of
// /centaurs), while document reads are `get`s, which stay open so
// signed-out /ladder visitors can resolve names by id.
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
        // Loading resolves once every id has reported at least once
        // (deleted centaurs report as non-existent docs).
        let pendingInitial = uniqueIDs.length

        const unsubscribers = uniqueIDs.map((id) =>
            onSnapshot(doc(db, 'centaurs', id), (snapshot) => {
                if (snapshot.exists()) {
                    const newCentaurs = {
                        ...previousCentaurs.current,
                        [snapshot.id]: {
                            ...(snapshot.data() as Centaur),
                            id: snapshot.id,
                        },
                    }
                    setCentaurs(newCentaurs)
                    previousCentaurs.current = newCentaurs
                }
                pendingInitial -= 1
                if (pendingInitial <= 0) {
                    setLoadingCentaurs(false)
                }
            })
        )

        return () => {
            unsubscribers.forEach(unsubscribe => unsubscribe())
        }
    }, [idsKey]) // Only reset subscriptions when IDs actually change

    return { centaurs, loadingCentaurs }
}
