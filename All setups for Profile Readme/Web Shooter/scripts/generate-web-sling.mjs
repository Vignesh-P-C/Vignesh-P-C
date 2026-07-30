// Web-Shooter Grid Hits — animated SVG generator for GitHub profile READMEs
// Renders your real contribution grid, with an abstract hand icon traveling
// left-to-right along the bottom, firing vertical "web" shots upward at
// random intervals. Each shot hits a random row in the hand's current
// column; the hit tile brightens by one contribution-intensity level for
// ~2 seconds, then reverts.
//
// Data source: https://github.com/users/{username}/contributions
// This is the same public, unauthenticated endpoint GitHub uses to render
// the contribution calendar on profile pages — no token or GraphQL scope needed.

const USERNAME = process.env.GH_USERNAME;
const SPEED_FACTOR = Number(process.env.SPEED_FACTOR || 1.5);

if (!USERNAME) {
  console.error("GH_USERNAME environment variable is required");
  process.exit(1);
}

// ---------- 1. Fetch + parse contribution data ----------

async function fetchContributions(username) {
  const res = await fetch(`https://github.com/users/${username}/contributions`, {
    headers: {
      "User-Agent": "web-shooter-grid-hits-generator (github-action)",
      Accept: "text/html",
    },
  });
  if (!res.ok) {
    const bodySnippet = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`Failed to fetch contributions: HTTP ${res.status} ${res.statusText}\nBody snippet: ${bodySnippet}`);
  }
  const html = await res.text();

  const tdRegex = /<td[^>]*data-date="(\d{4}-\d{2}-\d{2})"[^>]*data-level="(\d)"[^>]*>/g;
  const days = [];
  let match;
  while ((match = tdRegex.exec(html)) !== null) {
    days.push({ date: new Date(match[1] + "T00:00:00Z"), level: Number(match[2]) });
  }

  if (days.length === 0) {
    throw new Error("No contribution cells found — GitHub markup may have changed, or the profile/user does not exist");
  }

  days.sort((a, b) => a.date - b.date);
  return days;
}

// ---------- 2. Map calendar dates to grid coordinates ----------

function toGrid(days) {
  const firstDate = days[0].date;
  const firstSunday = new Date(firstDate);
  firstSunday.setUTCDate(firstDate.getUTCDate() - firstDate.getUTCDay());

  return days.map((d) => {
    const diffDays = Math.round((d.date - firstSunday) / 86400000);
    return {
      ...d,
      week: Math.floor(diffDays / 7),
      weekday: d.date.getUTCDay(), // 0 = Sunday .. 6 = Saturday
    };
  });
}

// ---------- 3. Geometry ----------

const CELL = 11;
const GAP = 3;
const PITCH = CELL + GAP;
const MARGIN_X = 16;
const MARGIN_Y = 16;
const HAND_LANE = 34; // extra space below the grid for the hand to travel in

function gridToPixel(week, weekday) {
  return {
    x: MARGIN_X + week * PITCH,
    y: MARGIN_Y + weekday * PITCH,
  };
}

// ---------- 4. Generate shot events ----------
// Precomputed at build time so the "randomness" is baked into fixed SMIL
// keyframes — each shot fires at a random-ish time along the hand's sweep,
// at the hand's then-current column, targeting a random row.

const BEAM_MS = 260; // how long the beam flash lasts
const GLOW_MS = 2000; // how long the hit tile stays brightened

function buildShots({ maxWeek, loopMs, dayLookup }) {
  const travelWidth = maxWeek * PITCH; // hand moves from week 0 to maxWeek
  const numShots = Math.min(18, Math.max(8, Math.round((maxWeek + 1) / 4)));

  // Reserve a trailing buffer so every shot's glow finishes within one loop.
  const usableMs = loopMs - (BEAM_MS + GLOW_MS + 300);
  const slot = usableMs / numShots;

  const shots = [];
  for (let i = 0; i < numShots; i++) {
    const jitter = (Math.random() - 0.5) * slot * 0.7;
    const t = Math.max(0, Math.min(usableMs, i * slot + slot / 2 + jitter));

    const handX = MARGIN_X + (t / loopMs) * travelWidth;
    const col = Math.max(0, Math.min(maxWeek, Math.round((handX - MARGIN_X) / PITCH)));
    const row = Math.floor(Math.random() * 7);

    const baseLevel = dayLookup.get(`${col}-${row}`) ?? 0;
    const boostedLevel = Math.min(4, baseLevel + 1);
    const { x, y } = gridToPixel(col, row);

    shots.push({ t, x, y, col, row, baseLevel, boostedLevel });
  }
  return shots;
}

// ---------- 5. Render SVG ----------

const PALETTE = {
  light: ["#ebedf0", "#9be9a8", "#40c463", "#30a14e", "#216e39"],
  dark: ["#161b22", "#0e4429", "#006d32", "#26a641", "#39d353"],
};

// Builds a SMIL keyTimes/values pair for a single flash: invisible, snap to
// visible at `startFrac`, hold, snap back to invisible at `endFrac`.
function flashKeyframes(startFrac, endFrac, loopMs) {
  const eps = Math.max(0.0004, 3 / loopMs);
  const s = Math.max(0.0001, Math.min(0.999, startFrac));
  const e = Math.max(s + eps * 2, Math.min(0.9995, endFrac));
  const keyTimes = [0, s, s + eps, e, 1];
  const values = [0, 0, 1, 0, 0];
  return {
    keyTimes: keyTimes.map((v) => v.toFixed(6)).join(";"),
    values: values.join(";"),
  };
}

function renderHandIcon(color) {
  // Abstract geometric glove/fist — deliberately generic, not a reproduction
  // of any specific costume design. Local origin (0,0) is the web-shooter
  // aperture, so translating this group aims shots from the right spot.
  return `
    <g fill="${color}">
      <rect x="-6" y="0" width="12" height="14" rx="4" />
      <rect x="-8" y="12" width="16" height="8" rx="3" />
      <rect x="-3" y="-6" width="4" height="8" rx="2" />
      <rect x="1.5" y="-7" width="4" height="9" rx="2" />
      <rect x="-7.5" y="-4" width="4" height="7" rx="2" />
      <circle cx="0" cy="-6" r="2" fill="none" stroke="${color}" stroke-width="1" />
    </g>`;
}

function renderSVG({ gridDays, maxWeek, shots, loopMs, theme }) {
  const gridWidth = MARGIN_X * 2 + (maxWeek + 1) * PITCH;
  const gridHeight = MARGIN_Y * 2 + 7 * PITCH;
  const height = gridHeight + HAND_LANE;
  const handY = gridHeight + HAND_LANE / 2;

  const palette = PALETTE[theme];
  const accent = theme === "dark" ? "#f78166" : "#cf222e";
  const handColor = theme === "dark" ? "#c9d1d9" : "#24292f";

  const squares = gridDays
    .map((d) => {
      const { x, y } = gridToPixel(d.week, d.weekday);
      return `<rect x="${x - CELL / 2}" y="${y - CELL / 2}" width="${CELL}" height="${CELL}" rx="2" fill="${palette[d.level]}" />`;
    })
    .join("\n    ");

  const beams = shots
    .map((s) => {
      const startFrac = s.t / loopMs;
      const endFrac = (s.t + BEAM_MS) / loopMs;
      const { keyTimes, values } = flashKeyframes(startFrac, endFrac, loopMs);
      return `<line x1="${s.x}" y1="${handY - 8}" x2="${s.x}" y2="${s.y}" stroke="${accent}" stroke-width="1.5" stroke-dasharray="3 2" opacity="0">
      <animate attributeName="opacity" keyTimes="${keyTimes}" values="${values}" dur="${loopMs}ms" repeatCount="indefinite" />
    </line>`;
    })
    .join("\n    ");

  const highlights = shots
    .map((s) => {
      const startFrac = (s.t + BEAM_MS) / loopMs;
      const endFrac = (s.t + BEAM_MS + GLOW_MS) / loopMs;
      const { keyTimes, values } = flashKeyframes(startFrac, endFrac, loopMs);
      return `<rect x="${s.x - CELL / 2}" y="${s.y - CELL / 2}" width="${CELL}" height="${CELL}" rx="2" fill="${palette[s.boostedLevel]}" opacity="0">
      <animate attributeName="opacity" keyTimes="${keyTimes}" values="${values}" dur="${loopMs}ms" repeatCount="indefinite" />
    </rect>`;
    })
    .join("\n    ");

  return `<svg viewBox="0 0 ${gridWidth} ${height}" xmlns="http://www.w3.org/2000/svg" width="100%">
  <g>
    ${squares}
    ${highlights}
    ${beams}
    <g>
      ${renderHandIcon(handColor)}
      <animateMotion dur="${loopMs}ms" repeatCount="indefinite"
        path="M ${MARGIN_X},${handY} L ${MARGIN_X + maxWeek * PITCH},${handY}" />
    </g>
  </g>
</svg>`;
}

// ---------- Run ----------

const days = await fetchContributions(USERNAME);
const gridDays = toGrid(days);
const maxWeek = Math.max(...gridDays.map((d) => d.week));

const dayLookup = new Map(gridDays.map((d) => [`${d.week}-${d.weekday}`, d.level]));

const loopMs = Math.round((maxWeek + 1) * 350 * SPEED_FACTOR);
const shots = buildShots({ maxWeek, loopMs, dayLookup });

const fs = await import("node:fs/promises");
await fs.mkdir("dist", { recursive: true });

for (const theme of ["light", "dark"]) {
  const svg = renderSVG({ gridDays, maxWeek, shots, loopMs, theme });
  const outPath = `dist/web-sling-trail${theme === "dark" ? "-dark" : ""}.svg`;
  await fs.writeFile(outPath, svg, "utf8");
  console.log(`Wrote ${outPath}`);
}

console.log(`Grid: ${maxWeek + 1} weeks x 7 days (${gridDays.length} total days)`);
console.log(`Loop duration: ${loopMs}ms`);
console.log(`Shots fired per loop: ${shots.length}`);
console.log("Sample shots:", shots.slice(0, 3).map((s) => ({ t: Math.round(s.t), col: s.col, row: s.row, baseLevel: s.baseLevel, boostedLevel: s.boostedLevel })));
