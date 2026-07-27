// Web-Sling Trail — animated SVG generator for GitHub profile READMEs
// Renders your real contribution grid (same squares as your GitHub profile)
// with an animated web-sling trail swinging between your highest-activity
// days, overlaid directly on top of it — the same "something moves across
// my actual grid" effect as the snake animation, with a different mechanic.
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
      "User-Agent": "web-sling-trail-generator (github-action)",
      Accept: "text/html",
    },
  });
  if (!res.ok) {
    const bodySnippet = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`Failed to fetch contributions: HTTP ${res.status} ${res.statusText}\nBody snippet: ${bodySnippet}`);
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
// Adaptive: accumulate from the highest activity level downward until we
// have enough points for a visually rich trail, regardless of how active
// or quiet the year was.

function selectAnchors(gridDays, target = 14) {
  let picked = [];
  for (const level of [4, 3, 2, 1]) {
    picked = picked.concat(gridDays.filter((d) => d.level === level));
    if (picked.length >= target) break;
  }

  if (picked.length === 0) {
    const step = Math.max(1, Math.floor(gridDays.length / 8));
    return gridDays.filter((_, i) => i % step === 0);
  }

  picked.sort((a, b) => a.date - b.date);

  if (picked.length > 20) {
    const step = picked.length / 18;
    picked = Array.from({ length: 18 }, (_, i) => picked[Math.floor(i * step)]);
  }
  return picked;
}

// ---------- 4. Geometry ----------

const CELL = 11;
const GAP = 3;
const PITCH = CELL + GAP;
const MARGIN_X = 16;
const MARGIN_Y = 16;

function gridToPixel(d) {
  return {
    x: MARGIN_X + d.week * PITCH,
    y: MARGIN_Y + d.weekday * PITCH,
  };
}

function buildTrailPath(anchors) {
  const pts = anchors.map(gridToPixel);
  let d = `M ${pts[0].x},${pts[0].y}`;
  for (let i = 1; i < pts.length; i++) {
    const prev = pts[i - 1];
    const curr = pts[i];
    const dx = curr.x - prev.x;
    const arcHeight = Math.min(40, Math.max(12, Math.abs(dx) * 0.5));
    const cx = (prev.x + curr.x) / 2;
    const cy = Math.min(prev.y, curr.y) - arcHeight;
    d += ` Q ${cx},${cy} ${curr.x},${curr.y}`;
  }
  return { d, pts };
}

// ---------- 5. Render SVG ----------
// GitHub's own contribution-square palette, so the background reads as
// "your real grid" at a glance rather than a generic heatmap.

const PALETTE = {
  light: ["#ebedf0", "#9be9a8", "#40c463", "#30a14e", "#216e39"],
  dark: ["#161b22", "#0e4429", "#006d32", "#26a641", "#39d353"],
};

function renderSVG({ gridDays, trail, theme }) {
  const maxWeek = Math.max(...gridDays.map((d) => d.week));
  const width = MARGIN_X * 2 + (maxWeek + 1) * PITCH;
  const height = MARGIN_Y * 2 + 7 * PITCH;

  const palette = PALETTE[theme];
  const accent = theme === "dark" ? "#f78166" : "#cf222e"; // web-trail color, distinct from the green grid
  const marker = theme === "dark" ? "#f0f6fc" : "#0d1117";

  const squares = gridDays
    .map((d) => {
      const { x, y } = gridToPixel(d);
      return `<rect x="${x - CELL / 2}" y="${y - CELL / 2}" width="${CELL}" height="${CELL}" rx="2" fill="${palette[d.level]}" />`;
    })
    .join("\n    ");

  const totalDurationMs = Math.round(6000 * trail.pts.length * SPEED_FACTOR);

  return `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" width="100%">
  <style>
    .trail { fill: none; stroke: ${accent}; stroke-width: 1.5; stroke-dasharray: 4 3; opacity: 0.9; }
    .marker { fill: ${marker}; }
  </style>
  <g>
    ${squares}
    <path id="trail" class="trail" d="${trail.d}" />
    <circle class="marker" r="4">
      <animateMotion dur="${totalDurationMs}ms" repeatCount="indefinite" rotate="auto">
        <mpath href="#trail" />
      </animateMotion>
    </circle>
  </g>
</svg>`;
}

// ---------- Run ----------
// Fetch once, render both theme variants from the same data so the
// light/dark SVGs stay perfectly in sync with each other.

const days = await fetchContributions(USERNAME);
const gridDays = toGrid(days);
const anchors = selectAnchors(gridDays);
const trail = buildTrailPath(anchors);

const fs = await import("node:fs/promises");
await fs.mkdir("dist", { recursive: true });

for (const theme of ["light", "dark"]) {
  const svg = renderSVG({ gridDays, trail, theme });
  const outPath = `dist/web-sling-trail${theme === "dark" ? "-dark" : ""}.svg`;
  await fs.writeFile(outPath, svg, "utf8");
  console.log(`Wrote ${outPath}`);
}

const maxWeek = Math.max(...gridDays.map((d) => d.week));
console.log(`Grid: ${maxWeek + 1} weeks x 7 days (${gridDays.length} total days)`);
console.log(`Anchors selected: ${anchors.length}`);
console.log(`Canvas size: ${MARGIN_X * 2 + (maxWeek + 1) * PITCH} x ${MARGIN_Y * 2 + 7 * PITCH}`);
console.log(`Loop duration: ${Math.round(6000 * trail.pts.length * SPEED_FACTOR)}ms`);
