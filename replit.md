# Overview

Tactic Toes is a multiplayer game platform built with React/TypeScript frontend and Firebase Functions backend. The platform supports multiple game types including Snake (snek), Team Snake (teamsnek), King Snake (kingsnek), Connect 4, Longboi, Tic-tac-toes (tactictoes), Color Clash, and Reversi. Games can be played in real-time with both human players and AI bots, featuring simultaneous turn-based gameplay where conflicts are resolved through "clashes." The system includes MMR-based rankings, session management, and comprehensive game state synchronization.

# Recent Changes

## Invulnerability Potions Feature (March 3, 2026)
- **New Feature**: Added "Potion of (In)vulnerability" item system to Team Snek and King Snek game modes
- **Mechanic**: Potions randomly spawn on the board. When collected, the collector becomes vulnerable (invulnerability level -1) and all alive allies become invulnerable (invulnerability level +1) for 3 turns
- **Invulnerability Tiers**: Collision resolution is tiered by `playerInvulnerabilityLevel`. Higher-level snakes categorically win all collision types over lower-level snakes. Same-level snakes use normal battlesnake rules
- **Body Severing**: When a higher-invulnerability snake's head hits a lower-invulnerability snake's body, the body is severed at the struck segment (struck segment + everything after destroyed)
- **Vulnerable Collision Trigger**: If any snake with invulnerability < 0 is hit in any way (wall, hazard, self, snake collision), all allies' invulnerability buffs are scheduled to expire at the start of the next turn
- **Effect Duration**: Effects last 3 full turns of collision resolution (expiryTurn = collectionTurn + 3, expiry runs at end of turn with `<= currentTurn` check)
- **Configuration**: Game setup includes checkbox to enable and slider for spawn rate (0.05 to 1, step 0.05)
- **Visual**: Potions rendered with custom icon image. Invulnerable snakes get bright blue outlines, vulnerable snakes get bright red outlines
- **Type Changes**: Added `ActiveEffect` interface, `invulnerabilityPotions`, `playerInvulnerabilityLevel`, `activeEffects` to `Turn`, `invulnerabilityPotionEnabled` and `invulnerabilityPotionSpawnRate` to `GameSetup`
- **Backward Compatibility**: All new fields are optional with sensible defaults. Games without potions enabled have zero-cost path through collision detection (fast-paths to normal collision logic when all levels are 0)
- **Core Files Modified**: `shared/types/Game.ts`, `functions/src/gameprocessors/SnekProcessor.ts`, `frontend/src/pages/GamePage/GameSetup.tsx`, `frontend/src/pages/GamePage/SnakeGameLogic.tsx`

## Fertile Ground Bug Fix (February 24, 2026)
- **Bug**: Games would hang at "Game starting" when fertile ground was unchecked
- **Root Cause**: When `fertileTiles` was empty, the Turn object set `fertileTiles: undefined`. Firestore rejects `undefined` values in document writes, causing the `onGameStarted` transaction to crash silently. Toggling fertile ground ON would re-trigger `onGameStarted` with a non-empty `fertileTiles` array, allowing it to succeed.
- **Fix**: Changed both Turn construction sites in `SnekProcessor.ts` (lines 124 and 585) from `fertileTiles: this.fertileTiles.length > 0 ? this.fertileTiles : undefined` to conditional spread `...(this.fertileTiles.length > 0 ? { fertileTiles: this.fertileTiles } : {})`, which omits the field entirely instead of setting it to `undefined`.
- **Lesson**: Never assign `undefined` to a field in an object destined for Firestore — either omit the key entirely (conditional spread) or use `null` (if the field should exist but be empty).

## Fertile Ground Clustering Control (March 3, 2026)
- **New Feature**: Added "Clustering" slider (1-20) to fertile ground configuration
- **Parameter**: Controls the base frequency of the fractal Perlin noise algorithm. Low clustering (1) = high frequency = scattered tiles. High clustering (20) = low frequency = large blob. Default (10) preserves existing medium-cluster behavior
- **Frequency Mapping**: Linear interpolation from 0.7553 (clustering=1) to 0.0662 (clustering=20), focused on the useful mid-range of the spectrum
- **Preview Board**: Synced across all clients via Firestore. Preview data (fertile tiles, hazards, player positions, food) is written to Firestore on every local UI change and read by all clients for consistent display
- **Hazard Slider**: Hazard percentage changed from TextField to Slider (0-100%)
- **Synced Preview Architecture**: Preview data always stored in `presetFertileTiles`, `presetHazards`, `presetPlayerPositions`, `presetFood` fields. The `usePreviewBoard` boolean flag controls whether the backend uses the synced preview data at game start. Local changes trigger regeneration + Firestore upload; remote changes render from Firestore without local regeneration (tracked via `localChangeRef`)
- **Player Placement Preview**: Shows player positions as X marks (colored by team or unique hue) using edge-placement algorithm with team clustering support. Food shown as orange dots (center + per-player diagonal). Spectators (unassigned players in team games) are excluded
- **Type Changes**: Added `fertileGroundClustering`, `presetFertileTiles`, `presetHazards`, `presetPlayerPositions`, `presetFood`, `usePreviewBoard` to `GameSetup`
- **Backward Compatibility**: All fields optional, defaults to 10 clustering (equivalent to previous hardcoded frequency of ~0.3), `usePreviewBoard` false/missing = normal generation
- **Auto-uncheck**: "Use this board" unchecks on any local change: density, clustering, hazard%, board size, fertile toggle, player list changes, team assignments, game type, team clusters toggle, or refresh button
- **Core Files Modified**: `shared/types/Game.ts`, `functions/src/gameprocessors/SnekProcessor.ts`, `frontend/src/components/SnekConfiguration.tsx`, `frontend/src/pages/GamePage/GameSetup.tsx`

## Fertile Ground & Food Spawn Rate (February 18, 2026)
- **New Feature**: Added "Fertile Ground" option to all snek game variants (snek, teamsnek, kingsnek)
- **Fertile Ground**: When enabled, procedurally generates clustered green tiles using a fuzzy seed-and-spread algorithm that creates organic, grass-like patterns
- **Density Control**: Configurable density percentage (5-80%) controls how much of the board becomes fertile
- **Food Constraint**: When fertile ground is enabled, food only spawns on fertile tiles
- **Food Spawn Rate**: New independent control (0-5, step 0.25) for expected food spawned per turn, replacing the hardcoded single-food-at-50% default
- **Type Changes**: Added `fertileGroundEnabled`, `fertileGroundDensity`, `foodSpawnRate` to `GameSetup`; added `fertileTiles` to `Turn`
- **Backward Compatibility**: All new fields are optional with sensible defaults; existing games unaffected
- **Core Files Modified**: `shared/types/Game.ts`, `functions/src/gameprocessors/SnekProcessor.ts`, `frontend/src/components/SnekConfiguration.tsx`, `frontend/src/pages/GamePage/GameSetup.tsx`, `frontend/src/pages/GamePage/SnakeGameLogic.tsx`

## First Turn Time Configuration & Setup Cloning (November 12, 2025)
- **Problem Solved**: Fixed timing mismatch where turn 0 had a hardcoded 60-second endTime but expired after 10 seconds (using maxTurnTime)
- **New Field**: Added optional `firstTurnTime` field to GameSetup (defaults to 60 seconds)
- **Backward Compatibility**: Field is optional with nullish coalescing (?? 60) in all read paths to handle legacy setups
- **General Setup Cloning**: Refactored `createNewGame` to use object spreading - automatically copies ALL setup fields (including future custom fields) from previous game, only resetting per-game state (playersReady, startRequested, started, timeCreated)
- **Rematch Flow**: `gamePlayers` array is preserved between games, maintaining bots, king designations, and team assignments; players must re-ready to start new game
- **Core Changes**:
  - `onGameStarted` now uses `firstTurnTime` for both turn 0 endTime and task scheduling
  - `createNewGame` uses spread operator (`...previousSetup`) to preserve all configuration including player roster across game iterations
  - Firestore rules validate `firstTurnTime` as optional positive integer
- **Deployment Safety**: Legacy GameSetup documents without firstTurnTime automatically default to 60 seconds
- **Enhanced Logging**: Added comprehensive [onGameStarted], [onMoveCreated], [processTurnExpirationTask] log prefixes for debugging turn progression
- **Future-Proof**: New custom fields added to GameSetup will automatically carry over to subsequent games without code changes

## Turn Processing Architecture Refactor (November 5, 2025)
- **Problem Solved**: Eliminated race condition where task scheduling inside Firestore transactions could create duplicate tasks on retry, and where post-transaction operations could fire before commits
- **Architecture Pattern**: Moved from trigger-based task scheduling to caller-orchestrated post-transaction operations
- **New Components**:
  - `processTurnExpirationTask`: Firebase task queue function (v2/tasks) that processes turn expirations
  - `notifyBots`: Standalone utility function for sending bot move requests via Battlesnake API
  - `ProcessTurnResult`: Interface returned by processTurn with metadata for post-transaction orchestration
- **Core Changes**:
  - `processTurn` now returns metadata (newTurnCreated, turnNumber, duration) instead of scheduling tasks directly
  - Callers (`onMoveCreated`, `processTurnExpirationTask`) schedule tasks and call bot notifications AFTER transactions commit
  - Eliminated all Cloud Task queue utilities and their Firestore trigger wrappers
- **Reliability Improvements**: Transaction retries no longer create duplicate scheduled tasks; bot notifications always see committed state
- **Removed**: `scheduleTurnExpiration`, `scheduleBotNotifications`, `onTurnExpirationRequest`, `onBotNotificationRequest` triggers

## King Snake Game Mode (October 7, 2025)
- **New Game Type**: Added "King Snake" (kingsnek) - a team-based battlesnake variant where each team has one designated King
- **Game Rules**: When a King dies, their entire team is eliminated and team score is set to zero; team score is based solely on the King's snake length
- **Visual Indicators**: King snakes display a crown emoji (👑) instead of their regular emoji during gameplay
- **Bot Integration**: Bots receive King information via API to implement King-focused strategies
- **UI Features**: Added crown checkbox for King selection during game setup; Kings automatically move to first position in team list

# User Preferences

Preferred communication style: Simple, everyday language.

# System Architecture

## Frontend Architecture
- **Framework**: React 18 with TypeScript and Vite for fast development and building
- **State Management**: Context API with custom providers for user authentication, game state, and ladder rankings
- **UI Framework**: Material-UI (MUI) v6 with custom theming and Roboto Mono font
- **Routing**: React Router DOM for client-side navigation
- **Real-time Updates**: Firebase SDK with Firestore listeners for live game state synchronization
- **Styling**: Emotion-based styling with custom components and animations

## Backend Architecture
- **Runtime**: Firebase Functions with Node.js 18
- **Database**: Firestore for real-time document storage with offline support via emulators
- **Authentication**: Firebase Auth with anonymous sign-in and Google OAuth integration
- **Background Jobs**: Google Cloud Tasks for scheduled turn expirations and bot move processing
- **Game Logic**: Modular processor pattern with abstract base class and game-specific implementations
- **API Integration**: Battlesnake API support for external bot integration

## Game Engine Design
- **Turn-based System**: Simultaneous moves with conflict resolution through "clashes"
- **State Management**: Immutable game states stored as Firestore documents with turn-by-turn progression
- **Real-time Synchronization**: Client-side listeners maintain live game state without polling
- **Bot Integration**: Supports both internal bots and external Battlesnake API bots
- **MMR System**: Elo-based rating system with placement-based calculations and K-factor adjustments for new players

## Data Architecture
- **Sessions**: Top-level containers for games with automatic game creation
- **Games**: Individual game instances with setup, state, and turn history
- **Rankings**: Per-player MMR tracking across different game types
- **Move Tracking**: Atomic move submissions with validation and expiration handling
- **Team Support**: Configurable team-based gameplay with shared objectives

# External Dependencies

## Firebase & Google Cloud
- **Firebase Firestore**: Primary database for real-time game state, user data, and rankings
- **Firebase Functions**: Serverless backend for game logic, turn processing, and bot integration
- **Firebase Auth**: User authentication with anonymous and Google sign-in
- **Firebase Hosting**: Static site hosting with SPA routing support
- **Google Cloud Tasks**: Scheduled job processing for turn timeouts and bot moves
- **Google Cloud Logging**: Centralized logging and monitoring

## Frontend Libraries
- **@mui/material**: Comprehensive React component library with theming
- **react-router-dom**: Client-side routing and navigation
- **react-color**: Color picker components for user customization
- **lucide-react**: Icon library for UI elements
- **tinycolor2**: Color manipulation utilities

## Development Tools
- **TypeScript**: Static typing across frontend and backend
- **ESLint**: Code quality and consistency enforcement
- **Jest**: Unit testing framework with Firebase Functions test utilities
- **Vite**: Fast frontend build tool with HMR support
- **Firebase CLI**: Local development with emulator suite

## External APIs
- **Battlesnake API**: Integration for external bot players with standard move/game endpoints
- **Google OAuth**: Social authentication for user accounts

# Infrastructure & Deployment

## GCP Project Bootstrap Script

**Location**: `scripts/bootstrap-gcp-project.sh`

When setting up a new Firebase/GCP project (e.g., a new staging environment), run this script to configure all required APIs and IAM permissions in one step:

```bash
./scripts/bootstrap-gcp-project.sh <PROJECT_ID>
```

**IMPORTANT: Maintaining This Script**

The Firebase CLI does NOT automatically grant IAM permissions when deploying. If you add new GCP/Firebase features to this project, you MUST update the bootstrap script to include any new required permissions. Otherwise, future deployments to new environments will fail with permission errors that require time-consuming troubleshooting.

**When to update the script:**
- Adding a new Firebase service (e.g., Storage, Realtime Database)
- Using a new Google Cloud API (e.g., Vision API, Translate API)
- Adding new Cloud Functions that require additional permissions
- Changing from Gen1 to Gen2 Functions (different service accounts)
- Adding Secret Manager secrets
- Adding new Cloud Tasks queues or Pub/Sub topics

**Current GCP resources requiring permissions:**
- Firebase Functions (Gen1 and Gen2)
- Firestore
- Firebase Hosting
- Firebase Auth
- Google Cloud Tasks (turn-expiration-queue)
- Artifact Registry (for function container images)
- Cloud Build (for function deployment)
- Cloud Logging
- Pub/Sub (for Eventarc triggers)
- Cloud Run (for Gen2 functions)

## Organization vs Standalone Project IAM Differences

**Key Insight (February 24, 2026):** Projects under a GCP Organization enforce stricter IAM than standalone ("No organisation") projects. Specifically:

1. **Service account self-impersonation**: The Compute SA (used by Gen2 functions) must be explicitly granted `roles/iam.serviceAccountUser` on itself to schedule Cloud Tasks. Standalone projects allow this implicitly.
2. **Cloud Run service-level invoker**: Project-level `roles/run.invoker` may not be sufficient for organization projects. Service-level `run.invoker` grants on specific Cloud Run services (e.g., `processturnexpirationtask`) may be required.
3. **Domain Restricted Sharing**: Organization policies may block `allUsers` grants needed for callable functions.

The bootstrap script (`scripts/bootstrap-gcp-project.sh`) now handles all three scenarios. For first-time setups, run the script twice — once before deploy and once after (Step 11 requires the Cloud Run services to exist).

## Organization Policy: Domain Restricted Sharing

**Problem:** If your GCP project is under an organization with Domain Restricted Sharing enabled (`iam.allowedPolicyMemberDomains`), Firebase callable functions will fail with CORS errors. This is because:

1. Firebase callable functions (like `wakeBot`) need `allUsers` to have the Cloud Functions Invoker role
2. The organization policy blocks granting permissions to `allUsers` (anyone on the internet)
3. GCP IAM and Firebase Auth are separate systems - even though users authenticate with Firebase, the browser request must first be allowed at the GCP IAM layer

**Symptoms:**
- CORS errors when calling callable functions from the browser
- Error message: "User allUsers is not in permitted organization"
- Bot health checks fail immediately

**Solution:** Remove the domain restriction at the organization level:

```bash
# Find your organization ID
gcloud organizations list

# Remove the restriction (replace ORG_ID with your org number)
gcloud org-policies delete iam.allowedPolicyMemberDomains --organization=ORG_ID

# Wait up to 15 minutes for propagation, then grant public access
gcloud functions add-iam-policy-binding wakeBot \
  --region=us-central1 \
  --member=allUsers \
  --role=roles/cloudfunctions.invoker \
  --project=PROJECT_ID
```

**Security Note:** This allows the HTTP request to reach the function, but the function code still validates Firebase Auth tokens via `context.auth`. The `allUsers` permission is at the network layer, not the application layer.

**Firebase Project Aliases** (defined in `.firebaserc`):
- `production`: tactic-toes-tuke (live production environment)
- `staging`: tactic-toes-cyphid-dev (development/testing environment)

## Environment-Specific Configuration

Frontend Firebase config is determined by environment variables. See `frontend/src/firebaseConfig.ts` for the configuration loading logic. Set the following environment variables in Replit for staging development:
- `VITE_FIREBASE_API_KEY`
- `VITE_FIREBASE_AUTH_DOMAIN`
- `VITE_FIREBASE_PROJECT_ID`
- `VITE_FIREBASE_STORAGE_BUCKET`
- `VITE_FIREBASE_MESSAGING_SENDER_ID`
- `VITE_FIREBASE_APP_ID`