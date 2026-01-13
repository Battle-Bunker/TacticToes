import * as functions from "firebase-functions/v1"
import * as admin from "firebase-admin"

type PublicPlayerInfo = {
  playerID: string
  name: string
  emoji: string
  type: "human" | "bot"
}

const setCorsHeaders = (res: functions.Response) => {
  res.set("Access-Control-Allow-Origin", "*")
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization")
}

const extractPlayerID = (req: functions.Request): string | null => {
  const queryId = req.query.playerID || req.query.id
  if (typeof queryId === "string" && queryId.trim() !== "") {
    return queryId.trim()
  }
  const bodyId = (req.body as { playerID?: unknown } | undefined)?.playerID
  if (typeof bodyId === "string" && bodyId.trim() !== "") {
    return bodyId.trim()
  }
  return null
}

export const getPlayerPublicInfo = functions.https.onRequest(
  async (req, res) => {
    setCorsHeaders(res)

    if (req.method === "OPTIONS") {
      res.status(204).send("")
      return
    }

    if (req.method !== "GET" && req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" })
      return
    }

    const playerID = extractPlayerID(req)
    if (!playerID) {
      res.status(400).json({ error: "playerID is required" })
      return
    }

    const firestore = admin.firestore()

    const [userSnap, botSnap] = await Promise.all([
      firestore.collection("users").doc(playerID).get(),
      firestore.collection("bots").doc(playerID).get(),
    ])

    if (userSnap.exists) {
      const data = userSnap.data() as { name?: string; emoji?: string } | undefined
      const response: PublicPlayerInfo = {
        playerID,
        name: data?.name || "Unknown",
        emoji: data?.emoji || "",
        type: "human",
      }
      res.status(200).json(response)
      return
    }

    if (botSnap.exists) {
      const data = botSnap.data() as { name?: string; emoji?: string } | undefined
      const response: PublicPlayerInfo = {
        playerID,
        name: data?.name || "Unknown",
        emoji: data?.emoji || "",
        type: "bot",
      }
      res.status(200).json(response)
      return
    }

    res.status(404).json({ error: "Player not found" })
  }
)
