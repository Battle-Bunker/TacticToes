import React, { createContext, useContext, useEffect, useState } from "react"
import { doc, setDoc } from "firebase/firestore"
import { onAuthStateChanged, User } from "firebase/auth"
import { Box, CircularProgress } from "@mui/material"
import { auth, db } from "../firebaseConfig"
import SignupPage from "../pages/SignupPage"

export interface UserContextType {
  userID: string
  name: string
}

const UserContext = createContext<UserContextType | undefined>(undefined)

export const UserProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [user, setUser] = useState<User | null>(null)
  const [authLoaded, setAuthLoaded] = useState<boolean>(false)

  useEffect(
    () =>
      onAuthStateChanged(auth, (currentUser) => {
        setUser(currentUser)
        setAuthLoaded(true)

        // Persist the Google display name to Firestore so other consumers can read it.
        if (currentUser?.displayName) {
          setDoc(
            doc(db, "users", currentUser.uid),
            { name: currentUser.displayName },
            { merge: true },
          ).catch((err) => console.error("Error syncing display name:", err))
        }
      }),
    [],
  )

  if (!authLoaded) {
    return (
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
    )
  }

  if (!user) {
    return <SignupPage />
  }

  const name = user.displayName ?? ""

  return (
    <UserContext.Provider value={{ userID: user.uid, name }}>
      {children}
    </UserContext.Provider>
  )
}

export const useUser = (): UserContextType => {
  const context = useContext(UserContext)
  if (!context) {
    throw new Error("useUser must be used within a UserProvider")
  }
  return context
}
