// Web-Sling Trail — animated SVG generator for GitHub profile READMEs
// Draws a continuous swinging bezier arc connecting a user's highest-activity
// contribution days across the past year, with a marker animating along it.
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
  const res = await fetch(`https://github.com/users/${username}/contributions`);
  if (!res.ok) {
    throw new Error(`Failed to fetch contributions: HTTP ${res.status}`);
  }
  const html = await res.text();

  // Match each <td ...> that carries both data-date and data-level,
  // scoped to a single tag (no ">" in between) so we never bleed into
  // a neighboring cell.
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
// Mirrors GitHub's own layout: columns = weeks (Sunday-aligned), rows = weekday.

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

// ---------- 3. Select anchor points (peaks) ----------
// Adaptive threshold: aim for roughly 10-18 anchors regardless of how
// active or quiet the year was, so the trail always reads cleanly.

function selectAnchors(gridDays, target = 14) {
  // Accumulate from the highest activity level downward until we have
  // enough points for a visually rich trail, rather than stopping at the
  // first threshold that clears a bare minimum.
  let picked = [];
  for (const level of [4, 3, 2, 1]) {
    picked = picked.concat(gridDays.filter((d) => d.level === level));
    if (picked.length >= target) break;
  }

  if (picked.length === 0) {
    // Degenerate case: no recorded contributions at all. Fall back to a
    // few evenly spaced points so the animation still renders something.
    const step = Math.max(1, Math.floor(gridDays.length / 8));
    return gridDays.filter((_, i) => i % step === 0);
  }

  picked.sort((a, b) => a.date - b.date);

  // Cap density so the trail doesn't become an unreadable tangle.
  if (picked.length > 20) {
    const step = picked.length / 18;
    picked = Array.from({ length: 18 }, (_, i) => picked[Math.floor(i * step)]);
  }
  return picked;
}

// ---------- 4. Build the bezier trail path ----------

const CELL = 11;
const GAP = 3;
const PITCH = CELL + GAP;
const MARGIN_X = 20;
const MARGIN_Y = 20;

function gridToPixel(d) {
  return {
    x: MARGIN_X + d.week * PITCH,
    y: MARGIN_Y + d.weekday * PITCH,
  };
}

function buildPath(anchors) {
  const raw = anchors.map(gridToPixel);
  // Normalize so the trail always starts near the left margin, regardless
  // of which week of the year the first anchor falls on — otherwise a
  // user whose peak days cluster late in the year gets a mostly-blank canvas.
  const minX = Math.min(...raw.map((p) => p.x));
  const pts = raw.map((p) => ({ x: p.x - minX + MARGIN_X, y: p.y }));

  let d = `M ${pts[0].x},${pts[0].y}`;
  for (let i = 1; i < pts.length; i++) {
    const prev = pts[i - 1];
    const curr = pts[i];
    const dx = curr.x - prev.x;
    const arcHeight = Math.min(45, Math.max(15, dx * 0.5));
    const cx = (prev.x + curr.x) / 2;
    const cy = Math.min(prev.y, curr.y) - arcHeight;
    d += ` Q ${cx},${cy} ${curr.x},${curr.y}`;
  }
  return { d, pts };
}

// ---------- 5. Render SVG ----------

function renderSVG({ d, pts }, theme) {
  const width = Math.max(...pts.map((p) => p.x)) + MARGIN_X;
  const height = Math.max(...pts.map((p) => p.y)) + MARGIN_Y + 20;

  const colors =
    theme === "dark"
      ? { bg: "transparent", trail: "#58a6ff", dot: "#f0f6fc", anchor: "#30363d" }
      : { bg: "transparent", trail: "#0969da", dot: "#0d1117", anchor: "#d0d7de" };

  const totalDurationMs = Math.round(6000 * pts.length * SPEED_FACTOR);

  const anchorDots = pts
    .map((p) => `<circle cx="${p.x}" cy="${p.y}" r="2.5" fill="${colors.anchor}" />`)
    .join("\n    ");

  return `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" width="100%">
  <style>
    .trail { fill: none; stroke: ${colors.trail}; stroke-width: 1.5; stroke-dasharray: 4 3; opacity: 0.85; }
    .marker { fill: ${colors.dot}; }
  </style>
  <g>
    ${anchorDots}
    <path id="trail" class="trail" d="${d}" />
    <circle class="marker" r="4">
      <animateMotion dur="${totalDurationMs}ms" repeatCount="indefinite" rotate="auto">
        <mpath href="#trail" />
      </animateMotion>
    </circle>
  </g>
</svg>`;
}

// ---------- Run ----------
// Fetch once, render both theme variants from the same anchor set so the
// light/dark SVGs stay perfectly in sync with each other.

const days = await fetchContributions(USERNAME);
const gridDays = toGrid(days);
const anchors = selectAnchors(gridDays);
const { d, pts } = buildPath(anchors);

const fs = await import("node:fs/promises");
await fs.mkdir("dist", { recursive: true });

for (const theme of ["light", "dark"]) {
  const svg = renderSVG({ d, pts }, theme);
  const outPath = `dist/web-sling-trail${theme === "dark" ? "-dark" : ""}.svg`;
  await fs.writeFile(outPath, svg, "utf8");
  console.log(`Wrote ${outPath}`);
}

console.log(`Anchors selected: ${anchors.length}`);
console.log(`Canvas size: ${Math.max(...pts.map((p) => p.x)) + MARGIN_X} x ${Math.max(...pts.map((p) => p.y)) + MARGIN_Y + 20}`);
console.log(`Loop duration: ${Math.round(6000 * pts.length * SPEED_FACTOR)}ms`);
