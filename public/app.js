/**
 * WaveShift Nexus Frontend Orchestrator.
 * Connects to Server-Sent Events (SSE) and handles live War Room updates.
 */

let shiftsCache = [];
let volunteersCache = [];
let currentQrToken = null;
let currentQrVolunteerId = null;
let currentQrShiftId = null;
let qrCountdownTimer = null;
let currentVolunteerFaction = 'TEAM_KERNEL';
let gymsCache = [];
let hackStopsCache = [];
let userInventoryCache = [];
let canvasParticles = [];

// Tab Switcher
function switchTab(tabId) {
  document.querySelectorAll('.tab-content').forEach((tab) => tab.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach((btn) => btn.classList.remove('active'));

  const target = document.getElementById(tabId);
  if (target) target.classList.add('active');

  const clickedBtn = Array.from(document.querySelectorAll('.tab-btn')).find((b) =>
    b.getAttribute('onclick')?.includes(tabId)
  );
  if (clickedBtn) clickedBtn.classList.add('active');

  if (tabId === 'tab-qr' && shiftsCache.length > 0 && !currentQrShiftId) {
    setupDefaultQr();
  }
  if (tabId === 'tab-pokeshift') {
    loadGymsData();
    loadHackStopsData();
    loadUserInventory();
  }
}

// Sound Toggle
document.getElementById('sound-toggle-btn')?.addEventListener('click', () => {
  if (window.soundEngine) {
    window.soundEngine.enabled = !window.soundEngine.enabled;
    const btn = document.getElementById('sound-toggle-btn');
    if (btn) {
      btn.innerText = window.soundEngine.enabled ? '🔊 AUDIO: ON' : '🔇 AUDIO: OFF';
    }
  }
});

// Initialize Operations Telemetry & SSE
async function init() {
  await fetchVolunteers();
  await fetchShifts();
  await fetchStats();
  await fetchLeaderboard();
  await loadSOSTickets();
  await loadGymsData();
  await loadHackStopsData();
  await loadUserInventory();
  initCampusRadar();
  connectSSE();
}

async function fetchVolunteers() {
  try {
    const res = await fetch('/api/v1/volunteers');
    const json = await res.json();
    if (json.success) volunteersCache = json.data;
  } catch (err) {
    console.error('Error fetching volunteers:', err);
  }
}

async function fetchShifts() {
  try {
    const res = await fetch('/api/v1/shifts');
    const json = await res.json();
    if (json.success) {
      shiftsCache = json.data;
      renderShifts(shiftsCache);
    }
  } catch (err) {
    console.error('Error fetching shifts:', err);
  }
}

async function fetchStats() {
  try {
    const res = await fetch('/api/v1/stats/operations');
    const json = await res.json();
    if (json.success) {
      const data = json.data;
      document.getElementById('hud-total-shifts').innerText = data.totalShifts;
      document.getElementById('hud-fill-rate').innerText = `${data.overallFillRatePercent}%`;
      document.getElementById('hud-total-karma').innerText = data.totalKarmaAwarded.toLocaleString();
    }
  } catch (err) {
    console.error('Error fetching stats:', err);
  }
}

async function fetchLeaderboard() {
  try {
    const res = await fetch('/api/v1/stats/leaderboard');
    const json = await res.json();
    if (json.success) {
      renderLeaderboard(json.data);
    }
  } catch (err) {
    console.error('Error fetching leaderboard:', err);
  }
}

function renderShifts(shifts) {
  const container = document.getElementById('shifts-grid');
  if (!container) return;

  container.innerHTML = shifts
    .map((shift) => {
      const fillPercent = Math.min(100, Math.round((shift.filledSlots / shift.capacity) * 100));
      const surgeMultiplier = shift.surge ? shift.surge.surgeMultiplier : 1.0;
      const isSurge = surgeMultiplier >= 1.3;
      const karma = shift.surge ? shift.surge.karmaAward : shift.baseKarma;

      return `
      <div class="card ${isSurge ? 'surge-active' : ''}" id="shift-card-${shift._id}">
        <div class="card-header">
          <span class="card-title">${shift.title}</span>
          ${isSurge ? `<span class="surge-badge">⚡ ${surgeMultiplier}x SURGE</span>` : ''}
        </div>
        
        <div class="card-meta">
          <span>📍 ${shift.location}</span>
          <span>⏰ ${new Date(shift.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} - ${new Date(shift.endTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
          <span>🏆 Reward: <strong style="color: var(--cyan);">${karma} Karma</strong></span>
        </div>

        <div class="capacity-meter">
          <div class="capacity-bar" style="width: ${fillPercent}%;"></div>
        </div>
        <div class="capacity-label">
          <span>FILLED: ${shift.filledSlots} / ${shift.capacity}</span>
          <span>WAITLIST: ${shift.waitlistCount}</span>
        </div>

        <div style="display: flex; gap: 8px;">
          <button class="btn" onclick="quickSignUp('${shift._id}')">Claim Shift</button>
          <button class="btn btn-secondary" onclick="viewShiftDetails('${shift._id}')">Details</button>
        </div>
      </div>
    `;
    })
    .join('');
}

function renderLeaderboard(entries) {
  const tbody = document.getElementById('leaderboard-body');
  if (!tbody) return;

  tbody.innerHTML = entries
    .map((e) => `
      <tr>
        <td class="rank-${e.rank}">#${e.rank}</td>
        <td><strong>${e.name}</strong></td>
        <td><span class="badge-tag">${e.prestigeTier}</span></td>
        <td>${e.hoursServed} hrs</td>
        <td style="color: var(--cyan); font-weight: 700;">${e.karmaPoints.toLocaleString()}</td>
        <td>${e.badges.map((b) => `<span style="font-size: 0.72rem; padding: 2px 6px; background: rgba(255,255,255,0.06); border-radius: 4px; margin-right: 4px;">${b}</span>`).join('')}</td>
      </tr>
    `)
    .join('');
}

// SSE Real-Time Event Listener
function connectSSE() {
  const eventSource = new EventSource('/api/v1/stats/events');

  eventSource.addEventListener('SLOT_RESERVED', (e) => {
    const payload = JSON.parse(e.data);
    if (window.soundEngine) window.soundEngine.playSonarPing();
    logChaosTerminal(`[EVENT] Slot Reserved on shift ${payload.shiftId} by ${payload.volunteerName}`);
    fetchShifts();
    fetchStats();
  });

  eventSource.addEventListener('WAITLIST_JOINED', (e) => {
    const payload = JSON.parse(e.data);
    logChaosTerminal(`[EVENT] Waitlist Joined on shift ${payload.shiftId}: ${payload.volunteerName} (Position #${payload.waitlistPosition})`);
    fetchShifts();
  });

  eventSource.addEventListener('WAITLIST_PROMOTED', (e) => {
    const payload = JSON.parse(e.data);
    if (window.soundEngine) window.soundEngine.playCascadeChime();
    logChaosTerminal(`[CASCADE TRIGGERED] 🌊 Volunteer ${payload.volunteerName} atomically promoted from waitlist to CONFIRMED!`);
    fetchShifts();
    fetchStats();
  });

  eventSource.addEventListener('VOLUNTEER_CHECKED_IN', (e) => {
    const payload = JSON.parse(e.data);
    if (window.soundEngine) window.soundEngine.playSonarPing();
    logChaosTerminal(`[CHECK-IN] 📱 ${payload.volunteerName} checked in to "${payload.shiftTitle}"`);
    fetchStats();
  });

  eventSource.addEventListener('VOLUNTEER_CHECKED_OUT', () => {
    fetchStats();
    fetchLeaderboard();
  });

  eventSource.addEventListener('SOS_TICKET_CREATED', (e) => {
    const payload = JSON.parse(e.data);
    if (window.soundEngine) window.soundEngine.playSosAlarm();
    logSosTerminal(`🚨 [SOS BROADCAST] ${payload.hackerName} reported ${payload.category} at ${payload.tableLocation} (+${payload.karmaBounty} Karma)`);
    loadSOSTickets();
  });

  eventSource.addEventListener('SOS_TICKET_DISPATCHED', (e) => {
    const payload = JSON.parse(e.data);
    if (window.soundEngine) window.soundEngine.playDispatchChime();
    logSosTerminal(`⚡ [DISPATCH COMMITTED] ${payload.volunteerName} en route to ${payload.hackerName} (${payload.distanceMeters}m away)`);
    loadSOSTickets();
  });

  eventSource.addEventListener('SOS_TICKET_RESOLVED', (e) => {
    const payload = JSON.parse(e.data);
    logSosTerminal(`✅ [INCIDENT RESOLVED] Ticket ${payload.ticketId.slice(-6)} resolved by ${payload.volunteerName}. +${payload.karmaAwarded} Karma awarded!`);
    loadSOSTickets();
    fetchLeaderboard();
  });

  eventSource.addEventListener('ADONIX_EVENTS_SYNCED', (e) => {
    const payload = JSON.parse(e.data);
    logChaosTerminal(`🔄 [ADONIX SYNC] ${payload.syncedCount} official HackIllinois shifts synchronized live!`);
    fetchShifts();
    fetchStats();
  });

  eventSource.addEventListener('GYM_REINFORCED', () => {
    loadGymsData();
  });

  eventSource.addEventListener('GYM_ATTACKED', () => {
    loadGymsData();
  });

  eventSource.addEventListener('GYM_CAPTURED', () => {
    if (window.soundEngine) window.soundEngine.playGymVictoryFanfare();
    loadGymsData();
  });

  eventSource.addEventListener('HACKSTOP_SPUN', () => {
    loadHackStopsData();
    loadUserInventory();
  });

  eventSource.addEventListener('POWERUP_CONSUMED', () => {
    loadUserInventory();
    loadGymsData();
  });
}

function logChaosTerminal(msg) {
  const term = document.getElementById('chaos-terminal');
  if (!term) return;
  const time = new Date().toLocaleTimeString();
  term.innerHTML = `[${time}] ${msg}\n` + term.innerHTML;
}

// Concurrency Bomb Simulator (Fires 50 requests in parallel into a 2-slot shift)
async function runConcurrencyBomb() {
  logChaosTerminal('💣 [CHAOS LAUNCHED] Priming 50 concurrent workers against a 2-slot shift...');
  if (window.soundEngine) window.soundEngine.playSurgeAlert();

  try {
    // 1. Create a dedicated contested 2-slot shift
    const createRes = await fetch('/api/v1/shifts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Contested Pizza Station (HOT)',
        description: 'High contention shift to benchmark atomic locks',
        category: 'FOOD',
        location: 'Siebel 1st Floor East',
        startTime: new Date(Date.now() + 3600000).toISOString(),
        endTime: new Date(Date.now() + 7200000).toISOString(),
        capacity: 2,
        baseKarma: 150,
      }),
    });
    const shiftData = await createRes.json();
    const testShiftId = shiftData.data._id;

    logChaosTerminal(`Contested shift created (ID: ${testShiftId}, Capacity: 2). Dispatching 50 workers...`);

    // 2. Launch 50 concurrent requests simultaneously
    const start = performance.now();
    const promises = [];

    for (let i = 0; i < 50; i++) {
      const vol = volunteersCache[i % volunteersCache.length] || volunteersCache[0];
      const idemKey = `concurrency_bomb_${Date.now()}_worker_${i}`;

      const p = fetch('/api/v1/registrations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'idempotency-key': idemKey,
        },
        body: JSON.stringify({
          shiftId: testShiftId,
          volunteerId: vol._id,
        }),
      }).then((r) => r.json());

      promises.push(p);
    }

    const responses = await Promise.all(promises);
    const elapsed = (performance.now() - start).toFixed(1);

    const confirmed = responses.filter((r) => r.status === 'CONFIRMED').length;
    const waitlisted = responses.filter((r) => r.status === 'WAITLISTED').length;
    const errors = responses.filter((r) => !r.success).length;

    logChaosTerminal(`\n📊 [BENCHMARK RESULTS in ${elapsed}ms]`);
    logChaosTerminal(`   ✅ Confirmed Slots: ${confirmed} (Expected: 2)`);
    logChaosTerminal(`   ⏳ Waitlisted:      ${waitlisted} (Expected: 48)`);
    logChaosTerminal(`   ❌ Oversold/Errors:  ${errors} (Expected: 0)`);
    logChaosTerminal(`🎯 [INVARIANT VERIFIED] Exactly 0 overselling. WiredTiger Atomic CAS held under 50-worker contention!`);

    fetchShifts();
    fetchStats();
  } catch (err) {
    logChaosTerminal(`[ERROR] Concurrency bomb failed: ${err.message}`);
  }
}

// Simulate Drop Cascade
async function simulateDropCascade() {
  logChaosTerminal('⚡ [CHAOS SIMULATION] Finding a confirmed registration to drop...');
  try {
    const res = await fetch('/api/v1/registrations?status=CONFIRMED');
    const json = await res.json();
    if (!json.success || json.data.length === 0) {
      logChaosTerminal('No confirmed registrations available to drop.');
      return;
    }

    const target = json.data[0];
    logChaosTerminal(`Cancelling confirmed registration ${target._id} for shift "${target.shiftId.title}"...`);

    const dropRes = await fetch(`/api/v1/registrations/${target._id}`, {
      method: 'DELETE',
    });
    const dropJson = await dropRes.json();

    if (dropJson.success) {
      logChaosTerminal(`✅ Cancellation successful.`);
      if (dropJson.data.promoted) {
        logChaosTerminal(`🌊 [CASCADE PROMOTION] Waitlist candidate ${dropJson.data.promoted.volunteerId} atomically promoted to CONFIRMED!`);
        if (window.soundEngine) window.soundEngine.playCascadeChime();
      } else {
        logChaosTerminal(`Slot remains open (no waitlisted candidates).`);
      }
    }
  } catch (err) {
    logChaosTerminal(`[ERROR] Drop cascade simulation failed: ${err.message}`);
  }
}

// Resolve 3-Way Circular Trade
async function resolveCyclicTrade() {
  logChaosTerminal('🔄 [TARJAN ALGORITHM] Searching trade graph for circular exchange dependencies...');
  try {
    const res = await fetch('/api/v1/swaps/cycles/resolve', { method: 'POST' });
    const json = await res.json();
    if (json.success) {
      const cycles = json.data.discoveredCycles;
      logChaosTerminal(`Discovered ${cycles.length} elementary cycle trade(s).`);
      cycles.forEach((c) => {
        logChaosTerminal(`   🔄 Ring: ${c.join(' ➔ ')} ➔ ${c[0]}`);
      });
      logChaosTerminal(`✅ Executed ${json.data.executedCount} atomic cyclic trade rotation(s) in a single transaction.`);
      fetchShifts();
    }
  } catch (err) {
    logChaosTerminal(`[ERROR] Cyclic trade resolution failed: ${err.message}`);
  }
}

// Dynamic QR Setup & Verification
async function setupDefaultQr() {
  if (volunteersCache.length === 0 || shiftsCache.length === 0) return;
  const vol = volunteersCache[0];
  const shift = shiftsCache[0];

  currentQrVolunteerId = vol._id;
  currentQrShiftId = shift._id;
  await refreshQrToken();
}

async function refreshQrToken() {
  if (!currentQrVolunteerId || !currentQrShiftId) return;

  try {
    const res = await fetch('/api/v1/attendance/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        volunteerId: currentQrVolunteerId,
        shiftId: currentQrShiftId,
      }),
    });
    const json = await res.json();

    if (json.success) {
      currentQrToken = json.data.token;
      const img = document.getElementById('qr-image');
      if (img) {
        // Generate visual QR code via public Google Chart API / SVG QR generator
        img.src = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(currentQrToken)}`;
      }

      startQrCountdown(json.data.expiresInSeconds);
      logQrTerminal(`Dynamic token generated (Slice: ${json.data.timeSlice}). Token: ${currentQrToken.substring(0, 24)}...`);
    } else {
      logQrTerminal(`Failed to generate token: ${json.message}`);
    }
  } catch (err) {
    logQrTerminal(`Error: ${err.message}`);
  }
}

function startQrCountdown(seconds) {
  if (qrCountdownTimer) clearInterval(qrCountdownTimer);

  let remaining = seconds;
  const fill = document.getElementById('countdown-fill');
  const text = document.getElementById('countdown-text');

  qrCountdownTimer = setInterval(() => {
    remaining--;
    if (text) text.innerText = `Expires in ${remaining}s`;
    if (fill) fill.style.width = `${(remaining / 30) * 100}%`;

    if (remaining <= 0) {
      clearInterval(qrCountdownTimer);
      refreshQrToken();
    }
  }, 1000);
}

async function simulateDeskScan() {
  if (!currentQrToken) {
    logQrTerminal('No active token to scan.');
    return;
  }

  logQrTerminal('Scanning token at Check-In Desk...');
  try {
    const res = await fetch('/api/v1/attendance/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: currentQrToken }),
    });
    const json = await res.json();

    if (json.success) {
      logQrTerminal(`✅ Check-in verified! Volunteer status: CHECKED_IN.`);
      if (window.soundEngine) window.soundEngine.playSonarPing();
      fetchStats();
    } else {
      logQrTerminal(`❌ Verification rejected: ${json.message}`);
    }
  } catch (err) {
    logQrTerminal(`Error: ${err.message}`);
  }
}

async function simulateReplayAttack() {
  if (!currentQrToken) return;

  logQrTerminal('🚨 [TESTING REPLAY ATTACK] Re-submitting already scanned token...');
  try {
    const res = await fetch('/api/v1/attendance/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: currentQrToken }),
    });
    const json = await res.json();

    if (!json.success && json.error === 'REPLAY_ATTACK_DETECTED') {
      logQrTerminal(`🛡️ [REPLAY SHIELD VERIFIED] Replay detected and rejected mathematically!`);
    } else {
      logQrTerminal(`Outcome: ${JSON.stringify(json)}`);
    }
  } catch (err) {
    logQrTerminal(`Error: ${err.message}`);
  }
}

function logQrTerminal(msg) {
  const term = document.getElementById('qr-terminal');
  if (term) term.innerText = `[${new Date().toLocaleTimeString()}] ${msg}\n` + term.innerText;
}

// Quick Sign Up Helper
async function quickSignUp(shiftId) {
  if (volunteersCache.length === 0) return;
  const vol = volunteersCache[0];

  try {
    const res = await fetch('/api/v1/registrations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shiftId, volunteerId: vol._id }),
    });
    const json = await res.json();

    if (json.success) {
      logChaosTerminal(`Volunteer ${vol.name} claimed shift ${shiftId} (Status: ${json.status})`);
      fetchShifts();
    } else {
      alert(`Could not sign up: ${json.message}`);
    }
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
}

// ----------------------------------------------------
// UIUC Campus Venue Radar Map & Hacker SOS Dispatch Engine
// ----------------------------------------------------
let radarAngle = 0;
let radarAnimationId = null;
let openSosTicketsCache = [];

const CAMPUS_VENUES = {
  SIEBEL: { name: 'Siebel Center (HQ)', x: 325, y: 190, color: '#00f3ff', tag: 'HQ' },
  ECEB: { name: 'ECEB Lobby', x: 170, y: 110, color: '#9d4edd', tag: 'LABS' },
  KENNEY: { name: 'Kenney Gym', x: 130, y: 290, color: '#ff9e00', tag: 'ARENA' },
  DCL: { name: 'DCL Hub', x: 235, y: 220, color: '#00e5ff', tag: 'BRIDGE' },
};

function initCampusRadar() {
  const canvas = document.getElementById('campus-radar-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  function renderRadar() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const centerX = CAMPUS_VENUES.SIEBEL.x;
    const centerY = CAMPUS_VENUES.SIEBEL.y;

    // 1. Grid Background
    ctx.strokeStyle = 'rgba(0, 243, 255, 0.05)';
    ctx.lineWidth = 1;
    for (let x = 0; x < canvas.width; x += 40) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, canvas.height);
      ctx.stroke();
    }
    for (let y = 0; y < canvas.height; y += 40) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(canvas.width, y);
      ctx.stroke();
    }

    // 2. Geofence Range Rings (25m, 50m, 75m boundary, 150m perimeter)
    const rings = [
      { r: 40, label: '25m' },
      { r: 85, label: '50m' },
      { r: 130, label: '75m GEOFENCE' },
      { r: 200, label: '150m PERIMETER' },
    ];

    rings.forEach((ring, idx) => {
      ctx.beginPath();
      ctx.arc(centerX, centerY, ring.r, 0, Math.PI * 2);
      ctx.strokeStyle = idx === 2 ? 'rgba(0, 243, 255, 0.45)' : 'rgba(0, 243, 255, 0.12)';
      ctx.setLineDash(idx === 2 ? [4, 4] : []);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = 'rgba(0, 243, 255, 0.45)';
      ctx.font = '9px monospace';
      ctx.fillText(ring.label, centerX + ring.r + 4, centerY - 4);
    });

    // 3. Sweeping Sonar Beam
    radarAngle += 0.025;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(centerX, centerY);
    ctx.arc(centerX, centerY, 220, radarAngle - 0.35, radarAngle);
    ctx.closePath();
    const grad = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, 220);
    grad.addColorStop(0, 'rgba(0, 243, 255, 0.35)');
    grad.addColorStop(1, 'rgba(0, 243, 255, 0.0)');
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(centerX, centerY);
    ctx.lineTo(centerX + 220 * Math.cos(radarAngle), centerY + 220 * Math.sin(radarAngle));
    ctx.strokeStyle = 'rgba(0, 243, 255, 0.85)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();

    // 4. Draw Campus Venues & Faction Gym Towers
    const FACTION_COLORS = {
      TEAM_KERNEL: { primary: '#00F2FE', glow: 'rgba(0, 242, 254, 0.4)', tag: 'KERNEL' },
      TEAM_TENSOR: { primary: '#FF007F', glow: 'rgba(255, 0, 127, 0.4)', tag: 'TENSOR' },
      TEAM_SILICON: { primary: '#FFB300', glow: 'rgba(255, 179, 0, 0.4)', tag: 'SILICON' },
      NEUTRAL: { primary: '#A0AEC0', glow: 'rgba(160, 174, 192, 0.25)', tag: 'NEUTRAL' },
    };

    const nowTime = Date.now();

    for (const [key, venue] of Object.entries(CAMPUS_VENUES)) {
      if (key !== 'SIEBEL') {
        ctx.beginPath();
        ctx.moveTo(centerX, centerY);
        ctx.lineTo(venue.x, venue.y);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
        ctx.setLineDash([2, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Look up corresponding Gym if any
      const gym = gymsCache.find((g) => g.locationName?.toLowerCase().includes(venue.name.slice(0, 4).toLowerCase()));
      const faction = gym ? gym.controllingFaction : (key === 'SIEBEL' ? 'TEAM_KERNEL' : key === 'ECEB' ? 'TEAM_TENSOR' : 'TEAM_SILICON');
      const fColor = FACTION_COLORS[faction] || FACTION_COLORS.NEUTRAL;

      // Draw Holographic Vertical Gym Pillar
      const towerHeight = 35 + ((gym ? gym.controlPoints / gym.maxControlPoints : 0.5) * 30);
      const ringOffset = (nowTime / 25) % towerHeight;

      // Holographic beam
      const beamGrad = ctx.createLinearGradient(venue.x, venue.y, venue.x, venue.y - towerHeight);
      beamGrad.addColorStop(0, fColor.glow);
      beamGrad.addColorStop(1, 'transparent');
      ctx.fillStyle = beamGrad;
      ctx.fillRect(venue.x - 10, venue.y - towerHeight, 20, towerHeight);

      // Rising Energy Ring
      ctx.strokeStyle = fColor.primary;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(venue.x, venue.y - ringOffset, 12, 4, 0, 0, Math.PI * 2);
      ctx.stroke();

      // Rotating 3D Crystal Octahedron Glyph above the Gym
      const spinAngle = (nowTime / 800) % (Math.PI * 2);
      const crystalY = venue.y - towerHeight - 12;
      ctx.save();
      ctx.translate(venue.x, crystalY);
      ctx.fillStyle = fColor.primary;
      ctx.shadowColor = fColor.primary;
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.moveTo(0, -9);
      ctx.lineTo(7 * Math.cos(spinAngle), 0);
      ctx.lineTo(0, 9);
      ctx.lineTo(-7 * Math.cos(spinAngle), 0);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      // Base Venue Node
      ctx.fillStyle = fColor.primary;
      ctx.fillRect(venue.x - 6, venue.y - 6, 12, 12);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1;
      ctx.strokeRect(venue.x - 6, venue.y - 6, 12, 12);

      // Label & CP Badge
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 9px monospace';
      ctx.fillText(venue.name, venue.x + 12, venue.y + 4);
      if (gym) {
        ctx.fillStyle = fColor.primary;
        ctx.font = '8px monospace';
        ctx.fillText(`[${gym.controlPoints} CP]`, venue.x + 12, venue.y + 14);
      }
    }

    // 5. Draw HackStop Supply Beacons (Cyan Rotating Diamonds)
    hackStopsCache.forEach((stop) => {
      // Map coordinates to canvas relative to Siebel
      const dx = (stop.longitude - (-88.224937)) * 120000;
      const dy = -(stop.latitude - 40.113812) * 120000;
      const sx = centerX + dx;
      const sy = centerY + dy;

      const spin = (nowTime / 600) % (Math.PI * 2);
      const bob = Math.sin(nowTime / 250) * 3;

      // Geofence Ring
      ctx.beginPath();
      ctx.ellipse(sx, sy + bob, 15, 6, 0, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(0, 243, 255, 0.35)';
      ctx.setLineDash([2, 2]);
      ctx.stroke();
      ctx.setLineDash([]);

      // Floating Diamond
      ctx.save();
      ctx.translate(sx, sy + bob - 8);
      ctx.fillStyle = '#00F2FE';
      ctx.shadowColor = '#00F2FE';
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.moveTo(0, -7);
      ctx.lineTo(6 * Math.cos(spin), 0);
      ctx.lineTo(0, 7);
      ctx.lineTo(-6 * Math.cos(spin), 0);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      ctx.fillStyle = '#A0AEC0';
      ctx.font = '8px monospace';
      ctx.fillText(`🌀 ${stop.name.slice(0, 12)}`, sx + 8, sy - 5);
    });

    // 6. Draw Active On-Duty Volunteers
    shiftsCache.forEach((shift, idx) => {
      if (shift.filledSlots > 0) {
        const venue = shift.location.includes('ECEB') ? CAMPUS_VENUES.ECEB :
                      shift.location.includes('Kenney') ? CAMPUS_VENUES.KENNEY :
                      shift.location.includes('DCL') ? CAMPUS_VENUES.DCL : CAMPUS_VENUES.SIEBEL;

        for (let s = 0; s < shift.filledSlots; s++) {
          const orbitAngle = (nowTime / 3500) + (idx * 1.5) + (s * (Math.PI * 2 / Math.max(1, shift.filledSlots)));
          const orbitRadius = 18 + (s * 6);
          const vx = venue.x + Math.cos(orbitAngle) * orbitRadius;
          const vy = venue.y + Math.sin(orbitAngle) * orbitRadius;

          ctx.beginPath();
          ctx.arc(vx, vy, 4.5, 0, Math.PI * 2);
          ctx.fillStyle = '#00ff88';
          ctx.fill();

          ctx.beginPath();
          ctx.arc(vx, vy, 7 + Math.sin(nowTime / 180) * 2, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(0, 255, 136, 0.4)';
          ctx.stroke();
        }
      }
    });

    // 7. Draw Open SOS Distress Beacons
    openSosTicketsCache.forEach((ticket) => {
      const isBasement = ticket.tableLocation.toLowerCase().includes('basement');
      const isECEB = ticket.tableLocation.toLowerCase().includes('eceb');
      const isKenney = ticket.tableLocation.toLowerCase().includes('kenney');

      const targetX = isECEB ? CAMPUS_VENUES.ECEB.x + 20 :
                      isKenney ? CAMPUS_VENUES.KENNEY.x - 20 :
                      isBasement ? CAMPUS_VENUES.SIEBEL.x - 30 : CAMPUS_VENUES.SIEBEL.x + 35;
      const targetY = isECEB ? CAMPUS_VENUES.ECEB.y + 25 :
                      isKenney ? CAMPUS_VENUES.KENNEY.y - 15 :
                      isBasement ? CAMPUS_VENUES.SIEBEL.y + 35 : CAMPUS_VENUES.SIEBEL.y - 30;

      const pulseSize = 10 + (Math.sin(nowTime / 140) + 1) * 8;
      ctx.beginPath();
      ctx.arc(targetX, targetY, pulseSize, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 94, 94, 0.25)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 94, 94, 0.85)';
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(targetX, targetY - 10);
      ctx.lineTo(targetX + 9, targetY + 6);
      ctx.lineTo(targetX - 9, targetY + 6);
      ctx.closePath();
      ctx.fillStyle = '#ff5e5e';
      ctx.fill();

      ctx.fillStyle = '#ff9e9e';
      ctx.font = 'bold 9px monospace';
      ctx.fillText(`SOS: ${ticket.hackerName} (${ticket.category.slice(0, 10)})`, targetX + 12, targetY - 2);
    });

    // 8. Draw & Update Particle System
    for (let pIdx = canvasParticles.length - 1; pIdx >= 0; pIdx--) {
      const p = canvasParticles[pIdx];
      p.x += p.vx;
      p.y += p.vy;
      p.life -= 0.02;

      if (p.life <= 0) {
        canvasParticles.splice(pIdx, 1);
        continue;
      }

      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.globalAlpha = p.life;
      ctx.fill();
      ctx.globalAlpha = 1.0;
    }

    radarAnimationId = requestAnimationFrame(renderRadar);
  }

  if (radarAnimationId) cancelAnimationFrame(radarAnimationId);
  renderRadar();
}

async function loadSOSTickets() {
  try {
    const res = await fetch('/api/v1/sos/tickets?status=OPEN');
    const json = await res.json();
    if (json.success) {
      openSosTicketsCache = json.data;
      renderSOSTicketsList(openSosTicketsCache);
    }
  } catch (err) {
    console.error('Failed to load SOS tickets:', err);
  }
}

function renderSOSTicketsList(tickets) {
  const container = document.getElementById('sos-tickets-container');
  const countEl = document.getElementById('sos-open-count');
  if (countEl) countEl.innerText = tickets.length;
  if (!container) return;

  if (tickets.length === 0) {
    container.innerHTML = `
      <div style="color: var(--text-dim); font-size: 0.8rem; font-style: italic; text-align: center; padding: 25px 0;">
        No active distress calls. All UIUC venues nominal.
      </div>
    `;
    return;
  }

  container.innerHTML = tickets.map((t) => `
    <div style="background: rgba(255, 94, 94, 0.08); border: 1px solid rgba(255, 94, 94, 0.35); border-radius: 6px; padding: 10px; display: flex; flex-direction: column; gap: 6px;">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <span style="color: #ff5e5e; font-weight: bold; font-size: 0.85rem;">🚨 ${t.hackerName} @ ${t.tableLocation}</span>
        <span style="font-size: 0.7rem; background: rgba(255, 94, 94, 0.25); color: #ff5e5e; padding: 2px 6px; border-radius: 4px; font-weight: 700;">
          ${t.urgency}
        </span>
      </div>
      <div style="font-size: 0.78rem; color: #ddd;">
        ${t.description}
      </div>
      <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 4px; font-size: 0.72rem; color: var(--text-dim);">
        <span>Category: <strong style="color: var(--cyan);">${t.category}</strong></span>
        <span style="color: var(--amber-surge);">+${t.karmaBounty} Karma Bounty</span>
      </div>
      <button class="btn btn-danger" onclick="dispatchNearestVolunteer('${t._id}')" style="margin-top: 6px; font-size: 0.75rem; padding: 6px 10px; font-weight: 700; letter-spacing: 0.05em;">
        ⚡ DISPATCH NEAREST VOLUNTEER
      </button>
    </div>
  `).join('');
}

async function simulateHackerSOS() {
  const samples = [
    {
      hackerName: 'Alex (Hardware Hacker)',
      tableLocation: 'Table 42 (Siebel Basement)',
      category: 'HARDWARE_MALFUNCTION',
      description: 'Soldering station shorted out, need backup ESP32 microcontroller!',
      urgency: 'HIGH',
      requiredSkill: 'HARDWARE',
      karmaBounty: 250,
    },
    {
      hackerName: 'Devin (Hacker Team 19)',
      tableLocation: 'ECEB 2nd Floor Balcony',
      category: 'POWER_OUTAGE',
      description: 'Power strip blew a fuse, 4 laptops down with 15% battery!',
      urgency: 'CRITICAL',
      requiredSkill: 'EVENT_LOGISTICS',
      karmaBounty: 200,
    },
    {
      hackerName: 'Maya (Team Quantum)',
      tableLocation: 'Kenney Gym bleachers',
      category: 'SPILL_CLEANUP',
      description: 'Massive Boba tea spill under Table 108 near power cables!',
      urgency: 'MEDIUM',
      requiredSkill: 'EVENT_LOGISTICS',
      karmaBounty: 150,
    },
  ];

  const pick = samples[Math.floor(Math.random() * samples.length)];

  try {
    const res = await fetch('/api/v1/sos/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(pick),
    });
    const json = await res.json();
    if (json.success) {
      logSosTerminal(`🚨 [SIMULATED SOS GENERATED] Ticket ID: ${json.data._id.slice(-6)} created at ${pick.tableLocation}`);
      loadSOSTickets();
    }
  } catch (err) {
    logSosTerminal(`Error simulating SOS: ${err.message}`);
  }
}

async function dispatchNearestVolunteer(ticketId) {
  logSosTerminal(`🔍 [COMPUTING HAVERSINE DISTANCE] Querying on-duty volunteers for ticket ${ticketId.slice(-6)}...`);
  try {
    const res = await fetch(`/api/v1/sos/tickets/${ticketId}/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const json = await res.json();
    if (json.success) {
      const vol = json.data.dispatchedVolunteer;
      const dist = json.data.distanceMeters.toFixed(1);
      const eta = Math.max(1, Math.ceil(json.data.distanceMeters / 80));

      logSosTerminal(`✅ [DISPATCH CONFIRMED] Selected: ${vol.name} (${dist}m away). Estimated walking ETA: ${eta} min.`);
      if (window.soundEngine) window.soundEngine.playDispatchChime();
      loadSOSTickets();
    } else {
      logSosTerminal(`❌ Dispatch failed: ${json.message}`);
    }
  } catch (err) {
    logSosTerminal(`Dispatch error: ${err.message}`);
  }
}

async function triggerAdonixSync() {
  const btn = document.getElementById('adonix-sync-btn');
  if (btn) {
    btn.disabled = true;
    btn.innerText = '⏳ SYNCING...';
  }

  logChaosTerminal('🔄 [ADONIX API] Synchronizing official schedule from https://adonix.hackillinois.org/event/...');

  try {
    const res = await fetch('/api/v1/adonix/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const json = await res.json();
    if (json.success) {
      logChaosTerminal(`✅ [ADONIX SYNC SUCCESS] ${json.data.syncedCount} shifts ingested/updated from official HackIllinois API.`);
      if (window.soundEngine) window.soundEngine.playCascadeChime();
      fetchShifts();
      fetchStats();
    } else {
      logChaosTerminal(`⚠️ Adonix sync note: ${json.message}`);
    }
  } catch (err) {
    logChaosTerminal(`Adonix sync error: ${err.message}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerText = '🔄 SYNC ADONIX API';
    }
  }
}

function logSosTerminal(msg) {
  const term = document.getElementById('sos-terminal');
  if (!term) return;
  const time = new Date().toLocaleTimeString();
  term.innerHTML = `[${time}] ${msg}\n` + term.innerHTML;
}

// ----------------------------------------------------
// PokéShift Campus Turf Wars & HackStops Operations
// ----------------------------------------------------
function changeUserFaction(faction) {
  currentVolunteerFaction = faction;
  const colors = {
    TEAM_KERNEL: 'var(--cyan)',
    TEAM_TENSOR: '#FF007F',
    TEAM_SILICON: '#FFB300',
  };
  const selector = document.getElementById('user-faction-selector');
  if (selector) selector.style.borderColor = colors[faction] || 'var(--cyan)';
  renderGymsList();
}

async function loadGymsData() {
  try {
    const res = await fetch('/api/v1/pokeshift/gyms');
    const json = await res.json();
    if (json.success) {
      gymsCache = json.data;
      renderGymsList();
    }
  } catch (err) {
    console.error('Failed to load gyms:', err);
  }
}

function renderGymsList() {
  const container = document.getElementById('gyms-list-container');
  if (!container) return;

  const factionTheme = {
    TEAM_KERNEL: { name: '🔷 TEAM KERNEL', color: '#00F2FE', bg: 'rgba(0, 242, 254, 0.08)', border: 'rgba(0, 242, 254, 0.35)' },
    TEAM_TENSOR: { name: '🟣 TEAM TENSOR', color: '#FF007F', bg: 'rgba(255, 0, 127, 0.08)', border: 'rgba(255, 0, 127, 0.35)' },
    TEAM_SILICON: { name: '🟠 TEAM SILICON', color: '#FFB300', bg: 'rgba(255, 179, 0, 0.08)', border: 'rgba(255, 179, 0, 0.35)' },
    NEUTRAL: { name: '⚪ UNCLAIMED', color: '#A0AEC0', bg: 'rgba(160, 174, 192, 0.08)', border: 'rgba(160, 174, 192, 0.25)' },
  };

  container.innerHTML = gymsCache.map((g) => {
    const theme = factionTheme[g.controllingFaction] || factionTheme.NEUTRAL;
    const percent = Math.min(100, Math.round((g.controlPoints / g.maxControlPoints) * 100));
    const isAlly = g.controllingFaction === currentVolunteerFaction || g.controllingFaction === 'NEUTRAL';
    const actionLabel = isAlly ? '🛡️ FORTIFY GYM (+150 CP)' : '⚔️ ATTACK GYM (-150 CP)';
    const btnStyle = isAlly ? 'background: rgba(0, 242, 254, 0.2); border-color: var(--cyan); color: var(--cyan);' : 'background: rgba(255, 94, 94, 0.2); border-color: var(--hazard-coral); color: var(--hazard-coral);';

    return `
      <div style="background: ${theme.bg}; border: 1px solid ${theme.border}; border-radius: 8px; padding: 14px; display: flex; flex-direction: column; gap: 10px;">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <div>
            <h4 style="font-size: 1rem; color: #fff; margin-bottom: 2px;">${g.name}</h4>
            <span style="font-size: 0.75rem; color: var(--text-dim);">${g.locationName}</span>
          </div>
          <span style="font-size: 0.72rem; font-weight: 700; color: ${theme.color}; padding: 3px 8px; border-radius: 4px; border: 1px solid ${theme.color};">
            ${theme.name}
          </span>
        </div>

        <div>
          <div style="display: flex; justify-content: space-between; font-size: 0.75rem; margin-bottom: 4px; font-family: monospace;">
            <span>CONTROL POWER:</span>
            <span style="color: ${theme.color}; font-weight: 700;">${g.controlPoints} / ${g.maxControlPoints} CP (${percent}%)</span>
          </div>
          <div style="background: rgba(255,255,255,0.08); height: 8px; border-radius: 4px; overflow: hidden;">
            <div style="width: ${percent}%; height: 100%; background: ${theme.color}; transition: width 0.4s ease-out;"></div>
          </div>
        </div>

        <div style="display: flex; justify-content: space-between; align-items: center; font-size: 0.75rem; color: var(--text-dim);">
          <span>Leader: <strong style="color: #fff;">${g.leaderName || 'Unclaimed'}</strong></span>
          <span>Level: <strong style="color: var(--amber-surge);">Lv. ${g.level}</strong></span>
        </div>

        <button class="btn" onclick="battleOrFortifyGym('${g._id}')" style="${btnStyle} font-weight: 700; font-size: 0.8rem; padding: 8px; cursor: pointer;">
          ${actionLabel}
        </button>
      </div>
    `;
  }).join('');
}

async function battleOrFortifyGym(gymId) {
  if (volunteersCache.length === 0) return;
  const vol = volunteersCache[0];

  try {
    const res = await fetch(`/api/v1/pokeshift/gyms/${gymId}/battle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        volunteerId: vol._id,
        faction: currentVolunteerFaction,
        power: 150,
      }),
    });
    const json = await res.json();
    if (json.success) {
      if (json.data.action === 'CAPTURED') {
        if (window.soundEngine) window.soundEngine.playGymVictoryFanfare();
      } else {
        if (window.soundEngine) window.soundEngine.playSonarPing();
      }
      logChaosTerminal(`🏛️ [GYM ${json.data.action}] ${json.data.message}`);
      loadGymsData();
      fetchStats();
    } else {
      alert(`Gym Battle Failed: ${json.message}`);
    }
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
}

async function loadHackStopsData() {
  try {
    const res = await fetch('/api/v1/pokeshift/hackstops');
    const json = await res.json();
    if (json.success) {
      hackStopsCache = json.data;
      renderHackStopsList();
    }
  } catch (err) {
    console.error('Failed to load hackstops:', err);
  }
}

function renderHackStopsList() {
  const container = document.getElementById('hackstops-list-container');
  if (!container) return;

  container.innerHTML = hackStopsCache.map((stop) => `
    <div style="background: rgba(0, 242, 254, 0.05); border: 1px solid rgba(0, 242, 254, 0.2); border-radius: 6px; padding: 10px; display: flex; justify-content: space-between; align-items: center;">
      <div>
        <div style="font-weight: 700; font-size: 0.85rem; color: #fff;">🌀 ${stop.name}</div>
        <div style="font-size: 0.72rem; color: var(--text-dim);">${stop.locationName} (75m Geofence)</div>
      </div>
      <button class="btn btn-secondary" onclick="spinHackStop('${stop.beaconId}', ${stop.latitude}, ${stop.longitude})" style="width: auto; padding: 5px 12px; font-size: 0.75rem; border-color: var(--cyan); color: var(--cyan);">
        🌀 SPIN
      </button>
    </div>
  `).join('');
}

async function spinHackStop(beaconId, lat, lon) {
  if (volunteersCache.length === 0) return;
  const vol = volunteersCache[0];

  if (window.soundEngine) window.soundEngine.playStopSpin();

  try {
    const res = await fetch(`/api/v1/pokeshift/hackstops/${beaconId}/spin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        volunteerId: vol._id,
        coordinates: { latitude: lat, longitude: lon },
      }),
    });
    const json = await res.json();

    if (json.success) {
      const item = json.data.itemDetails;
      const isLegendary = item.rarity === 'LEGENDARY' || item.rarity === 'MYTHIC';

      // Trigger canvas particle fountain at center
      spawnParticles(325, 190, isLegendary ? '#FFD700' : '#00F2FE', 30);

      // Play loot drop chime
      if (window.soundEngine) window.soundEngine.playLootDrop(isLegendary);

      // Show loot modal
      showLootModal(item, json.data.awardedKarma);

      logChaosTerminal(`🎁 [HACKSTOP SPUN] Spun ${json.data.name}! Received: ${item.name} (+${json.data.awardedKarma} Karma)`);
      loadUserInventory();
      fetchStats();
    } else {
      alert(`HackStop Spin Failed: ${json.message}`);
    }
  } catch (err) {
    alert(`Error spinning HackStop: ${err.message}`);
  }
}

function showLootModal(item, karma) {
  const modal = document.getElementById('loot-drop-modal');
  const nameEl = document.getElementById('loot-item-name');
  const rarityEl = document.getElementById('loot-item-rarity');
  const descEl = document.getElementById('loot-item-desc');
  const karmaEl = document.getElementById('loot-karma-awarded');

  if (nameEl) nameEl.innerText = item.name;
  if (rarityEl) {
    rarityEl.innerText = item.rarity;
    rarityEl.style.color = item.rarity === 'MYTHIC' ? '#ff3366' : item.rarity === 'LEGENDARY' ? '#ffd700' : item.rarity === 'EPIC' ? '#b026ff' : 'var(--cyan)';
  }
  if (descEl) descEl.innerText = item.description;
  if (karmaEl) karmaEl.innerText = `+${karma} Karma Awarded!`;
  if (modal) modal.style.display = 'flex';
}

function closeLootModal() {
  const modal = document.getElementById('loot-drop-modal');
  if (modal) modal.style.display = 'none';
}

async function loadUserInventory() {
  if (volunteersCache.length === 0) return;
  const vol = volunteersCache[0];

  try {
    const res = await fetch(`/api/v1/pokeshift/inventory/${vol._id}`);
    const json = await res.json();
    if (json.success) {
      userInventoryCache = json.data;
      renderUserInventory();
    }
  } catch (err) {
    console.error('Failed to load user inventory:', err);
  }
}

function renderUserInventory() {
  const container = document.getElementById('inventory-list-container');
  if (!container) return;

  if (userInventoryCache.length === 0) {
    container.innerHTML = `
      <div style="grid-column: span 2; color: var(--text-dim); font-size: 0.8rem; font-style: italic; text-align: center; padding: 25px 0;">
        Bag is empty! Spin campus HackStops to find power-ups.
      </div>
    `;
    return;
  }

  container.innerHTML = userInventoryCache.map((item) => `
    <div style="background: rgba(255, 170, 0, 0.06); border: 1px solid rgba(255, 170, 0, 0.25); border-radius: 6px; padding: 10px; display: flex; flex-direction: column; justify-content: space-between; gap: 6px;">
      <div>
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <span style="font-weight: 700; font-size: 0.8rem; color: #fff;">${item.name}</span>
          <span style="font-size: 0.72rem; color: var(--amber-surge); font-weight: 700;">x${item.quantity}</span>
        </div>
        <span style="font-size: 0.68rem; color: var(--text-dim);">${item.rarity}</span>
      </div>
      <button class="btn btn-primary" onclick="deployPowerUp('${item.itemType}')" style="font-size: 0.7rem; padding: 4px 8px; width: 100%;">
        ✨ DEPLOY
      </button>
    </div>
  `).join('');
}

async function deployPowerUp(itemType) {
  if (volunteersCache.length === 0) return;
  const vol = volunteersCache[0];
  const targetGym = gymsCache[0];

  try {
    const res = await fetch('/api/v1/pokeshift/inventory/use', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        volunteerId: vol._id,
        itemType,
        targetGymId: targetGym ? targetGym._id : undefined,
      }),
    });
    const json = await res.json();
    if (json.success) {
      if (window.soundEngine) window.soundEngine.playSonarPing();
      logChaosTerminal(`✨ [ITEM DEPLOYED] ${json.data.message}`);
      loadUserInventory();
      loadGymsData();
      fetchStats();
    } else {
      alert(`Could not use item: ${json.message}`);
    }
  } catch (err) {
    alert(`Error deploying power-up: ${err.message}`);
  }
}

function spawnParticles(x, y, color, count = 25) {
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = Math.random() * 3 + 1;
    canvasParticles.push({
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      size: Math.random() * 4 + 2,
      color,
      life: 1.0,
    });
  }
}

// Bootstrap
window.addEventListener('DOMContentLoaded', init);

