import { Box, CircularProgress, Typography } from "@mui/material"
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
  DocumentSnapshot,
  limit,
  onSnapshot,
  or,
  orderBy,
  query,
  QuerySnapshot,
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
import { db } from "../firebaseConfig"
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

const queryMaxDuration = 2000

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

  // Helper function to update connectivity status based on snapshot metadata
  const updateConnectivityStatus = (snapshot: DocumentSnapshot | QuerySnapshot) => {
    const isConnected = !snapshot.metadata.fromCache
    setConnectivityStatus(isConnected ? 'connected' : 'disconnected')
  }

  // Subscribe to game document
  useEffect(() => {
    const gameDocRef = doc(db, `sessions/${sessionName}/games`, gameID)
    let timeoutId: NodeJS.Timeout | null = null

    const startQueryTimeout = () => {
      timeoutId = setTimeout(() => {
        setQueryTimedOut(true)
        setError("Loading game data is taking longer than usual.")
      }, queryMaxDuration)
    }

    const clearQueryTimeout = () => {
      if (timeoutId) {
        clearTimeout(timeoutId)
        timeoutId = null
      }
    }

    startQueryTimeout()

    const unsubscribe = onSnapshot(
      gameDocRef,
      { includeMetadataChanges: true },
      (docSnapshot) => {
        updateConnectivityStatus(docSnapshot)

        if (!docSnapshot.exists()) {
          // The game document only exists once the game has started.
          if (!docSnapshot.metadata.fromCache) {
            clearQueryTimeout()
            setQueryTimedOut(false)
          }
          return
        }

        const gameData = docSnapshot.data() as GameState
        const safeTurns = Array.isArray(gameData.turns) ? gameData.turns : []
        const latestTurnData = safeTurns.length ? safeTurns[safeTurns.length - 1] : null

        setGameState({ ...gameData, turns: safeTurns })
        setLatestTurn(latestTurnData)

        if (!docSnapshot.metadata.fromCache) {
          clearQueryTimeout()
          setQueryTimedOut(false)
        }
      },
      (error) => {
        console.error("Error in game subscription:", error)
        setError("An error occurred while fetching game updates.")
        clearQueryTimeout()
      }
    )
    return () => {
      unsubscribe()
      clearQueryTimeout()
    }
  }, [gameID, sessionName])

  // Subscribe to session document
  useEffect(() => {
    const sessionDocRef = doc(db, `sessions/${sessionName}`)
    let timeoutId: NodeJS.Timeout | null = null

    const startQueryTimeout = () => {
      timeoutId = setTimeout(() => {
        setQueryTimedOut(true)
        setError("Loading session data is taking longer than usual.")
      }, queryMaxDuration)
    }

    const clearQueryTimeout = () => {
      if (timeoutId) {
        clearTimeout(timeoutId)
        timeoutId = null
      }
    }

    startQueryTimeout()

    const unsubscribe = onSnapshot(
      sessionDocRef,
      { includeMetadataChanges: true },
      (docSnapshot) => {
        updateConnectivityStatus(docSnapshot)

        if (!docSnapshot.exists()) {
          setError("Session not found.")
          return
        }

        const sessionData = docSnapshot.data() as Session
        setSession(sessionData)

        if (!docSnapshot.metadata.fromCache) {
          clearQueryTimeout()
          setQueryTimedOut(false)
        }
      },
      (error) => {
        console.error("Error in session subscription:", error)
        setError("An error occurred while fetching session updates.")
        clearQueryTimeout()
      }
    )
    return () => {
      unsubscribe()
      clearQueryTimeout()
    }
  }, [sessionName])

  // Subscribe to game setup
  useEffect(() => {
    if (!gameID) return
    const gameDocRef = doc(db, `sessions/${sessionName}/setups`, gameID)
    let timeoutId: NodeJS.Timeout | null = null

    const startQueryTimeout = () => {
      timeoutId = setTimeout(() => {
        setQueryTimedOut(true)
        setError("Loading game setup is taking longer than usual.")
      }, queryMaxDuration)
    }

    const clearQueryTimeout = () => {
      if (timeoutId) {
        clearTimeout(timeoutId)
        timeoutId = null
      }
    }

    startQueryTimeout()

    const unsubscribe = onSnapshot(
      gameDocRef,
      { includeMetadataChanges: true },
      (docSnapshot) => {
        updateConnectivityStatus(docSnapshot)

        if (!docSnapshot.exists()) {
          setError("Game setup not found.")
          return
        }

        const gameData = docSnapshot.data() as GameSetup
        setGameSetup(gameData)

        if (!docSnapshot.metadata.fromCache) {
          clearQueryTimeout()
          setQueryTimedOut(false)
        }
      },
      (error) => {
        console.error("Error in game setup subscription:", error)
        setError("An error occurred while fetching game setup.")
        clearQueryTimeout()
      }
    )
    return () => {
      unsubscribe()
      clearQueryTimeout()
    }
  }, [gameID, sessionName])

  // Subscribe to the "centaurs" collection: everything public plus the
  // current user's own private centaurs.
  useEffect(() => {
    if (userID === "") return
    const centaursQuery = query(
      collection(db, "centaurs"),
      or(
        where("public", "==", true),
        where("owner", "==", userID)
      )
    )
    let timeoutId: NodeJS.Timeout | null = null

    const startQueryTimeout = () => {
      timeoutId = setTimeout(() => {
        setQueryTimedOut(true)
        setError("Loading centaurs data is taking longer than usual.")
      }, queryMaxDuration)
    }

    const clearQueryTimeout = () => {
      if (timeoutId) {
        clearTimeout(timeoutId)
        timeoutId = null
      }
    }

    startQueryTimeout()

    const unsubscribe = onSnapshot(
      centaursQuery,
      { includeMetadataChanges: true },
      (snapshot) => {
        updateConnectivityStatus(snapshot)

        const centaursData = snapshot.docs.map((doc) => doc.data() as Centaur)
        setCentaurs(centaursData)

        if (!snapshot.metadata.fromCache) {
          clearQueryTimeout()
          setQueryTimedOut(false)
        }
      },
      (error) => {
        console.error("Error in centaurs subscription:", error)
        setError("An error occurred while fetching centaurs data.")
        clearQueryTimeout()
      }
    )
    return () => {
      unsubscribe()
      clearQueryTimeout()
    }
  }, [userID])

  // Subscribe to moveStatuses collection
  useEffect(() => {
    if (!gameID) return

    const moveStatusesRef = collection(
      db,
      "sessions",
      sessionName,
      "games",
      gameID,
      "moveStatuses",
    )

    const moveStatusesQuery = query(
      moveStatusesRef,
      orderBy("moveNumber", "desc"),
      limit(1),
    )
    let timeoutId: NodeJS.Timeout | null = null

    const startQueryTimeout = () => {
      timeoutId = setTimeout(() => {
        setQueryTimedOut(true)
        setError("Loading move status data is taking longer than usual.")
      }, queryMaxDuration)
    }

    const clearQueryTimeout = () => {
      if (timeoutId) {
        clearTimeout(timeoutId)
        timeoutId = null
      }
    }

    startQueryTimeout()

    const unsubscribe = onSnapshot(
      moveStatusesQuery,
      { includeMetadataChanges: true },
      (querySnapshot) => {
        updateConnectivityStatus(querySnapshot)

        if (!querySnapshot.empty) {
          const highestMoveStatus = querySnapshot.docs[0].data() as MoveStatus
          setLatestMoveStatus(highestMoveStatus)
        }

        if (!querySnapshot.metadata.fromCache) {
          clearQueryTimeout()
          setQueryTimedOut(false)
        }
      },
      (error) => {
        console.error("Error in move status subscription:", error)
        setError("An error occurred while fetching move updates.")
        clearQueryTimeout()
      }
    )

    return () => {
      unsubscribe()
      clearQueryTimeout()
    }
  }, [gameID, sessionName])

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
      ) : (
        <Box
          sx={{
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            height: "100vh",
          }}
        >
          {error ? <Typography color="error">{error}</Typography> : <CircularProgress />}
        </Box>
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
