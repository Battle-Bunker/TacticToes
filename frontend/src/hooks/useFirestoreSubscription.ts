// src/hooks/useFirestoreSubscription.ts

import {
  DocumentData,
  DocumentReference,
  DocumentSnapshot,
  onSnapshot,
  Query,
  QuerySnapshot,
} from "firebase/firestore"
import { DependencyList, useEffect } from "react"

/** How long a subscription may wait for its first server response. */
export const queryMaxDuration = 2000

type SubscriptionTarget = DocumentReference<DocumentData> | Query<DocumentData>

type SnapshotFor<T extends SubscriptionTarget> =
  T extends DocumentReference<DocumentData>
    ? DocumentSnapshot<DocumentData>
    : QuerySnapshot<DocumentData>

export interface FirestoreSubscriptionOptions<T extends SubscriptionTarget> {
  /**
   * Builds the doc ref or query to subscribe to. Return null to skip
   * subscribing (e.g. a required key isn't available yet). Re-invoked when
   * `deps` change.
   */
  buildTarget: () => T | null
  /** Effect dependencies: the subscription is torn down and rebuilt on change. */
  deps: DependencyList
  /**
   * Snapshot handler. Return "keep-waiting" when the snapshot should NOT
   * count as a successful load (e.g. a required document does not exist), so
   * a pending query timeout keeps running.
   */
  onSnapshot: (snapshot: SnapshotFor<T>) => "keep-waiting" | void
  /** Names the subscription in the console: `Error in <logLabel> subscription:`. */
  logLabel: string
  /**
   * Reports whether the latest snapshot came from the server (true) or the
   * local cache (false). Only wire this up on the subscription whose
   * connectivity should drive the UI.
   */
  onConnectivityChange?: (connected: boolean) => void
  /**
   * Called with true when no server response has arrived within
   * queryMaxDuration, and with false once one does.
   */
  onQueryTimeoutChange?: (timedOut: boolean) => void
  /** Receives timeoutMessage / errorMessage when those situations occur. */
  onError?: (message: string) => void
  /** Message passed to onError when the query times out. */
  timeoutMessage?: string
  /** Message passed to onError when the subscription errors. */
  errorMessage?: string
  /**
   * Whether metadata-only changes (cache/server transitions) fire the
   * handler. Defaults to true — required for the timeout/connectivity
   * tracking to see server confirmations of unchanged data. Pass false for
   * plain data subscriptions to keep their original event cadence.
   */
  includeMetadataChanges?: boolean
}

/**
 * Shared shape of every Firestore subscription in the app: build the target,
 * subscribe with metadata changes, watch for a slow first load, report
 * connectivity, log + surface errors, and always unsubscribe on cleanup.
 */
export function useFirestoreSubscription<T extends SubscriptionTarget>({
  buildTarget,
  deps,
  onSnapshot: handleSnapshot,
  logLabel,
  onConnectivityChange,
  onQueryTimeoutChange,
  onError,
  timeoutMessage,
  errorMessage,
  includeMetadataChanges = true,
}: FirestoreSubscriptionOptions<T>): void {
  useEffect(() => {
    const target = buildTarget()
    if (!target) return

    let timeoutId: ReturnType<typeof setTimeout> | null = null

    const clearQueryTimeout = () => {
      if (timeoutId) {
        clearTimeout(timeoutId)
        timeoutId = null
      }
    }

    timeoutId = setTimeout(() => {
      onQueryTimeoutChange?.(true)
      if (timeoutMessage) {
        onError?.(timeoutMessage)
      }
    }, queryMaxDuration)

    // onSnapshot dispatches on the runtime type of the target, so a single
    // compile-time cast covers both the doc and the query overloads.
    const unsubscribe = onSnapshot(
      target as Query<DocumentData>,
      { includeMetadataChanges },
      (snapshot) => {
        onConnectivityChange?.(!snapshot.metadata.fromCache)

        const disposition = handleSnapshot(snapshot as SnapshotFor<T>)

        if (disposition !== "keep-waiting" && !snapshot.metadata.fromCache) {
          clearQueryTimeout()
          onQueryTimeoutChange?.(false)
        }
      },
      (error) => {
        console.error(`Error in ${logLabel} subscription:`, error)
        if (errorMessage) {
          onError?.(errorMessage)
        }
        clearQueryTimeout()
      }
    )

    return () => {
      unsubscribe()
      clearQueryTimeout()
    }
    // The dependency list is supplied by the caller, mirroring the effect
    // each call site previously wrote by hand.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}
