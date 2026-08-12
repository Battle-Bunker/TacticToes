import { Box, CircularProgress, Stack } from "@mui/material"
import { Session } from "@shared/types/Game"
import {
  doc,
  onSnapshot,
  runTransaction,
  serverTimestamp,
} from "firebase/firestore"
import React, { useEffect, useState, useRef } from "react"
import { useNavigate, useParams, useLocation } from "react-router-dom"
import { db } from "../firebaseConfig"
import { useUser } from "../context/UserContext"

const Sessionpage: React.FC = () => {
  const { sessionName } = useParams<{ sessionName: string }>()
  const [session, setSession] = useState<Session | null>(null)
  const navigate = useNavigate()
  const location = useLocation()
  const hasNavigated = useRef(false)
  const { userID } = useUser()

  useEffect(() => {
    // The unsubscribe is assigned from inside the async body below; the
    // effect's cleanup (returned synchronously) is what React actually calls.
    // Previously the unsubscribe was returned from the async function itself,
    // so cleanup never ran and the listener leaked.
    let unsubscribe: (() => void) | null = null
    let cancelled = false

    const createAndSubscribeToSession = async () => {
      if (!sessionName) {
        return
      }

      const sessionDocRef = doc(db, "sessions", sessionName)

      try {
        await runTransaction(db, async (transaction) => {
          const sessionSnapshot = await transaction.get(sessionDocRef)

          if (!sessionSnapshot.exists()) {
            const newSession: Session = {
              latestGameID: null,
              timeCreated: serverTimestamp(),
              owner: userID,
            }

            transaction.set(sessionDocRef, newSession)
          } else {
            console.log("Session already exists.")
          }
        })
      } catch (error) {
        console.log("Error creating session or transaction failed: ", error)
      }

      unsubscribe = onSnapshot(sessionDocRef, (docSnapshot) => {
        if (!docSnapshot.exists()) return

        const sessionData = docSnapshot.data() as Session
        setSession(sessionData)
      })

      // If the effect was cleaned up while the transaction above was still
      // in flight, drop the just-created listener immediately.
      if (cancelled) {
        unsubscribe()
        unsubscribe = null
      }
    }

    createAndSubscribeToSession()

    return () => {
      cancelled = true
      if (unsubscribe) {
        unsubscribe()
        unsubscribe = null
      }
    }
  }, [sessionName, userID])

  // Modified navigation effect
  useEffect(() => {
    if (session?.latestGameID && !hasNavigated.current) {
      hasNavigated.current = true
      // Replace the current history entry instead of pushing a new one
      navigate(`/session/${sessionName}/${session.latestGameID}`, {
        replace: true,
        state: { from: location.pathname }
      })
    }
  }, [session, sessionName, navigate, location])

  return (
    <Stack
      spacing={2}
      direction="column"
      alignItems="center"
      justifyContent="center"
      sx={{ height: "100vh" }}
    >
      <Box
        sx={{
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          height: "100vh",
        }}
      >
        <CircularProgress />
      </Box>
    </Stack>
  )
}

export default Sessionpage