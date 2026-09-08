import { Typography } from "@mui/material"
import {
  Centaur,
  GameSetup,
  GameState,
  MoveStatus,
  Session,
  Turn,
} from "@shared/types/Game"
import {
  collection,
  doc,
  DocumentData,
  DocumentReference,
  limit,
  or,
  orderBy,
  query,
  Query,
  Timestamp,
  where,
} from "firebase/firestore"
import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react"
import { CenteredLoader } from "../components/CenteredLoader"
import { db } from "../firebaseConfig"
import {
  FirestoreSubscriptionOptions,
  useFirestoreSubscription,
} from "../hooks/useFirestoreSubscription"
import { useUser } from "./UserContext"

interface GameStateContextType {
  gameState: GameState | null
  latestTurn: Turn | null
  error: string | null
  gameID: string
  timeRemaining: number
  centaurs: Centaur[]
  sessionName: string
  gameSetup: GameSetup | null
  latestMoveStatus: MoveStatus | null
  session: Session | null
  isOwner: boolean
  connectivityStatus: 'connected' | 'disconnected'
  queryTimedOut: boolean
}

const GameStateContext = createContext<GameStateContextType | undefined>(
  undefined,
)

export const GameStateProvider: React.FC<{
  children: React.ReactNode
  gameID: string
  sessionName: string
}> = ({ children, gameID, sessionName }) => {
  const { userID } = useUser()
  const [gameState, setGameState] = useState<GameState | null>(null)
  const [gameSetup, setGameSetup] = useState<GameSetup | null>(null)
  const [session, setSession] = useState<Session | null>(null)
  const [latestMoveStatus, setLatestMoveStatus] = useState<MoveStatus | null>(
    null,
  )
  const [latestTurn, setLatestTurn] = useState<Turn | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [timeRemaining, setTimeRemaining] = useState<number>(0)
  const [centaurs, setCentaurs] = useState<Centaur[]>([])
  const [connectivityStatus, setConnectivityStatus] = useState<'connected' | 'disconnected'>('connected')
  const [queryTimedOut, setQueryTimedOut] = useState<boolean>(false)

  const intervalIdRef = useRef<NodeJS.Timeout | null>(null)
  const initialGameIDRef = useRef(gameID)

  // Every subscription below asks for the same three things: its errors and its
  // query timeouts reported into this provider's state, and a timeout/error
  // message pair that is nothing but the subscription's SUBJECT wrapped in
  // fixed text. So the subject is stated once, as the label, and both messages
  // come off it — five labels rather than five labels and ten sentences that
  // can quietly stop agreeing with them.
  //
  // A hook, not a plain helper: it calls useFirestoreSubscription, so the five
  // calls below are five hook calls in a fixed order, exactly as before.
  const useSubscription = <
    T extends DocumentReference<DocumentData> | Query<DocumentData>,
  >(
    label: string,
    options: Omit<
      FirestoreSubscriptionOptions<T>,
      "logLabel" | "timeoutMessage" | "errorMessage" | "onError" | "onQueryTimeoutChange"
    >,
  ): void =>
    useFirestoreSubscription<T>({
      ...options,
      logLabel: label,
      timeoutMessage: `Loading ${label} is taking longer than usual.`,
      errorMessage: `An error occurred while fetching ${label}.`,
      onError: setError,
      onQueryTimeoutChange: setQueryTimedOut,
    })

  // Subscribe to game document. This is the one subscription that drives the
  // connectivity banner: it is the realtime feed the player is actually
  // playing off, so its cache/server state is what "connected" means here.
  // (Previously all five subscriptions raced last-writer-wins over the same
  // connectivity flag.)
  useSubscription("game data", {
    buildTarget: () => doc(db, `sessions/${sessionName}/games`, gameID),
    deps: [gameID, sessionName],
    onConnectivityChange: (connected) =>
      setConnectivityStatus(connected ? 'connected' : 'disconnected'),
    onSnapshot: (docSnapshot) => {
      if (!docSnapshot.exists()) {
        // The game document only exists once the game has started.
        return
      }

      const gameData = docSnapshot.data() as GameState
      const safeTurns = Array.isArray(gameData.turns) ? gameData.turns : []
      const latestTurnData = safeTurns.length ? safeTurns[safeTurns.length - 1] : null

      setGameState({ ...gameData, turns: safeTurns })
      setLatestTurn(latestTurnData)
    },
  })

  // Subscribe to session document
  useSubscription("session data", {
    buildTarget: () => doc(db, `sessions/${sessionName}`),
    deps: [sessionName],
    onSnapshot: (docSnapshot) => {
      if (!docSnapshot.exists()) {
        setError("Session not found.")
        return "keep-waiting"
      }

      setSession(docSnapshot.data() as Session)
    },
  })

  // Subscribe to game setup
  useSubscription("game setup", {
    buildTarget: () =>
      gameID ? doc(db, `sessions/${sessionName}/setups`, gameID) : null,
    deps: [gameID, sessionName],
    onSnapshot: (docSnapshot) => {
      if (!docSnapshot.exists()) {
        setError("Game setup not found.")
        return "keep-waiting"
      }

      setGameSetup(docSnapshot.data() as GameSetup)
    },
  })

  // Subscribe to the "centaurs" collection: everything public plus the
  // current user's own private centaurs.
  useSubscription("centaurs data", {
    buildTarget: () =>
      userID === ""
        ? null
        : query(
            collection(db, "centaurs"),
            or(
              where("public", "==", true),
              where("owner", "==", userID)
            )
          ),
    deps: [userID],
    onSnapshot: (snapshot) => {
      setCentaurs(snapshot.docs.map((doc) => doc.data() as Centaur))
    },
  })

  // Subscribe to moveStatuses collection
  useSubscription("move status data", {
    buildTarget: () =>
      gameID
        ? query(
            collection(db, "sessions", sessionName, "games", gameID, "moveStatuses"),
            orderBy("moveNumber", "desc"),
            limit(1),
          )
        : null,
    deps: [gameID, sessionName],
    onSnapshot: (querySnapshot) => {
      if (!querySnapshot.empty) {
        setLatestMoveStatus(querySnapshot.docs[0].data() as MoveStatus)
      }
    },
  })

  // Timer effect
  useEffect(() => {
    const shouldClearInterval = () => {
      if (
        !latestTurn ||
        !gameSetup?.maxTurnTime ||
        !gameID ||
        latestTurn.winners.length > 0 ||
        gameID !== initialGameIDRef.current
      ) {
        if (intervalIdRef.current) {
          clearInterval(intervalIdRef.current)
          intervalIdRef.current = null
        }
        return true
      }
      return false
    }

    if (shouldClearInterval()) {
      return
    }

    const intervalFunction = () => {
      if (shouldClearInterval()) {
        return
      }

      const now = Date.now() / 1000
      const endTimeSeconds =
        latestTurn?.endTime instanceof Timestamp
          ? latestTurn.endTime.seconds
          : 0
      setTimeRemaining(endTimeSeconds - now)
    }

    if (intervalIdRef.current) {
      clearInterval(intervalIdRef.current)
    }

    intervalIdRef.current = setInterval(intervalFunction, 1000)

    return () => {
      if (intervalIdRef.current) {
        clearInterval(intervalIdRef.current)
        intervalIdRef.current = null
      }
    }
  }, [latestTurn, gameID, gameSetup])

  const providerValue: GameStateContextType = {
    gameState,
    latestTurn,
    error,
    gameID,
    timeRemaining,
    centaurs,
    sessionName,
    gameSetup,
    latestMoveStatus,
    session,
    isOwner: userID !== "" && session?.owner != null && userID === session.owner,
    connectivityStatus,
    queryTimedOut,
  }

  return (
    <GameStateContext.Provider value={providerValue}>
      {gameSetup ? (
        children
      ) : error ? (
        <CenteredLoader>
          <Typography color="error">{error}</Typography>
        </CenteredLoader>
      ) : (
        <CenteredLoader />
      )}
    </GameStateContext.Provider>
  )
}

export const useGameStateContext = (): GameStateContextType => {
  const context = useContext(GameStateContext)
  if (!context) {
    throw new Error(
      "useGameStateContext must be used within a GameStateProvider"
    )
  }
  return context
}
