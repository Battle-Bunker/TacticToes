import * as functions from "firebase-functions"
import * as logger from "firebase-functions/logger"
import axios from "axios"

export const wakeBot = functions.https.onCall(async (data, context) => {
  const { botUrl } = data

  // Validate input
  if (!botUrl || typeof botUrl !== "string") {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "botUrl is required and must be a string"
    )
  }

  // Validate URL format
  if (!botUrl.startsWith("http")) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "botUrl must be a valid HTTP/HTTPS URL"
    )
  }

  try {
    logger.info(`Attempting to wake bot at: ${botUrl}`)

    // Make a request to wake up the bot
    const response = await axios.get(botUrl, {
      timeout: 30000, // 30 second timeout
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

      // Return success for 503 (Service Unavailable) as it means the bot is starting up
      if (status === 503) {
        return {
          success: true,
          status: 503,
          statusText: "Service Unavailable",
          message: "Bot is starting up (503 Service Unavailable)",
        }
      }

      // Return success for 502 (Bad Gateway) as it might mean the bot is waking up
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

    // Handle other types of errors
    return {
      success: false,
      status: 0,
      statusText: "Unknown Error",
      message: `Bot wake failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
})
