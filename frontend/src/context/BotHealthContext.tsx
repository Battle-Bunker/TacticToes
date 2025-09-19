import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  ReactNode,
} from "react";
import { Bot } from "@shared/types/Game";

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

  // Bot health check function with retry logic for wake-up
  const checkBotHealth = useCallback(
    async (bot: Bot, retryCount = 0): Promise<void> => {
      const maxRetries = 3;
      const retryDelay = 2000; // 2 seconds between retries

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
        console.log(`Checking bot ${bot.name} health at: ${bot.url} (attempt ${retryCount + 1})`);
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000); // 15 second timeout

        // Try direct fetch first, fall back to proxy if CORS issues
        let response: Response;
        try {
          response = await fetch(bot.url, {
            method: "GET",
            signal: controller.signal,
            mode: "no-cors", // This will prevent CORS issues but limits response access
            headers: {
              Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            },
          });
        } catch (corsError) {
          // If CORS fails, use proxy as fallback
          const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(bot.url)}`;
          response = await fetch(proxyUrl, {
            method: "GET",
            signal: controller.signal,
            headers: {
              Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            },
          });
        }

        clearTimeout(timeoutId);

        console.log(`Bot ${bot.name} response status: ${response.status}`);

        // Handle 503 Service Unavailable (service starting up)
        if (response.status === 503 && retryCount < maxRetries) {
          console.log(`Bot ${bot.name} returned 503, retrying in ${retryDelay}ms...`);
          setTimeout(() => {
            checkBotHealth(bot, retryCount + 1);
          }, retryDelay);
          return;
        }

        if (response.ok || response.type === "opaque") {
          // For no-cors requests, we get opaque responses which we consider successful
          let text = "";
          try {
            if (response.type !== "opaque") {
              text = await response.text();
            }
          } catch (e) {
            // Can't read opaque response, but that's ok
          }

          console.log(`Bot ${bot.name} response length: ${text.length}`);

          // Check if the response contains typical bot error indicators
          if (
            text.includes("error") ||
            text.includes("dead") ||
            text.includes("not found") ||
            (text.length > 0 && text.length < 10)
          ) {
            console.log(`Bot ${bot.name} marked as DEAD (error content)`);
            setBotHealthStatus((prev) => ({
              ...prev,
              [bot.id]: "dead",
            }));
          } else {
            console.log(`Bot ${bot.name} marked as ALIVE`);
            setBotHealthStatus((prev) => ({
              ...prev,
              [bot.id]: "alive",
            }));
          }
        } else if (response.status >= 500 && retryCount < maxRetries) {
          // Retry on server errors
          console.log(`Bot ${bot.name} server error ${response.status}, retrying in ${retryDelay}ms...`);
          setTimeout(() => {
            checkBotHealth(bot, retryCount + 1);
          }, retryDelay);
          return;
        } else {
          console.log(`Bot ${bot.name} HTTP error: ${response.status}`);
          setBotHealthStatus((prev) => ({
            ...prev,
            [bot.id]: "dead",
          }));
        }
      } catch (error) {
        console.error(`Bot ${bot.name} health check failed:`, error);
        
        if (retryCount < maxRetries) {
          console.log(`Bot ${bot.name} network error, retrying in ${retryDelay}ms...`);
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
