import React, { createContext, useContext, useEffect, useState } from "react"
import { doc, onSnapshot } from "firebase/firestore"
import { onAuthStateChanged, User } from "firebase/auth"
import { Box, CircularProgress } from "@mui/material"
import { UserProfile } from "@shared/types/Game"
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
  const [name, setName] = useState<string>("")
  const [profileLoaded, setProfileLoaded] = useState<boolean>(false)

  useEffect(
    () =>
      onAuthStateChanged(auth, (currentUser) => {
        setUser(currentUser)
        setAuthLoaded(true)
      }),
    [],
  )

  useEffect(() => {
    if (!user) {
      setName("")
      setProfileLoaded(false)
      return
    }

    setProfileLoaded(false)
    return onSnapshot(
      doc(db, "users", user.uid),
      (snapshot) => {
        const profile = snapshot.data() as UserProfile | undefined
        setName(profile?.name ?? "")
        setProfileLoaded(true)
      },
      (error) => {
        console.error("Error loading user profile:", error)
        setProfileLoaded(true)
      },
    )
  }, [user])

  if (!authLoaded || (user && !profileLoaded)) {
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

  if (!user || !name) {
    return <SignupPage key={user?.uid ?? "signed-out"} user={user} />
  }

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
