import * as functions from "firebase-functions/v1"
import * as logger from "firebase-functions/logger"
import axios from "axios"
import WebSocket from "ws"

/**
 * Wakes / health-checks a user-configured bot. The bot may be:
 *   - HTTP / HTTPS:  GET against the URL.
 *   - WebSocket (ws/wss): open a connection and immediately close it.
 *
 * The botUrl is treated as the source of truth for which transport to use,
 * so this works whether the caller is the Bots page (where a user is editing
 * a single bot) or anywhere else that wants a quick "is it up?" check.
 */
export const wakeBot = functions.https.onCall(async (data, _context) => {
  const { botUrl } = data as { botUrl?: unknown }

  if (!botUrl || typeof botUrl !== "string") {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "botUrl is required and must be a string"
    )
  }

  const isWs = botUrl.startsWith("ws://") || botUrl.startsWith("wss://")
  const isHttp = botUrl.startsWith("http://") || botUrl.startsWith("https://")

  if (!isHttp && !isWs) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "botUrl must be a valid http(s):// or ws(s):// URL"
    )
  }

  if (isWs) {
    return await wakeWebsocketBot(botUrl)
  }
  return await wakeHttpBot(botUrl)
})

async function wakeHttpBot(botUrl: string) {
  try {
    logger.info(`Attempting to wake HTTP bot at: ${botUrl}`)

    const response = await axios.get(botUrl, {
      timeout: 30000,
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    })

    logger.info(`Bot wake response: ${response.status} ${response.statusText}`)

    return {
      success: true,
      status: response.status,
      statusText: response.statusText,
      message: `Bot successfully woken up (${response.status})`,
    }
  } catch (error) {
    logger.error(`Failed to wake bot at ${botUrl}:`, error)

    if (axios.isAxiosError(error)) {
      const status = error.response?.status
      const statusText = error.response?.statusText || error.message

      if (status === 503) {
        return {
          success: true,
          status: 503,
          statusText: "Service Unavailable",
          message: "Bot is starting up (503 Service Unavailable)",
        }
      }

      if (status === 502) {
        return {
          success: true,
          status: 502,
          statusText: "Bad Gateway",
          message: "Bot is waking up (502 Bad Gateway)",
        }
      }

      return {
        success: false,
        status: status || 0,
        statusText: statusText,
        message: `Bot wake failed: ${statusText}`,
      }
    }

    return {
      success: false,
      status: 0,
      statusText: "Unknown Error",
      message: `Bot wake failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

async function wakeWebsocketBot(botUrl: string) {
  logger.info(`Attempting to wake WebSocket bot at: ${botUrl}`)

  return await new Promise<{
    success: boolean
    status: number
    statusText: string
    message: string
  }>((resolve) => {
    let settled = false
    const settle = (
      result: { success: boolean; status: number; statusText: string; message: string }
    ) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    let ws: WebSocket
    try {
      ws = new WebSocket(botUrl, { handshakeTimeout: 30000 })
    } catch (err) {
      settle({
        success: false,
        status: 0,
        statusText: "Connection error",
        message: `Failed to construct ws connection: ${err instanceof Error ? err.message : String(err)}`,
      })
      return
    }

    const overall = setTimeout(() => {
      try {
        ws.close()
      } catch {
        /* ignore */
      }
      settle({
        success: false,
        status: 0,
        statusText: "Timeout",
        message: "WebSocket bot did not respond to handshake within 30s",
      })
    }, 30000)

    ws.on("open", () => {
      logger.info(`WebSocket bot ${botUrl} accepted connection`)
      clearTimeout(overall)
      try {
        ws.close(1000, "wake check")
      } catch {
        /* ignore */
      }
      settle({
        success: true,
        status: 200,
        statusText: "OK",
        message: "WebSocket bot accepted connection",
      })
    })

    ws.on("error", (err: Error) => {
      logger.error(`WebSocket bot wake error for ${botUrl}:`, err.message)
      clearTimeout(overall)
      settle({
        success: false,
        status: 0,
        statusText: "Connection error",
        message: `WebSocket wake failed: ${err.message}`,
      })
    })
  })
}
