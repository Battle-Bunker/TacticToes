#!/usr/bin/env node
// Playwright smoke test against ONE centaur's web UI:
//   1. open /play (do this BEFORE the game starts — the open page counts as
//      operator activity, and without it the centaur suspends its Firebase
//      connection after the ~60s idle grace and never plays)
//   2. wait for a live game card and assert its "Turn N" counter advances
//   3. resolve the game id via the same-origin /api/play/games endpoint and
//      check /game/:id renders its title element
//
// Uses the machine-global Playwright install — this repo does not depend on
// Playwright. Override with PLAYWRIGHT_HOME / PLAYWRIGHT_BROWSERS_PATH.
//
// Usage: node pw-smoke.mjs [baseUrl] [advances]
//   baseUrl   centaur UI origin (default http://127.0.0.1:6001)
//   advances  turn-counter increments to require (default 3)
//   PW_CARD_TIMEOUT_MS   max wait for a game card to appear (default 120000)
//   PW_ADVANCE_TIMEOUT_MS max wait for the advances (default 120000)
import { createRequire } from "module"

const PLAYWRIGHT_HOME = process.env.PLAYWRIGHT_HOME || "/opt/node22/lib/node_modules/playwright"
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) process.env.PLAYWRIGHT_BROWSERS_PATH = "/opt/pw-browsers"
const require = createRequire(import.meta.url)
let chromium
try {
  ;({ chromium } = require(PLAYWRIGHT_HOME))
} catch {
  ;({ chromium } = require("playwright")) // fall back to a local install
}

const base = process.argv[2] || "http://127.0.0.1:6001"
const wantAdvances = parseInt(process.argv[3] || "3", 10)
const cardTimeout = parseInt(process.env.PW_CARD_TIMEOUT_MS || "120000", 10)
const advanceTimeout = parseInt(process.env.PW_ADVANCE_TIMEOUT_MS || "120000", 10)
const tag = new URL(base).port || base
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), `[pw ${tag}]`, ...a)

const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage()
  await page.goto(`${base}/play`, { waitUntil: "domcontentloaded" })
  log("loaded /play, title =", await page.title())

  // Live game cards are WS-fed and render "Turn N" in .game-card-turn.
  await page.waitForSelector(".game-card .game-card-turn", { timeout: cardTimeout })
  const readTurn = async () => {
    const texts = await page.$$eval(".game-card .game-card-turn", (els) => els.map((e) => e.textContent))
    const m = texts.map((t) => /Turn (\d+)/.exec(t || "")).find(Boolean)
    return m ? parseInt(m[1], 10) : null
  }

  let last = await readTurn()
  log("first turn seen on /play card:", last)
  let advances = 0
  const deadline = Date.now() + advanceTimeout
  while (advances < wantAdvances && Date.now() < deadline) {
    await page.waitForTimeout(1000)
    const t = await readTurn()
    if (t !== null && last !== null && t > last) {
      advances++
      log(`turn advanced ${last} -> ${t} (${advances}/${wantAdvances})`)
      last = t
    } else if (t !== null && last === null) {
      last = t
    }
  }
  if (advances < wantAdvances) {
    log(`FAIL: only ${advances}/${wantAdvances} turn advances`)
    process.exitCode = 1
  } else {
    // Game page: resolve the id same-origin, then check /game/:id renders.
    const games = await page.evaluate(async () => (await (await fetch("/api/play/games")).json()))
    const gid = games.games?.[0]?.gameId
    log("active games:", games.games?.length ?? 0, "first id:", gid)
    if (!gid) {
      log("FAIL: /api/play/games returned no game id")
      process.exitCode = 1
    } else {
      await page.goto(`${base}/game/${gid}`, { waitUntil: "domcontentloaded" })
      await page.waitForSelector("#pageTitle", { timeout: 15000 })
      const title = await page.$eval("#pageTitle", (e) => e.textContent)
      log("/game/:id title element:", JSON.stringify(title))
      log("PW-SMOKE SUCCESS")
    }
  }
} catch (err) {
  log("FAIL:", err.message)
  process.exitCode = 1
} finally {
  await browser.close()
}
