# 🌊 Nexus Quest — Comprehensive Systems Architecture & Engineering Specification
**Target Platform:** HackIllinois 2027 Systems Infrastructure  
**Adonix Alignment:** Strict compliance with [HackIllinois Adonix](https://github.com/HackIllinois/adonix) architectural standards  
**Language & Engine:** TypeScript 5.x / Node.js / MongoDB WiredTiger (Document-Level CAS & ACID Transactions)

> **Scope note.** Sections 3–6 (concurrency, waitlist, scheduling, swaps) describe the
> current code. Sections 1, 2 and 10–15 were written before content packs, plugins, the
> identity layer, WebSocket presence and the tiled campus renderer existed, and they do not
> cover any of them — see `docs/WORKFLOWS.md`, `docs/IDENTITY.md`, `docs/PRESENCE.md`,
> `docs/PLUGINS.md` and `docs/CONTENT-PACKS.md`, which are maintained against the code.
> Constants quoted here are checked against the source but the structure is not yet.

---

## 📑 Table of Contents
1. [Executive Summary & High-Level Topology](#1-executive-summary--high-level-topology)
2. [Database Schema & Entity-Relationship Architecture (ERD)](#2-database-schema--entity-relationship-architecture-erd)
3. [Concurrency Control: WiredTiger Atomic CAS vs TOCTOU Race Conditions](#3-concurrency-control-wiredtiger-atomic-cas-vs-toctou-race-conditions)
4. [Autonomous FIFO Waitlist Cascade State Machine](#4-autonomous-fifo-waitlist-cascade-state-machine)
5. [Scheduling Invariants: 30-Minute Rest Buffers & Fatigue Limits](#5-scheduling-invariants-30-minute-rest-buffers--fatigue-limits)
6. [Multi-Party Shift Swaps & the Directed Cyclic Trade Engine](#6-multi-party-shift-swaps--the-directed-cyclic-trade-engine)
7. [Dynamic Rotating HMAC-SHA256 QR Attendance Protocol](#7-dynamic-rotating-hmac-sha256-qr-attendance-protocol)
8. [Geodesic Spatial Geofencing & Haversine Distance Engine](#8-geodesic-spatial-geofencing--haversine-distance-engine)
9. [Hacker SOS Emergency Distress & Spatial Dispatch Engine](#9-hacker-sos-emergency-distress--spatial-dispatch-engine)
10. [PokéShift: UIUC Campus Turf Wars & OCC Versioning](#10-pokeshift-uiuc-campus-turf-wars--occ-versioning)
11. [HackStop Supply Beacons & CAS Power-Up Inventory](#11-hackstop-supply-beacons--cas-power-up-inventory)
12. [Reactive Event Mesh: Server-Sent Events (SSE) Hub](#12-reactive-event-mesh-server-sent-events-sse-hub)
13. [Security, Threat Modeling & Adversarial Hardening](#13-security-threat-modeling--adversarial-hardening)
14. [NEXUS OS War Room: The WebGL Campus Renderer](#14-nexus-os-war-room-the-webgl-campus-renderer)

---

## 1. Executive Summary & High-Level Topology

Nexus Quest is an event-driven volunteer shift scheduling and field operations platform engineered specifically for high-stress collegiate hackathons. During events with 1,000+ attendees across distributed university facilities (e.g. Siebel Center, ECEB, Kenney Gym), standard scheduling systems suffer from catastrophic failure modes: oversold high-demand shifts, cascade dropouts, fatigue-induced safety violations, attendance fraud via static screenshots, and resource starvation during emergency incidents.

The following topology diagram illustrates the end-to-end request lifecycle through Nexus Quest:

```mermaid
flowchart TD
    subgraph Clients["Clients & Edge Surfaces"]
        A1["📱 Volunteer Mobile Web"]
        A2["🖥️ War Room Dashboard (/dashboard)"]
        A3["📟 Check-In Scanner Terminals"]
        A4["🆘 Hacker Distress Beacon"]
    end

    subgraph Gateway["HTTP Gateway & Security Layer"]
        B1["CORS & Request Preflight"]
        B2["Rate limiters (300/min per account)"]
        B3["Contract-First Zod Validation Middleware"]
        B4["Idempotency Filter (Idempotency-Key)"]
    end

    subgraph Controllers["API Controllers (/api/v1)"]
        C1["ShiftController"]
        C2["RegistrationController"]
        C3["SwapController"]
        C4["CheckInController"]
        C5["SOSController"]
        C6["GymController"]
        C7["HackStopController"]
        C8["AdonixController"]
        C9["StatsController"]
    end

    subgraph CoreServices["Domain Business Logic Engines"]
        D1["ShiftService (Surge Math)"]
        D2["RegistrationService (Atomic CAS)"]
        D3["SwapService (bounded DFS cycles)"]
        D4["CheckInService (Crypto HMAC Engine)"]
        D5["SOSService (Haversine Nearest-Neighbor)"]
        D6["GymService (OCC Version Fencing)"]
        D7["HackStopService (Geofence & Drop Rates)"]
        D8["AdonixSyncService (Remote Feed Sync)"]
    end

    subgraph EventStream["Real-Time Push Mesh"]
        E1["SSE Broadcast Hub (eventHub)"]
        E2["Heartbeat Keep-Alive (15s)"]
    end

    subgraph Persistence["Storage & Database Layer"]
        F1[("MongoDB WiredTiger Replica Set")]
        F2[("In-Memory ReplSet Fallback")]
    end

    Clients --> Gateway
    Gateway --> Controllers
    Controllers --> CoreServices
    CoreServices --> EventStream
    CoreServices --> Persistence
    EventStream -.->|"SSE (Live Updates)"| A2
```

---

## 2. Database Schema & Entity-Relationship Architecture (ERD)

> The diagram below covers the scheduling and game core. **[docs/DATA-MODEL.md](docs/DATA-MODEL.md)
> is the complete reference** — all twenty-three collections including the four economy ledgers,
> the two auth tables and the audit tables this ERD does not draw — and explains why each one is
> a separate collection rather than a field on something else.

The domain data model enforces strict data integrity, foreign key references, compound uniqueness constraints, and optimistic version tokens directly within MongoDB:

```mermaid
erDiagram
    VOLUNTEER ||--o{ REGISTRATION : "holds"
    VOLUNTEER ||--o{ SHIFT_SWAP : "proposes / accepts"
    VOLUNTEER ||--o{ CHECK_IN : "generates"
    VOLUNTEER ||--o{ SOS_TICKET : "assigned to"
    VOLUNTEER ||--o{ POWER_UP_INVENTORY : "owns"
    SHIFT ||--o{ REGISTRATION : "contains slots"
    SHIFT ||--o{ SHIFT_SWAP : "swapped in"
    SHIFT ||--o{ CHECK_IN : "validated against"
    GYM ||--o{ GYM_DEFENDER : "defended by"
    HACK_STOP ||--o{ POWER_UP_INVENTORY : "looted from"

    VOLUNTEER {
        ObjectId _id PK
        string name
        string email UK
        string role
        string[] certifications
        number karmaPoints
        string prestigeTier
        string[] badges
        number completedShiftsCount
        number totalVolunteerHours
        Date createdAt
    }

    SHIFT {
        ObjectId _id PK
        string title
        string description
        string category
        string location
        Date startTime
        Date endTime
        number capacity
        number filledSlots
        number waitlistCount
        string[] requiredSkills
        number baseKarma
        number version
        boolean isActive
    }

    REGISTRATION {
        ObjectId _id PK
        ObjectId shiftId FK
        ObjectId volunteerId FK
        string status
        number waitlistPosition
        string idempotencyKey UK
        Date registeredAt
        Date confirmedAt
        Date waitlistedAt
    }

    CHECK_IN {
        ObjectId _id PK
        ObjectId shiftId FK
        ObjectId volunteerId FK
        string scannerId
        string tokenNonce UK
        Date checkedInAt
        Date checkedOutAt
        number karmaAwarded
        number hoursLogged
        boolean geofencePassed
    }

    SHIFT_SWAP {
        ObjectId _id PK
        ObjectId proposerVolunteerId FK
        ObjectId proposerShiftId FK
        ObjectId targetVolunteerId FK
        ObjectId targetShiftId FK
        string status
        Date proposedAt
        Date executedAt
    }

    SOS_TICKET {
        ObjectId _id PK
        string hackerName
        string tableLocation
        float latitude
        float longitude
        string category
        string urgency
        string status
        ObjectId assignedVolunteerId FK
        number karmaBounty
        Date dispatchedAt
        Date resolvedAt
    }

    GYM {
        ObjectId _id PK
        string name UK
        string locationName
        float latitude
        float longitude
        string controllingFaction
        number controlPoints
        number maxControlPoints
        ObjectId leaderVolunteerId FK
        string leaderName
        number level
        number version
        boolean isShielded
        Date shieldExpiresAt
    }

    HACK_STOP {
        ObjectId _id PK
        string beaconId UK
        string name
        string locationName
        float latitude
        float longitude
        number cooldownSeconds
        number geofenceRadiusMeters
        number totalSpins
        boolean isActive
    }

    POWER_UP_INVENTORY {
        ObjectId _id PK
        ObjectId volunteerId FK
        string itemType
        string name
        string rarity
        number quantity
        string obtainedFrom
    }
```

---

## 3. Concurrency Control: WiredTiger Atomic CAS vs TOCTOU Race Conditions

### 3.1 The TOCTOU (Time-of-Check to Time-of-Use) Failure Mode
In naive systems, slot registration is implemented as:
```text
1. Shift.findById(shiftId)
2. if (shift.filledSlots < shift.capacity) {
3.     shift.filledSlots += 1;
4.     await shift.save();
5. }
```
When $N=50$ concurrent requests hit step 1 at $t=0$, all 50 observe `filledSlots = 0 < capacity = 2`. All 50 proceed to line 4, overwriting the document and creating **48 oversold registrations**.

### 3.2 The atomic compare-and-swap solution
Nexus Quest eliminates application-level race conditions by pushing the saturation condition directly into MongoDB's WiredTiger storage engine:

```mermaid
sequenceDiagram
    autonumber
    actor WorkerA as Worker 1 (Ada)
    actor WorkerB as Worker 2 (Alan)
    actor WorkerC as Worker 3..50 (Contenders)
    participant WT as WiredTiger Storage Engine (Shift Doc)
    participant Reg as Registrations Collection
    participant Hub as SSE EventHub

    par 50 Concurrent Signups Hit Shift (Capacity: 2)
        WorkerA->>WT: findOneAndUpdate({ _id, $expr: { $lt: ['$filledSlots', '$capacity'] } }, { $inc: { filledSlots: 1 } })
        WorkerB->>WT: findOneAndUpdate({ _id, $expr: { $lt: ['$filledSlots', '$capacity'] } }, { $inc: { filledSlots: 1 } })
        WorkerC->>WT: findOneAndUpdate({ _id, $expr: { $lt: ['$filledSlots', '$capacity'] } }, { $inc: { filledSlots: 1 } })
    end

    Note over WT: WiredTiger document lock serializes atomic CAS operations
    WT-->>WorkerA: Matched! filledSlots: 0 -> 1 (Success)
    WT-->>WorkerB: Matched! filledSlots: 1 -> 2 (Success)
    WT-->>WorkerC: NULL! Predicate Failed: filledSlots (2) not < capacity (2)

    WorkerA->>Reg: Create Registration (status: CONFIRMED)
    WorkerB->>Reg: Create Registration (status: CONFIRMED)
    WorkerC->>WT: Atomic Increment waitlistCount
    WorkerC->>Reg: Create Registration (status: WAITLISTED, waitlistPosition: N)

    WorkerA->>Hub: Broadcast SHIFT_REGISTRATION_CONFIRMED
    WorkerB->>Hub: Broadcast SHIFT_REGISTRATION_CONFIRMED
    WorkerC->>Hub: Broadcast SHIFT_WAITLISTED
```

$$\text{Atomicity Predicate: } \mathcal{P}(S) \equiv \big( S.\text{filledSlots} < S.\text{capacity} \big)$$

If $\mathcal{P}(S)$ evaluates to `false`, the operation yields a zero-write document return and immediately falls back to FIFO waitlist enqueueing.

---

## 4. Autonomous FIFO Waitlist Cascade State Machine

When a confirmed volunteer cancels their shift, standard systems leave the slot vacant until an organizer manually notices or a candidate re-applies. Nexus Quest operates an autonomous cascade engine:

```mermaid
stateDiagram-v2
    [*] --> OPEN : Shift Created

    state ShiftBooking {
        OPEN --> CONFIRMED : Slot Available (Atomic CAS)
        OPEN --> WAITLISTED : Shift Saturated (Queue Tail)
    }

    state CancellationLifecycle {
        CONFIRMED --> CANCELLED : Volunteer Drops Shift
        note right of CANCELLED
            The seat is HELD, not freed:
            1. Locate waitlist position 1
            2. Verify 0 conflicts for candidate
            3. Claim it (CAS on status=WAITLISTED)
            filledSlots only drops if nobody
            is promoted - see note below
        end note

        CANCELLED --> CASCADE_PROMOTION : Eligible Candidate Found
        CANCELLED --> VACANT : Waitlist Empty
        note right of VACANT
            Only here does filledSlots
            decrement. Freeing it earlier
            let a concurrent reservation
            claim the seat the promotion
            was about to transfer, ending
            at capacity + 1.
        end note
    }

    state CASCADE_PROMOTION {
        WAITLISTED --> REINDEXING : Head Dequeued
        REINDEXING --> CONFIRMED : Position 1 Promoted
        note right of REINDEXING
            Monotonic bubble-shift:
            Pos(i) = Pos(i) - 1
            preserves queue contiguity
        end note
    }

    CONFIRMED --> CHECKED_IN : 30s HMAC QR Scanned
    CHECKED_IN --> COMPLETED : Check-Out & Karma Awarded
    COMPLETED --> [*]
```

---

## 5. Scheduling Invariants: 30-Minute Rest Buffers & Fatigue Limits

### 5.1 Rest Buffer Calculus
To prevent physical and cognitive exhaustion during 36-hour hackathons, the scheduler enforces a non-zero rest interval $\beta = 30\text{ minutes}$ ($1,800\text{ seconds}$) between shifts $A$ and $B$:

$$[S_A, E_A) \cap [S_B - \beta, E_B + \beta) = \emptyset$$

```text
Shift A: [===================]
Rest Window:                 |--- 30 Min Buffer ---|
Shift B (Valid):                                   [====================]
Shift B (Rejected 409):            [====================] (Violates Rest Buffer)
```

### 5.2 8-Hour Daily Fatigue Boundary
Let $\mathcal{S}_u(D)$ be the set of confirmed shifts for volunteer $u$ on calendar date $D$. The scheduler asserts:

$$\sum_{s \in \mathcal{S}_u(D)} \text{DurationHours}(s) \le 8.0\text{ hours}$$

Attempting to book a shift that pushes the cumulative daily duration past 8.0 hours fails with HTTP 409 `DAILY_FATIGUE_EXCEEDED`.

---

## 6. Multi-Party Shift Swaps & the Directed Cyclic Trade Engine

Direct 1-to-1 trades fail in >90% of hackathon logistics situations due to mismatched volunteer preferences. Nexus Quest constructs a directed preference graph $G = (V, E)$ where edge $(u, v) \in E$ denotes that Volunteer $u$ is willing to surrender their shift in exchange for the shift held by Volunteer $v$.

```mermaid
flowchart LR
    subgraph Cycle["3-Way Circular Trade Ring"]
        A["Volunteer Alice<br/>(Holds: Shift 1 - Logistics)"] -->|"Wants Shift 2"| B["Volunteer Bob<br/>(Holds: Shift 2 - Hardware)"]
        B -->|"Wants Shift 3"| C["Volunteer Charlie<br/>(Holds: Shift 3 - Food)"]
        C -->|"Wants Shift 1"| A
    end

    subgraph AtomicExecution["ACID Multi-Document Transaction"]
        TX["Start ClientSession Transaction<br/>ReadConcern: majority<br/>WriteConcern: majority"]
        TX --> W1["Shift 1 -> Assigned to Charlie"]
        TX --> W2["Shift 2 -> Assigned to Alice"]
        TX --> W3["Shift 3 -> Assigned to Bob"]
        TX --> COM["Commit Transaction & Broadcast SSE"]
    end

    Cycle --> AtomicExecution
```

### Cycle discovery (`src/common/utils/cycleFinder.ts`)

Bounded elementary-cycle enumeration by depth-first search. Not Tarjan, and not an SCC
decomposition — this document claimed both for a while, and the code has never contained
either. The rings being looked for are two to four people long in a graph of at most a few
hundred pending proposals, so the asymptotic win from condensing components first buys
nothing and the direct search is the whole algorithm.

1. Build the adjacency list $G$ from `PENDING` proposals: an edge $u \rightarrow v$ exists
   when $u$ wants the shift $v$ currently holds.
2. From each node in sorted order, walk depth-first with the start node held fixed, bounded
   at $k \in [2, 4]$ and guarded by an on-stack set so a node is never re-entered within a
   walk.
3. Deduplicate by construction rather than by hashing afterwards: an edge to a node
   lexicographically smaller than the start node is not traversed, so each cycle is
   discovered exactly once, from its smallest member. There is no canonical-rotation hash.
4. Execute the rotation inside one MongoDB `ClientSession` transaction — every leg moves or
   none does — after validating each leg's certifications and schedule conflicts up front.

---

## 7. Dynamic Rotating HMAC-SHA256 QR Attendance Protocol

To eliminate attendance fraud (e.g. sharing static screenshots on Discord), Nexus Quest generates cryptographic time-windowed tokens that rotate every 30 seconds:

```mermaid
sequenceDiagram
    autonumber
    actor Vol as Volunteer Device
    participant Srv as Attendance Service
    actor Scanner as Desk Scanner Terminal
    participant Cache as In-Memory Nonce Cache

    Vol->>Srv: POST /attendance/token { volunteerId, shiftId }
    Note over Srv: 1. Calculate timeSlice = floor(timestamp / 30s)<br/>2. Generate 96-bit (12-byte) cryptographic random nonce<br/>3. Compute HMAC-SHA256(payload, secret)
    Srv-->>Vol: Dynamic Token: payloadBase64.signatureHex (TTL: 30s)
    Vol->>Vol: Render Dynamic Animated SVG QR Code

    Scanner->>Vol: Scan QR Code
    Scanner->>Srv: POST /attendance/verify { token, scannerId, coordinates }
    Note over Srv: Constant-time timingSafeEqual validation

    alt Token Nonce Already Consumed
        Srv->>Cache: Check nonce
        Cache-->>Srv: Nonce Exists!
        Srv-->>Scanner: 409 Conflict: REPLAY_ATTACK_DETECTED
    else Clock Drift |drift| > 1 Slice (Expired)
        Srv-->>Scanner: 400 Bad Request: TOKEN_EXPIRED
    else Geofence > 75m
        Srv-->>Scanner: 403 Forbidden: OUTSIDE_GEOFENCE
    else Valid Check-In
        Srv->>Cache: Store nonce (TTL: 90s)
        Srv->>Srv: Mark Registration CHECKED_IN
        Srv-->>Scanner: 200 OK: Check-In Confirmed & Karma Credited
    end
```

---

## 8. Geodesic Spatial Geofencing & Haversine Distance Engine

Physical presence verification is calculated using the spherical Earth Haversine formula ($R = 6,371,000\text{m}$):

$$\Delta\phi = \phi_2 - \phi_1, \quad \Delta\lambda = \lambda_2 - \lambda_1$$

$$a = \sin^2\left(\frac{\Delta\phi}{2}\right) + \cos(\phi_1)\cos(\phi_2)\sin^2\left(\frac{\Delta\lambda}{2}\right)$$

$$a_{\text{clamped}} = \min\big(1.0, \max(0.0, a)\big)$$

$$c = 2 \cdot \text{atan2}\left(\sqrt{a_{\text{clamped}}}, \sqrt{1 - a_{\text{clamped}}}\right), \quad d = R \cdot c$$

```
                                [KENNEY GYM]
                               (40.113054, -88.228012)
                                       ▲
                                       │  Distance: 278m
                                       │  Geofence: 75m
                                       │  [REJECTED 403]
                                       │
[ECEB LOBBY] <----------------- [SIEBEL ATRIUM] -----------------> [DCL BRIDGE]
(40.114828, -88.228056)       (40.113812, -88.224937)       (40.113215, -88.226500)
    Distance: 284m               [HQ / SCANNER]                 Distance: 153m
    [REJECTED 403]               Volunteer (<5m)                [REJECTED 403]
                                 [APPROVED 200]
```

---

## 9. Hacker SOS Emergency Distress & Spatial Dispatch Engine

```mermaid
flowchart TD
    A["Hacker Distress Signal<br/>(e.g. Siebel Basement Lab, Table 42)"] --> B["SOSService.createTicket()"]
    B --> C["Broadcast SOS_TICKET_CREATED over SSE"]
    C --> D["Trigger Audio Synthesizer: playSosAlarm()"]
    
    B --> E["SOSService.dispatchNearestVolunteer(ticketId)"]
    E --> F["Filter: Registrations status = CHECKED_IN"]
    F --> G{"Does ticket require<br/>skill certification?"}
    G -->|Yes| H["Filter: vol.certifications.includes(skill)"]
    G -->|No| I["Include all checked-in volunteers"]
    
    H --> J["Calculate Haversine distance to each candidate"]
    I --> J
    J --> K["Select argmin(distanceMeters)"]
    K --> L["Update ticket: status = DISPATCHED<br/>assignedVolunteerId = bestCandidate._id"]
    L --> M["Broadcast SOS_TICKET_DISPATCHED (Telemetry Vector)"]
    M --> N["Volunteer Resolves Ticket<br/>POST /sos/tickets/:id/resolve"]
    N --> O["Idempotent Check: Is ticket already resolved?"]
    O -->|Yes| P["409 Conflict (Prevents double-bounty exploit)"]
    O -->|No| Q["Award Karma Bounty (default 150, pack-capped) & Unlock FIRST_RESPONDER Badge"]
```

---

## 10. PokéShift: UIUC Campus Turf Wars & OCC Versioning

To gamify hackathon volunteer operations, UIUC campus hubs represent contested battlegrounds under three competing factions:
* **Team Kernel (`TEAM_KERNEL`):** Systems & Infrastructure Division (Siebel Center HQ, Electric Cyan `#22d3ee`)
* **Team Tensor (`TEAM_TENSOR`):** Artificial Intelligence & Machine Learning Division (ECEB Labs, Soft Violet `#a78bfa`)
* **Team Silicon (`TEAM_SILICON`):** Hardware & Robotics Division (Kenney Gym, Electric Amber `#fbbf24`)

### Optimistic Concurrency Control (OCC) State Fencing:
```mermaid
stateDiagram-v2
    [*] --> GymNeutral : Initial Database Seed

    state GymBattleCycle {
        GymNeutral --> Contested : First Attack
        Contested --> FactionDominated : Faction Reaches Max CP
        FactionDominated --> Contested : Rival Strike Reduces CP
    }

    state OverthrowTransition {
        Contested --> OVERTHROWN : Control Points Depleted to 0
        note right of OVERTHROWN
            Atomically flipped:
            1. controllingFaction = AttackingFaction
            2. leaderName = AttackingVolunteer
            3. version = version + 1
        end note
        OVERTHROWN --> Contested : Re-fortified by Conquering Faction
    }

    state AllyFortification {
        Contested --> Fortified : Ally Contributes Power
        note right of Fortified
            controlPoints = min(maxCP, CP + Power)
            version = version + 1
        end note
    }
```

Every battle executes with version checking:
```typescript
const updated = await Gym.findOneAndUpdate(
  { _id: gymId, version: currentVersion },
  { $set: newAttributes, $inc: { version: 1 } },
  { new: true }
);
```
If another volunteer contests the gym concurrently, `updated` returns `null`, and the algorithm retries with jittered exponential backoff (up to 5 attempts).

---

## 11. HackStop Supply Beacons & CAS Power-Up Inventory

Physical campus HackStops provide volunteers with supplies and randomized collectibles:

```mermaid
flowchart TD
    A["Volunteer within 75m of HackStop Beacon"] --> B["POST /pokeshift/hackstops/:beaconId/spin"]
    B --> C{"Check Geofence & Cooldown"}
    C -->|Distance > 75m| D["403 Forbidden: OUTSIDE_GEOFENCE"]
    C -->|Elapsed < 300s| E["409 Conflict: COOLING_DOWN"]
    C -->|Valid Spin| F["Roll Loot Table (Weighted Probability)"]

    subgraph LootTable["Loot Table Distribution"]
        L1["Cold Brew Elixir of Haste (Uncommon: 40%)"]
        L2["Insomnia Cookie Shield (Rare: 25%)"]
        L3["Overclocked Solder Core (Epic: 20%)"]
        L4["Rubber Duck of Omniscience (Legendary: 10%)"]
        L5["The Forbidden 100W Anker Gauntlet (Mythic: 5%)"]
    end

    F --> LootTable
    LootTable --> G["Upsert PowerUpInventory<br/>$inc: { quantity: 1 }"]
    G --> H["Trigger Audio: playStopSpin() + playLootDrop()"]

    subgraph Activation["Item Deployment (Atomic CAS)"]
        I["POST /pokeshift/inventory/use"] --> J["PowerUpInventory.findOneAndUpdate(<br/>{ volunteerId, itemType, quantity: { $gte: 1 } },<br/>{ $inc: { quantity: -1 } })"]
        J -->|Failed / 0 Quantity| K["400 Bad Request: INSUFFICIENT_INVENTORY"]
        J -->|Success| L["Apply Effect (Shield Gym / Overcharge CP / Karma Bonus)"]
    end
```

---

## 12. Reactive Event Mesh: Server-Sent Events (SSE) Hub

Nexus Quest employs a lightweight, uni-directional Server-Sent Events hub (`eventHub`) with connection pooling, channel multiplexing, and automated teardown:

```mermaid
sequenceDiagram
    autonumber
    actor Browser as War Room Dashboard Client
    participant SSE as SSEBroadcastHub (eventHub)
    participant Engine as Nexus Quest Core Services

    Browser->>SSE: GET /api/v1/stats/events
    SSE->>Browser: HTTP 200 OK (Content-Type: text/event-stream)
    SSE->>Browser: event: CONNECTED\ndata: { clientId, message }\n\n

    loop Every 15 Seconds
        SSE->>Browser: :heartbeat\n\n (Keeps connection alive)
    end

    par Operational Events
        Engine->>SSE: broadcast({ type: "CONCURRENCY_BOMB_FIRED", data })
        SSE->>Browser: event: CONCURRENCY_BOMB_FIRED\ndata: ...\n\n
        Engine->>SSE: broadcast({ type: "WAITLIST_CASCADE_PROMOTED", data })
        SSE->>Browser: event: WAITLIST_CASCADE_PROMOTED\ndata: ...\n\n
        Engine->>SSE: broadcast({ type: "SOS_TICKET_DISPATCHED", data })
        SSE->>Browser: event: SOS_TICKET_DISPATCHED\ndata: ...\n\n
        Engine->>SSE: broadcast({ type: "GYM_CAPTURED", data })
        SSE->>Browser: event: GYM_CAPTURED\ndata: ...\n\n
    end

    Browser->>SSE: Client navigates away / closes tab
    Note over SSE: res.on('close') deletes client from Map<string, IClient>
```

---

## 13. Security, Threat Modeling & Adversarial Hardening

| Threat Vector | Potential Impact | Nexus Quest Mitigation Mechanism |
|---|---|---|
| **Race-Condition Overbooking** | 50 volunteers confirm for a 2-slot shift | WiredTiger atomic CAS predicate `$expr: { $lt: ['$filledSlots', '$capacity'] }`. |
| **Attendance Screenshot Sharing** | Unattended volunteer checks in remotely | Dynamic HMAC-SHA256 tokens rotating every 30s with single-use nonce cache. |
| **Proxy Attendance Spoofing** | Volunteer checks in from dorm outside venue | 75m geodesic Haversine distance geofence boundary verification. |
| **Double-Bounty SOS Exploitation** | Malicious caller spams ticket resolution | Atomic state precondition: `status === DISPATCHED` required for transition to `RESOLVED`. |
| **Gym Damage Inversion** | Negative power input heals enemy gym | Boundary validation: $P \in [10, 500]$ and integer-only sanitization. |
| **NoSQL Operator Injection** | Attacker injects `$ne` or `$regex` into query | Contract-first Zod schemas enforcing native TypeScript enums. |
| **BSON CastError Leaks** | Arbitrary strings crash server and leak topology | Strict 24-char hexadecimal regex matching on all ObjectID parameters. |
| **DDoS API Flooding** | Resource exhaustion on check-in endpoints | Layered limiters: 300/min per account, 600/min anonymous per IP, a 3,000/min per-IP ceiling, 90/min for mutations and 30/min for credential exchanges. |

---

## 14. NEXUS OS War Room: The WebGL Campus Renderer

The dashboard renders the live operation on a 3D model of the actual University
of Illinois Urbana-Champaign campus. Fourteen real landmarks are the contestable
territory gyms, so a captured stronghold is a recognisable building rather than
an abstract marker.

### 14.1 Why hand-written WebGL2

`src/app.ts` serves the dashboard under a Content-Security-Policy whose
`script-src` is `'self'` — no `'unsafe-inline'`. A CDN build of three.js is blocked
outright, and vendoring a full engine to draw ~900 boxes is disproportionate.
`public/gl/glx.js` is therefore a ~450-line WebGL2 layer — mat4/vec3, program
and VAO plumbing, half-float render targets, geometry generators, ear-clipping
triangulation and a static batcher — and `public/gl/campus3d.js` is the scene.

### 14.2 Data provenance

The city is not hand-authored. `design/build-campus.py` bakes two cached
OpenStreetMap extracts (ODbL 1.0, fetched via the Overpass API and cached
under `design/osm/`, which `.gitignore` excludes — the committed part is the
`.overpass` queries and `manifest.json` that let anyone refetch them byte-for-byte) into `content/<pack>/campus/` (tiled; the single-file
`public/gl/uiuc-campus.json` no longer exists):

```text
  design/osm/buildings.json   2.4 MB   2493 building ways
  design/osm/extra.json       4.1 MB   parks, stadiums, artwork nodes, highways
                    │
                    ▼  build-campus.py
      ┌─────────────────────────────────────────────┐
      │ • project WGS84 → local metric frame        │  origin = Main Quad
      │   (+x east, +z south, 10 m per world unit)  │  40.10746, -88.22713
      │ • Douglas-Peucker simplify at 1.1 m         │
      │ • height from OSM height= / building:levels │  419 buildings tagged
      │ • resolve 14 monuments by name, then by     │
      │   proximity (<55 m, no double-claiming)     │
      └─────────────────────────────────────────────┘
                    │
                    ▼
  content/<pack>/campus/       124 tiles + index.json
    9,188 building footprints · 1,994 roads · 467 lawns · 14 monuments · 124 tiles
```

Landmark coordinates in `HACKILLINOIS_VENUES` (`src/common/utils/geo.ts`) were
cross-checked against OSM building centroids while building the map. That audit
corrected several venue positions — Kenney Gym was ~450 m south of its true
location — so the geofencing engine and the map now agree on where campus is.

Two monuments are massed from their verified centroid rather than an outline:
Alma Mater is a `tourism=artwork` node, and neither ECEB nor the Main Library
carries a `building=*` way in the extract. Each is flagged `src: "synth"` in the
model so the distinction stays visible rather than being quietly implied.

### 14.3 Render pipeline

```text
   ┌── pass 1 ─────────────────────────────────────────────┐
   │  ground plane   procedural grid + range rings + sweep │
   │  streamed tiles 500 m each, baked in a worker         │  ← public/gl/tiles.js
   │  decal batch    streets + lawns, ONE draw call        │
   │  monuments      14 × footprint + landmark crown       │
   │  actors         volunteers / beacons / distress cones │
   │  additive       auras, geofence rings, shockwaves     │
   └───────────────────────┬───────────────────────────────┘
                           ▼  RGBA16F target
   ┌── pass 2: bloom ──────────────────────────────────────┐
   │  bright pass (soft-knee threshold 0.58) → half res    │
   │  3 × separable 9-tap Gaussian (H then V)              │
   └───────────────────────┬───────────────────────────────┘
                           ▼
   ┌── pass 3: composite ──────────────────────────────────┐
   │  scene + bloom · ACES tonemap · chromatic aberration  │
   │  scanlines · vignette · film grain                    │
   └───────────────────────────────────────────────────────┘
```

Two details carry most of the visual weight:

- **Static batching.** 9,188 buildings as 9,188 draw calls stutters on integrated
  GPUs. `mergeStatic()` bakes position, normal, per-vertex colour and emissive
  into one interleaved buffer, so the ambient city costs a single
  `drawElements`. Only the 14 monuments are dynamic, because only they change
  colour when a faction captures them.
- **Analytic LOD on the window lights** (and, since the fidelity pass, on every procedural material). Facades carry a procedural window grid
  keyed on a per-cell hash. Left unguarded it aliases into sparkling noise once
  a cell falls below a pixel, so the shader measures the cell's screen
  footprint with `fwidth()` and fades the pattern out — the reasoning a mip
  chain applies, done analytically because the pattern has no texture.

### 14.4 Live binding

| Domain event | Map response |
|---|---|
| `GYM_CAPTURED` / `GYM_ATTACKED` | monument recolours to the holding faction; shockwave ring |
| Filled shift slot | a crystal enters orbit around that shift's venue |
| `HACKSTOP_SPUN` | beacon pulses; its 75 m geofence ring is drawn to scale |
| `SOS_TICKET_CREATED` | distress cone at the ticket's real coordinates, alarm rings |
| Monument click | camera eases in; garrison, level and control points open in the rail |

Monument labels are HTML positioned from projected world coordinates each
frame, not canvas text — they stay crisp at any zoom and inherit page
typography.

---

### 14.5 Fidelity pass — reference-driven materials and surveyed detail

A second pass pushed the model from "a city of boxes" toward the actual campus.
Everything in it is traceable to a source in the repo.

**Surveyed detail (design/osm/detail.overpass → design/osm/detail.json).** A
third Overpass extract adds the layers OSM maps individually: **2,343
`natural=tree` nodes** (the elm rows on the Quad are real positions; generated
rows only fill gaps > 12 m from a surveyed tree), 63 street lamps (+ generated
fill to 360), 32 water features including Boneyard Creek, the Illinois Central
rail line, 243 parking pads, 12 fountains, and `roof:shape` where tagged. They
bake into three static batches — buildings + roof caps, ground decals, and
greenery — so the whole ambient campus is still three draw calls.

**Reference photographs (design/refs/).** Ten Wikimedia Commons photographs
of the monuments were fetched and read; `design/refs/MATERIALS.md` records the
albedo, trim and roof of each building as observed, and corrected the brief
in several places (Altgeld is grey rusticated limestone under a red terracotta
spire, not orange sandstone; Foellinger's dome is verdigris; the Union carries
a white cupola over slate). The official brand palette was verified against
brand.illinois.edu: Illini Orange `#FF5F05`, Illini Blue `#13294B`, and the
secondary set (Patina `#007E8E` is, conveniently, the verdigris).

**Procedural materials (public/gl/materials.js).** Twenty-two surfaces —
brick with mortar courses, grey and buff limestone, verdigris (flat and
ribbed for domes), slate, terracotta tile, glass curtain wall, ribbed concrete,
asphalt with centre line, walk, lawn, canopy, water, rail ballast, bronze,
granite — as pure GLSL functions of world position. No textures: the CSP
forbids them and the patterns are metric anyway (a brick is 0.2 × 0.065 m at
10 m per world unit). Every `fwidth()` is evaluated at the top of
`material()` outside any branch, and each pattern fades to its flat albedo once
a cell drops below ~1 px, so the campus reads as solid mass from altitude and
as coursed brick from the Quad.

```text
  static batch vertex:  pos · nrm · colour · emissive · [matId, nightTint] · [across, along]
                                                          ▲                    ▲
                        mergeStatic() assigns per piece ──┘   ribbonGeometry ──┘ (centre lines, rails)

  fragment:  s = material(vMat, world, N, t, extras)      one call, unconditional
             albedo = s.albedo × tint · N' = N + s.nrm · rim × (1 − rough)
             + window lights · + radar sweep · fog → HDR target → bloom → composite
```

Monuments take a `uMat` per draw, inferred from the material reference each
crown piece already used (`MAT.copper → verdigris`, `MAT.tile → terracotta`,
`MAT.trim → whiteTrim`, State Farm's concrete → ribbed with `uRibCenter` at the
building centre). A viewer-side floodlight term lets a monument read in its
own material at night instead of dissolving into blue ambient.

**Sky, fog, cinema.** A starfield pass with an Industrial→Illini-blue
gradient and orange skyglow replaces the flat clear colour; height fog is
gated to campus-wide zoom so it never muddies a close-up. The dashboard's
Campus Grid is now the full-width hero with a telemetry strip (fps, buildings,
monuments, camera distance) and a cinematic mode that hides the chrome
(Escape exits). Clicking a monument opens a dossier from
`content/<pack>/monuments-info.json` — year, architect, style and three facts per
landmark, sourced from Wikipedia and flagged `approximate` where no article
exists.

**What is still approximate.** ECEB and the Main Library have no building way
in OSM and are massed from verified centroids (`src: "synth"`). Alma Mater is
a low-poly figure group, not a sculpture. The stadium is a tiered ellipse with
end blocks rather than a true open horseshoe mesh. Only three OSM buildings
carry `roof:shape`.

---

### 14.6 Nexus Quest — the retro game layer

The dashboard's chrome was rebuilt as a pixel-art game UI after two polished
"ops console" passes were judged generic. Three directions were mocked in
OpenPencil (`design/directions/{gameboy,snes,neoretro}.mjs`, rendered to
`design/exports/<dir>/`); **Neo-retro indie** was chosen — Silkscreen, Jersey
10, Pixelify Sans and VT323, hard 4 px offset shadows, 4 px chamfer notches,
tab buttons that depress, sticker badges, a Boneyard-duck mascot — borrowing
the SNES direction's battle window and message box for gym encounters.

```text
  public/sprites.js     16x16 memorabilia + icons rasterised from content/<pack>/memorabilia.json
  public/avatar.js      webcam/photo → 32x32 (OKLab quantise, Bayer dither) → 128x48 walk sheet
  public/game.js        trainer profile, sticker book, encounter overlay, walk-to-spin gate,
                        geolocation "Walk with me", retro toggle, duck toasts
  public/gl/campus3d.js player billboard (NEAREST-filtered sheet), WASD + follow-cam,
                        setPlayerLatLng (same frame as build-campus.py), proximity events
                        with hysteresis, renderMinimap, setRetro (pixelate/posterize)
```

**The Pokémon-Go loop.** The player sprite walks the real campus — WASD, or
`navigator.geolocation.watchPosition` piped into `setPlayerLatLng` (opt-in by
click; resumed only when permission is already granted and the Campus tab is
open). Off campus the sprite parks at the model's edge and says so. Standing
within 75 m of a HackStop enables Spin; a gym row opens the encounter (FIGHT /
REINFORCE / BAG / MAP / RUN, Escape closes and returns focus). **Proof of
presence is real, not cosmetic:** spins and battles send the *player's*
position (`fromWorld(x, z)`), not the target's coordinates, so the server's
existing 75 m geofence does the check — the client gate is UX, the server is
the authority. Loot drops reveal as "YOU FOUND" with a memorabilia sprite of
the same rarity; holding a monument earns its badge on the trainer card.

**Content.** `content/<pack>/memorabilia.json` — 16 HackIllinois items with 16×16
palette-indexed pixel grids, rarity, how each is earned, and one gym badge per
monument (validated at load; a malformed item is skipped with a warning, never
thrown). `content/<pack>/monuments-info.json` feeds the collectible monument card.

**Cross-review.** Three rounds of independent read-only review (muse and agy
on the renderer, opencode on the app; codex and cursor-agent unavailable for
billing/login). Confirmed and fixed from the final round: keyboard steps
fighting GPS smoothing, a wrong sprite-aspect formula for 48 px avatars,
`fwidth(atan)` spiking at the ±π seam on ribbed domes, a stretched minimap,
retro DPR baked once, proximity keyed by id without kind, target-coordinate
spins (above), a geolocation prompt that could fire without a click, an
encounter with no keyboard exit, 7 px labels, and unvalidated content.

---

## 15. Verification & Operational Matrix

```text
========================================================================================
VERIFICATION MATRIX — 29 suites, 306 tests
========================================================================================
Run `npm test` for the authoritative figure; the numbers above are a snapshot, not a claim.

  masterEndToEnd   ten interconnected systems, one operational simulation
  concurrency      50-worker high-contention race against two seats
  registration     rest buffers, fatigue caps, skill certifications
  lifecycle        the registration state machine only moves forward
  checkin          rotating 30 s HMAC tokens and the anti-replay cache
  attendance       check-out pays exactly once, pro rata
  swaps            directed-graph multi-party cyclic trades
  waitlist         autonomous FIFO cascade promotion
  seededDemo       the shipped demo scenario itself
  geoSos           75 m geofencing, nearest-responder dispatch, Adonix sync
  ops              SOS lifecycle, announcements, roster redaction
  identity         three adapters, CSRF, revocation, claimed-vs-proved identity
  rateLimiter      the four limiters, keyed and stacked
  sse              channels, replay, backpressure, stream slots
  presence         fuzzing, opt-out symmetry, exact-read auditing
  scale            the shared interest computation at 5,000 sessions
  economy          the karma ledger, daily caps, bounty budgets
  game             quests, stickers, streaks over the domain bus
  pokestop         turf-war OCC battles and HackStop beacons
  shifts           catalogue encodings and circadian surge pricing
  content          pack validation and cross-references
  campus           the tiled bake, per-tile hashes, monument ids
  legacyCompat     the open-demo contract still holdsng
========================================================================================
```

