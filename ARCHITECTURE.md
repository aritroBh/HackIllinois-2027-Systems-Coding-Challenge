# 🌊 WaveShift Nexus — Comprehensive Systems Architecture & Engineering Specification
**Target Platform:** HackIllinois 2027 Systems Infrastructure  
**Adonix Alignment:** Strict compliance with [HackIllinois Adonix](https://github.com/HackIllinois/adonix) architectural standards  
**Language & Engine:** TypeScript 5.x / Node.js / MongoDB WiredTiger (Document-Level CAS & ACID Transactions)

---

## 📑 Table of Contents
1. [Executive Summary & High-Level Topology](#1-executive-summary--high-level-topology)
2. [Database Schema & Entity-Relationship Architecture (ERD)](#2-database-schema--entity-relationship-architecture-erd)
3. [Concurrency Control: WiredTiger Atomic CAS vs TOCTOU Race Conditions](#3-concurrency-control-wiredtiger-atomic-cas-vs-toctou-race-conditions)
4. [Autonomous FIFO Waitlist Cascade State Machine](#4-autonomous-fifo-waitlist-cascade-state-machine)
5. [Scheduling Invariants: 30-Minute Rest Buffers & Fatigue Limits](#5-scheduling-invariants-30-minute-rest-buffers--fatigue-limits)
6. [Multi-Party Shift Swaps & Tarjan Directed Cyclic Trade Engine](#6-multi-party-shift-swaps--tarjan-directed-cyclic-trade-engine)
7. [Dynamic Rotating HMAC-SHA256 QR Attendance Protocol](#7-dynamic-rotating-hmac-sha256-qr-attendance-protocol)
8. [Geodesic Spatial Geofencing & Haversine Distance Engine](#8-geodesic-spatial-geofencing--haversine-distance-engine)
9. [Hacker SOS Emergency Distress & Spatial Dispatch Engine](#9-hacker-sos-emergency-distress--spatial-dispatch-engine)
10. [PokéShift: UIUC Campus Turf Wars & OCC Versioning](#10-pokeshift-uiuc-campus-turf-wars--occ-versioning)
11. [HackStop Supply Beacons & CAS Power-Up Inventory](#11-hackstop-supply-beacons--cas-power-up-inventory)
12. [Reactive Event Mesh: Server-Sent Events (SSE) Hub](#12-reactive-event-mesh-server-sent-events-sse-hub)
13. [Security, Threat Modeling & Adversarial Hardening](#13-security-threat-modeling--adversarial-hardening)

---

## 1. Executive Summary & High-Level Topology

WaveShift Nexus is an event-driven volunteer shift scheduling and field operations platform engineered specifically for high-stress collegiate hackathons. During events with 1,000+ attendees across distributed university facilities (e.g. Siebel Center, ECEB, Kenney Gym), standard scheduling systems suffer from catastrophic failure modes: oversold high-demand shifts, cascade dropouts, fatigue-induced safety violations, attendance fraud via static screenshots, and resource starvation during emergency incidents.

The following topology diagram illustrates the end-to-end request lifecycle through WaveShift Nexus:

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
        B2["Express Rate Limiter (100 req/min)"]
        B3["Contract-First Zod Validation Middleware"]
        B4["Idempotency Filter (X-Idempotency-Key)"]
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
        D3["SwapService (Tarjan SCC Cycles)"]
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

### 3.2 The WaveShift Atomic Compare-And-Swap Solution
WaveShift eliminates application-level race conditions by pushing the saturation condition directly into MongoDB's WiredTiger storage engine:

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

When a confirmed volunteer cancels their shift, standard systems leave the slot vacant until an organizer manually notices or a candidate re-applies. WaveShift operates an autonomous cascade engine:

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
            1. Atomic decrement filledSlots
            2. Locate waitlist position 1
            3. Verify 0 conflicts for candidate
        end note

        CANCELLED --> CASCADE_PROMOTION : Eligible Candidate Found
        CANCELLED --> VACANT : Waitlist Empty
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

Attempting to book a shift that pushes the cumulative daily duration past 8.0 hours fails with HTTP 409 `DAILY_FATIGUE_LIMIT_EXCEEDED`.

---

## 6. Multi-Party Shift Swaps & Tarjan Directed Cyclic Trade Engine

Direct 1-to-1 trades fail in >90% of hackathon logistics situations due to mismatched volunteer preferences. WaveShift constructs a directed preference graph $G = (V, E)$ where edge $(u, v) \in E$ denotes that Volunteer $u$ is willing to surrender their shift in exchange for the shift held by Volunteer $v$.

```mermaid
flowchart LR
    subgraph Cycle["3-Way Circular Trade Ring (Tarjan SCC)"]
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

### Tarjan Cycle Discovery Algorithm:
1. Construct adjacency list $G$ from pending swap proposals where status is `PENDING`.
2. Compute Strongly Connected Components (SCCs) via Tarjan's depth-first search tracking `dfn[u]` and `low[u]`.
3. Discover elementary cycles bounded to lengths $k \in [2, 4]$.
4. Generate canonical string hash using minimum-vertex rotation to eliminate duplicate cycle permutations:
   $$\text{Hash}(C) = \min_{i} \Big( \text{rotate}(C, i) \Big)$$
5. Execute the rotation within a MongoDB ClientSession multi-document ACID transaction.

---

## 7. Dynamic Rotating HMAC-SHA256 QR Attendance Protocol

To eliminate attendance fraud (e.g. sharing static screenshots on Discord), WaveShift generates cryptographic time-windowed tokens that rotate every 30 seconds:

```mermaid
sequenceDiagram
    autonumber
    actor Vol as Volunteer Device
    participant Srv as Attendance Service
    actor Scanner as Desk Scanner Terminal
    participant Cache as In-Memory Nonce Cache

    Vol->>Srv: POST /attendance/token { volunteerId, shiftId }
    Note over Srv: 1. Calculate timeSlice = floor(timestamp / 30s)<br/>2. Generate 6-byte cryptographic random nonce<br/>3. Compute HMAC-SHA256(payload, secret)
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
    O -->|No| Q["Award Karma Bounty (+300) & Unlock FIRST_RESPONDER Badge"]
```

---

## 10. PokéShift: UIUC Campus Turf Wars & OCC Versioning

To gamify hackathon volunteer operations, UIUC campus hubs represent contested battlegrounds under three competing factions:
* **Team Kernel (`TEAM_KERNEL`):** Systems & Infrastructure Division (Siebel Center HQ, Electric Cyan `#00F2FE`)
* **Team Tensor (`TEAM_TENSOR`):** Artificial Intelligence & Machine Learning Division (ECEB Labs, Neon Magenta `#FF007F`)
* **Team Silicon (`TEAM_SILICON`):** Hardware & Robotics Division (Kenney Gym, Electric Amber `#FFB300`)

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
        L1["Cold Brew Elixir of Haste (Uncommon: 45%)"]
        L2["Insomnia Cookie Shield (Rare: 25%)"]
        L3["Overclocked Solder Core (Epic: 18%)"]
        L4["Rubber Duck of Omniscience (Legendary: 9%)"]
        L5["The Forbidden 100W Anker Gauntlet (Mythic: 3%)"]
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

WaveShift employs a lightweight, uni-directional Server-Sent Events hub (`eventHub`) with connection pooling, channel multiplexing, and automated teardown:

```mermaid
sequenceDiagram
    autonumber
    actor Browser as War Room Dashboard Client
    participant SSE as SSEBroadcastHub (eventHub)
    participant Engine as WaveShift Core Services

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

| Threat Vector | Potential Impact | WaveShift Nexus Mitigation Mechanism |
|---|---|---|
| **Race-Condition Overbooking** | 50 volunteers confirm for a 2-slot shift | WiredTiger atomic CAS predicate `$expr: { $lt: ['$filledSlots', '$capacity'] }`. |
| **Attendance Screenshot Sharing** | Unattended volunteer checks in remotely | Dynamic HMAC-SHA256 tokens rotating every 30s with single-use nonce cache. |
| **Proxy Attendance Spoofing** | Volunteer checks in from dorm outside venue | 75m geodesic Haversine distance geofence boundary verification. |
| **Double-Bounty SOS Exploitation** | Malicious caller spams ticket resolution | Atomic state precondition: `status === DISPATCHED` required for transition to `RESOLVED`. |
| **Gym Damage Inversion** | Negative power input heals enemy gym | Boundary validation: $P \in [10, 500]$ and integer-only sanitization. |
| **NoSQL Operator Injection** | Attacker injects `$ne` or `$regex` into query | Contract-first Zod schemas enforcing native TypeScript enums. |
| **BSON CastError Leaks** | Arbitrary strings crash server and leak topology | Strict 24-char hexadecimal regex matching on all ObjectID parameters. |
| **DDoS API Flooding** | Resource exhaustion on check-in endpoints | Token-bucket sliding window rate limiting (100 req/min per IP). |

---

## 14. Verification & Operational Matrix

```text
========================================================================================
🚀 WAVESHIFT NEXUS: COMPREHENSIVE VERIFICATION MATRIX (9/9 SUITES, 26/26 TESTS PASSING)
========================================================================================
[PASS] tests/masterEndToEnd.test.ts  - 10-System Interconnected Operational Simulation
[PASS] tests/concurrency.test.ts     - 50-Worker High-Contention Race Condition Latch
[PASS] tests/registration.test.ts    - Rest Buffers, Fatigue Caps & Skill Certifications
[PASS] tests/checkin.test.ts         - Dynamic 30s HMAC QR Tokens & Anti-Replay Cache
[PASS] tests/swaps.test.ts           - Tarjan Directed Graph Multi-Party Cyclic Trades
[PASS] tests/waitlist.test.ts        - Autonomous FIFO Waitlist Cascade Promotion
[PASS] tests/geoSos.test.ts          - 75m Geofencing, Nearest SOS Dispatch & Adonix Sync
[PASS] tests/pokestop.test.ts        - PokéShift Turf War OCC Battles & HackStop Beacons
[PASS] tests/shifts.test.ts          - Catalog Encodings & Dynamic Circadian Surge Pricing
========================================================================================
```

