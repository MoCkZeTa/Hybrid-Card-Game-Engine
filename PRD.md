# PRODUCT REQUIREMENTS DOCUMENT (PRD)

## Universal Hybrid AI Card Game Engine

**Target Architecture:** Version 2.0 (Pure Node.js / TypeScript Plugin Architecture)  
**Target Audience:** Implementing Engineer / Engineering Lead  
**Document Format:** System Implementation Specification  
**Status:** Approved for Implementation  

---

## 1. Executive Summary & Core Objectives

The objective of this project is to build a **Universal Hybrid AI Card Game Engine** in Node.js / TypeScript that dynamically loads and runs multi-phase card games (such as **29**, **Callbreak**, **3-2-5 / Teen Do Paanch**, **Spades**, and **Hearts**) as modular plugins.

Adding support for any new card game must require **zero engine code modifications**. Developers simply drop in a game directory containing:
1. `rules.json`: A Domain-Specific Language (DSL) defining game rules, scoring, phase transitions, and move validity.
2. `strategy.md`: A natural language strategic guide injected into the LLM system prompt to direct AI decision-making.

+---------------------------------------------------------------------------------+
|                              GAME PLUGIN BUNDLE                                 |
|                                                                                 |
|   +---------------------------------+     +---------------------------------+   |
|   |           rules.json            |     |           strategy.md           |   |
|   |  - DSL Rules & Deck Setup       |     |  - High-level Strategy Guide    |   |
|   |  - Legal Move Constraints       |     |  - Tactical Role Prompting      |   |
|   |  - Phase Transitions            |     |  - LLM Reasoning Context        |   |
|   +---------------------------------+     +---------------------------------+   |
|                    |                                       |                    |
+--------------------+---------------------------------------+--------------------+
                     |                                       |
                     v                                       v
+---------------------------------------------------------------------------------+
|                            UNIVERSAL ENGINE CORE                                |
|   (Evaluates legal choices via DSL)         (Injects context into LLM prompts)  |
+---------------------------------------------------------------------------------+

### Primary System Principles
* **Zero Hallucinations:** The TypeScript engine deterministically evaluates and outputs all valid legal choices (`legal_moves`). The LLM acts purely as a strategic decision-maker picking from the bounded choices provided.
* **Orchestration Autonomy:** The orchestration architecture for LLM interactions is completely left to the developer's discretion (e.g., native async loops, lightweight agent abstractions, etc.), provided the chosen approach meets the strict latency SLAs.
* **Compound & Multi-Step Action Support:** Handles atomic compound actions (e.g., "Reveal Hidden Trump + Play Card") and micro-phase sequential interactions (e.g., "Draw Card + Return Card" in 3-2-5).
* **Plugin Extensibility:** Games are integrated solely via `rules.json` and `strategy.md`.

---

## 2. System Architecture & Folder Layout

+-----------------------------------------------------------------------------------+
|                                 Client Layer                                      |
|                 (React Frontend / WebSockets / Event Handlers)                    |
+-----------------------------------------------------------------------------------+
                                          |
                                   WebSocket (WSS)
                                          v
+-----------------------------------------------------------------------------------+
|                           Node.js Application Engine                              |
|                                                                                   |
|  +-----------------------------------------------------------------------------+  |
|  | 1. Plugin & DSL Engine                                                      |  |
|  |    - Dynamic Plugin Loader (`src/games/`)                                   |  |
|  |    - AST Rule Evaluator & Legal Move Engine                                 |  |
|  |    - Fog of War Serialization Engine                                        |  |
|  +-----------------------------------------------------------------------------+  |
|                                         |                                         |
|                               State + Bounded Moves                               |
|                                         v                                         |
|  +-----------------------------------------------------------------------------+  |
|  | 2. AI Decision Pipeline                                                     |  |
|  |    - Prompt Engine (Injects `strategy.md` + State + Choices)                |  |
|  |    - Direct API Router (Groq / Gemini Flash)                                |  |
|  |    - Action Unpacker & Fallback Handler                                     |  |
|  +-----------------------------------------------------------------------------+  |
+-----------------------------------------------------------------------------------+
                                          |
                              Direct REST / Async Calls
                                          v
+-----------------------------------------------------------------------------------+
|                        External LLM APIs (Groq / Gemini)                          |
+-----------------------------------------------------------------------------------+

### Recommended Directory Structure

src/
├── core/
│   ├── engine/           # State machine, AST evaluator, legal move generator
│   ├── plugin/           # Plugin registry and file scanner
│   ├── obfuscation/      # Fog of War state masking
│   └── ai/               # LLM orchestrator, prompt builders, API routers
├── games/                # Modular Game Plugins
│   ├── 29/
│   │   ├── rules.json
│   │   └── strategy.md
│   ├── callbreak/
│   │   ├── rules.json
│   │   └── strategy.md
│   ├── 325/
│   │   ├── rules.json
│   │   └── strategy.md
│   └── [game_id]/
│       ├── rules.json
│       └── strategy.md
└── server.ts             # Application entry point & WebSocket server

---

## 3. Plugin Component Specifications

### 3.1 `rules.json` Requirements (DSL)
The `rules.json` file in each game plugin defines the deterministic mechanics of the game. The implementer has full structural design freedom for the exact TypeScript types, provided `rules.json` encapsulates:
* **Metadata & Players:** Game ID, player count, team topologies (e.g., solo vs. 2v2 pairs), target scoring quotas.
* **Deck Rules:** Active card suits, card values, and custom card point weights or rankings (e.g., card point weights in 29 vs. rank hierarchy in Callbreak).
* **Phase Lifecycle:** Sequence of active phases (e.g., `BIDDING` -> `TRUMP_SELECTION` -> `PLAYING` -> `SCORING`).
* **Trump Mechanics:** Static suits (Callbreak), selected suits post-bidding (3-2-5), or hidden trump mechanics (29).
* **Trick-Taking Constraints:** Must-follow-suit rules, must-win-trick requirements, and void-in-suit behaviors.

### 3.2 `strategy.md` Requirements (Natural Language Strategy)
The `strategy.md` file provides the strategic guidelines for the LLM. It is compiled directly into the system prompt context and should cover:
* **Core Strategic Principles:** General rules of thumb for tactical play (e.g., saving high trumps, counting cards, throwing low points when losing a trick).
* **Role Objectives:** Tactics tailored to player roles (e.g., Declarer vs. Defender in 29; minimum trick quotas in 3-2-5).
* **Decision Heuristics:** Advice for tricky scenarios (e.g., when to open a hidden trump or when to yield lead to a teammate).

---

## 4. State Engine & Move Generation Requirements

### 4.1 Fog of War (Anti-Cheating Data Masking)
* Before game state context is serialized for AI decision-making or client rendering, unrevealed state data **MUST** be masked.
* Opponent hidden cards must be hidden or anonymized.
* Hidden game elements defined in `rules.json` (such as unrevealed trump suits) must remain concealed as `"STATUS: HIDDEN"` until explicitly revealed in-game.

### 4.2 Move Generation & Compound Action Requirements

#### Standard Moves
The legal move engine evaluates current state against `rules.json` constraints to generate a discrete array of available valid options.

#### Requirement A: Atomic Compound Actions
For interactions where two actions occur logically within a single choice (e.g., revealing hidden trump AND playing a card in game 29):
* The engine **MUST** check `rules.json` flags to synthesize combined legal options when conditions are met.
* The backend engine **MUST** execute the underlying action sequence atomically before advancing the main game turn.

#### Requirement B: Micro-Phase Sequential Actions
For multi-step actions requiring new information between steps (e.g., card exchange in 3-2-5):
* The engine **MUST** support micro-phases defined in `rules.json` to temporarily pause turn progression while processing intermediate sub-steps.

---

## 5. AI Interface & Payload Integration Guidelines

> **Implementation Directive:** The exact JSON schemas, prompt templates, and TypeScript interfaces for LLM request/response payloads are left to your architectural design. Ensure they satisfy these functional contracts:

### 5.1 Input Context Requirements
The payload constructed for the LLM decision service must supply sufficient context without leaking hidden state:
1. **Injected Strategy Context:** The contents of the active game plugin's `strategy.md`.
2. **Visible State Context:** Current phase, lead suit, active trick cards, player hand, and team scores.
3. **Available Choices:** An array of valid choices generated by the DSL engine.

### 5.2 Selection & Output Contract
The response returned by the LLM service must satisfy:
1. **Unambiguous Choice:** Resolves strictly to one valid option identifier from the input choice set.
2. **Clean JSON Format:** Formatted as parseable JSON with optional strategic reasoning text for logs/UI.

---

## 6. Performance Budgets, Latency SLAs, & Fallbacks

| Execution Stage | Target SLA | Action on Timeout / Failure |
| :--- | :--- | :--- |
| **Plugin Loading & Rule Validation** | Boot Time | Fail fast on invalid JSON DSL |
| **State Evaluation & Move Generation** | < 2 ms | Log warning; abort frame |
| **LLM Inference Request** | < 1200 ms | Trigger hard timeout signal |
| **Total Turn SLA Window** | **1500 ms** | **Execute First Legal Move (`legal_moves[0]`)** |

### Fallback Execution Rules
1. **Timeout Handling:** If the LLM call exceeds 1500 ms, the request MUST be aborted using an `AbortController`.
2. **Invalid Choice Handling:** If the LLM returns an identifier not present in the valid choices array, the response MUST be rejected.
3. **Deterministic Fallback:** The engine automatically executes the first legal move (`legal_moves[0]`) whenever a timeout or invalid response occurs, ensuring game flow never stalls.

---

## 7. Implementation Directives

* **Plugin Architecture:** Create a `PluginManager` class that reads game folders from `src/games/` dynamically at startup.
* **DSL AST Evaluator:** Implement a rule parser capable of reading `rules.json` configurations and checking game constraints.
* **Prompt Engine:** Build a template compiler that dynamically merges `strategy.md` with active game state and available choices.
* **API Providers:** Target high-speed inference providers (Groq / Gemini Flash) for sub-second responses.
* **Out of Scope:** Real-time speed games (e.g., *Slapjack*) or multi-priority stack resolution games (e.g., *Magic: The Gathering*).