import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  ReactNode,
} from "react";
import { Bot } from "@shared/types/Game";
import { httpsCallable } from "firebase/functions";
import { functions } from "../firebaseConfig";

export type BotStatus = "unknown" | "loading" | "alive" | "dead" | "error";

interface BotHealthStatus {
  [botId: string]: BotStatus;
}

interface BotHealthContextType {
  botHealthStatus: BotHealthStatus;
  checkBotHealth: (bot: Bot) => Promise<void>;
  checkAllBotsHealth: (
    bots: Bot[],
    gamePlayers: Array<{ id: string; type: "bot" | "human" }>,
  ) => Promise<void>;
  wakeBot: (bot: Bot) => Promise<void>;
  isCheckingBots: boolean;
  getBotStatus: (botId: string) => BotStatus;
}

const BotHealthContext = createContext<BotHealthContextType | undefined>(
  undefined,
);

interface BotHealthProviderProps {
  children: ReactNode;
}

export const BotHealthProvider: React.FC<BotHealthProviderProps> = ({
  children,
}) => {
  const [botHealthStatus, setBotHealthStatus] = useState<BotHealthStatus>({});
  const [isCheckingBots, setIsCheckingBots] = useState(false);

  // Bot health check function using Firebase wakeBot function
  const checkBotHealth = useCallback(
    async (bot: Bot, retryCount = 0): Promise<void> => {
      const maxRetries = 3;
      const retryDelay = 2000; // 2 seconds between retries

      // Validate URL
      if (!bot.url || !bot.url.startsWith("http")) {
        console.error(`Invalid URL for bot ${bot.name}: ${bot.url}`);
        setBotHealthStatus((prev) => ({
          ...prev,
          [bot.id]: "error",
        }));
        return;
      }

      // Don't check if already checking or recently checked
      const currentStatus = botHealthStatus[bot.id];
      if (currentStatus === "loading" && retryCount === 0) {
        console.log(`Bot ${bot.name} is already being checked, skipping`);
        return;
      }

      // Set loading state immediately
      setBotHealthStatus((prev) => ({
        ...prev,
        [bot.id]: "loading",
      }));

      try {
        console.log(
          `Checking bot ${bot.name} health at: ${bot.url} (attempt ${retryCount + 1})`,
        );

        const wakeBotFunction = httpsCallable(functions, "wakeBot");

        const result = await wakeBotFunction({ botUrl: bot.url });
        const data = result.data as {
          success: boolean;
          status: number;
          statusText: string;
          message: string;
        };

        console.log(`Bot ${bot.name} health check result:`, data);

        // Handle 503 Service Unavailable (service starting up)
        if (data.status === 503) {
          if (retryCount < maxRetries) {
            console.log(
              `Bot ${bot.name} returned 503, retrying in ${retryDelay}ms... (attempt ${retryCount + 1}/${maxRetries})`,
            );
            setTimeout(() => {
              checkBotHealth(bot, retryCount + 1);
            }, retryDelay);
            return;
          } else {
            // Max retries reached for 503 - mark as dead
            console.log(`Bot ${bot.name} still returning 503 after ${maxRetries} retries - marking as DEAD`);
            setBotHealthStatus((prev) => ({
              ...prev,
              [bot.id]: "dead",
            }));
            return;
          }
        }

        // Check if bot is actually alive (200-299 status codes)
        if (data.success && data.status >= 200 && data.status < 300) {
          console.log(`Bot ${bot.name} marked as ALIVE`);
          setBotHealthStatus((prev) => ({
            ...prev,
            [bot.id]: "alive",
          }));
        } else if (data.status >= 500 && retryCount < maxRetries) {
          // Retry on server errors
          console.log(
            `Bot ${bot.name} server error ${data.status}, retrying in ${retryDelay}ms...`,
          );
          setTimeout(() => {
            checkBotHealth(bot, retryCount + 1);
          }, retryDelay);
          return;
        } else {
          console.log(`Bot ${bot.name} HTTP error: ${data.status}`);
          setBotHealthStatus((prev) => ({
            ...prev,
            [bot.id]: "dead",
          }));
        }
      } catch (error) {
        console.error(`Bot ${bot.name} health check failed:`, error);

        if (retryCount < maxRetries) {
          console.log(
            `Bot ${bot.name} network error, retrying in ${retryDelay}ms...`,
          );
          setTimeout(() => {
            checkBotHealth(bot, retryCount + 1);
          }, retryDelay);
          return;
        }

        setBotHealthStatus((prev) => ({
          ...prev,
          [bot.id]: "error",
        }));
      }
    },
    [botHealthStatus],
  );

  // Check all bots health
  const checkAllBotsHealth = useCallback(
    async (
      bots: Bot[],
      gamePlayers: Array<{ id: string; type: "bot" | "human" }>,
    ): Promise<void> => {
      const botsInGame = bots.filter((bot) =>
        gamePlayers.some((gp) => gp.id === bot.id && gp.type === "bot"),
      );

      if (botsInGame.length === 0) return;

      setIsCheckingBots(true);

      // Check each bot health
      const healthChecks = botsInGame.map((bot) => checkBotHealth(bot));

      await Promise.all(healthChecks);
      setIsCheckingBots(false);
    },
    [checkBotHealth],
  );

  // Wake bot function using Firebase function
  const wakeBot = useCallback(
    async (bot: Bot): Promise<void> => {
      // Validate URL
      if (!bot.url || !bot.url.startsWith("http")) {
        console.error(`Invalid URL for bot ${bot.name}: ${bot.url}`);
        setBotHealthStatus((prev) => ({
          ...prev,
          [bot.id]: "error",
        }));
        return;
      }

      // Set loading state
      setBotHealthStatus((prev) => ({
        ...prev,
        [bot.id]: "loading",
      }));

      try {
        console.log(`Waking bot ${bot.name} at: ${bot.url}`);

        const wakeBotFunction = httpsCallable(functions, "wakeBot");

        const result = await wakeBotFunction({ botUrl: bot.url });
        const data = result.data as {
          success: boolean;
          status: number;
          statusText: string;
          message: string;
        };

        console.log(`Bot ${bot.name} wake result:`, data);

        // Check if bot is actually alive (200-299 status codes)
        if (data.success && data.status >= 200 && data.status < 300) {
          console.log(`Bot ${bot.name} successfully woken up`);
          setBotHealthStatus((prev) => ({
            ...prev,
            [bot.id]: "alive",
          }));
        } else if (data.status === 503) {
          // Bot is starting up (503) - mark as loading/starting
          console.log(`Bot ${bot.name} is starting up (503)`);
          setBotHealthStatus((prev) => ({
            ...prev,
            [bot.id]: "loading",
          }));
        } else {
          console.log(`Bot ${bot.name} wake failed: ${data.message}`);
          setBotHealthStatus((prev) => ({
            ...prev,
            [bot.id]: "dead",
          }));
        }
      } catch (error) {
        console.error(`Failed to wake bot ${bot.name}:`, error);
        setBotHealthStatus((prev) => ({
          ...prev,
          [bot.id]: "error",
        }));
      }
    },
    [],
  );

  // Get bot status
  const getBotStatus = useCallback(
    (botId: string): BotStatus => {
      return botHealthStatus[botId] || "unknown";
    },
    [botHealthStatus],
  );

  const value: BotHealthContextType = {
    botHealthStatus,
    checkBotHealth,
    checkAllBotsHealth,
    wakeBot,
    isCheckingBots,
    getBotStatus,
  };

  return (
    <BotHealthContext.Provider value={value}>
      {children}
    </BotHealthContext.Provider>
  );
};

export const useBotHealth = (): BotHealthContextType => {
  const context = useContext(BotHealthContext);
  if (context === undefined) {
    throw new Error("useBotHealth must be used within a BotHealthProvider");
  }
  return context;
};
