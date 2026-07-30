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
// Local paths (relative to repo root, after actions/checkout) to images YOU
// provide. These are read from disk and embedded directly into the SVG as
// base64 data — not referenced by URL — because browsers block an SVG
// loaded via <img src="...svg"> from fetching its own external resources.
// Embedding the bytes inline sidesteps that restriction entirely.
const HAND_IMAGE_PATH = process.env.HAND_IMAGE_PATH || "assets/spidermanhand.png";
const WEB_IMAGE_PATH = process.env.WEB_IMAGE_PATH || "assets/spidermanweb.png";

if (!USERNAME) {
  console.error("GH_USERNAME environment variable is required");
  process.exit(1);
}

// ---------- 0. Load local image assets as embeddable data URIs ----------

// Detects real image format from file signature bytes rather than trusting
// the filename extension — browser-saved images frequently mismatch their
// extension (e.g. a WebP download named "photo.png"), which causes the
// browser to reject the mismatched declared MIME type and show a broken
// image icon even though the file itself is perfectly valid.
function detectMimeType(buf) {
  const hex = (start, len) =>
    buf.subarray(start, start + len).toString("hex");

  if (hex(0, 8) === "89504e470d0a1a0a") return "image/png";
  if (hex(0, 3) === "ffd8ff") return "image/jpeg";
  if (hex(0, 4) === "52494646" && hex(8, 4) === "57454250") return "image/webp"; // RIFF....WEBP
  if (hex(0, 6) === "474946383761" || hex(0, 6) === "474946383961") return "image/gif"; // GIF87a / GIF89a
  return null; // unrecognized — caller decides how to handle
}

async function loadImageAsDataUri(relPath) {
  const fs = await import("node:fs/promises");
  let buf;
  try {
    buf = await fs.readFile(relPath);
  } catch (err) {
    throw new Error(
      `Could not read image at "${relPath}" (from repo root). ` +
        `Make sure the file exists at that exact path and is committed to the branch this workflow checks out. ` +
        `Original error: ${err.message}`
    );
  }

  const detected = detectMimeType(buf);
  const ext = relPath.split(".").pop().toLowerCase();
  const extGuess = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : ext === "gif" ? "image/gif" : "image/png";
  const mime = detected || extGuess;

  if (detected && detected !== extGuess) {
    console.warn(
      `Note: "${relPath}" has a .${ext} extension but its actual content is ${detected} — using the real format (${detected}) so the browser can decode it correctly.`
    );
  }
  if (!detected) {
    console.warn(`Warning: could not identify "${relPath}"'s format from its file signature — falling back to extension guess (${extGuess}). If it still fails to render, the file may be corrupted or an unsupported format.`);
  }

  return `data:${mime};base64,${buf.toString("base64")}`;
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

function renderHandIcon(dataUri) {
  // Embedded image data — sizing/offset tuned so the fingertip area (where
  // the pose's "shooter" point sits) lands near local origin (0,0), which
  // is where beams originate — adjust offsetX/offsetY if your image's
  // proportions place the hand differently within its frame.
  const w = 28;
  const h = 28;
  const offsetX = -w * 0.55;
  const offsetY = -h * 0.8;
  return `<image href="${dataUri}" x="${offsetX}" y="${offsetY}" width="${w}" height="${h}" />`;
}

function renderWebImpact(cx, cy, size, dataUri) {
  const x = cx - size / 2;
  const y = cy - size / 2;
  return `<image href="${dataUri}" x="${x}" y="${y}" width="${size}" height="${size}" />`;
}

function renderSVG({ gridDays, maxWeek, shots, loopMs, theme, handImageDataUri, webImageDataUri }) {
  const gridWidth = MARGIN_X * 2 + (maxWeek + 1) * PITCH;
  const gridHeight = MARGIN_Y * 2 + 7 * PITCH;
  const height = gridHeight + HAND_LANE;
  const handY = gridHeight + HAND_LANE / 2;

  const palette = PALETTE[theme];
  const accent = theme === "dark" ? "#f78166" : "#cf222e";

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
    .flatMap((s) => {
      const startFrac = (s.t + BEAM_MS) / loopMs;
      const endFrac = (s.t + BEAM_MS + GLOW_MS) / loopMs;
      const { keyTimes, values } = flashKeyframes(startFrac, endFrac, loopMs);

      // 3x3 block centered on the hit tile, clipped to valid grid bounds.
      const cells = [];
      for (let dw = -1; dw <= 1; dw++) {
        for (let dh = -1; dh <= 1; dh++) {
          const w = s.col + dw;
          const r = s.row + dh;
          if (w < 0 || w > maxWeek || r < 0 || r > 6) continue;
          cells.push({ w, r });
        }
      }

      return cells.map(({ w, r }) => {
        const baseLevel = dayLookup.get(`${w}-${r}`) ?? 0;
        const boostedLevel = Math.min(4, baseLevel + 1);
        const { x, y } = gridToPixel(w, r);
        return `<rect x="${x - CELL / 2}" y="${y - CELL / 2}" width="${CELL}" height="${CELL}" rx="2" fill="${palette[boostedLevel]}" opacity="0">
      <animate attributeName="opacity" keyTimes="${keyTimes}" values="${values}" dur="${loopMs}ms" repeatCount="indefinite" />
    </rect>`;
      });
    })
    .join("\n    ");

  const webBursts = shots
    .map((s) => {
      const startFrac = (s.t + BEAM_MS) / loopMs;
      const endFrac = (s.t + BEAM_MS + GLOW_MS) / loopMs;
      const { keyTimes, values } = flashKeyframes(startFrac, endFrac, loopMs);
      const impactSize = PITCH * 2.7; // sized to roughly span the 3x3 block
      return `<g opacity="0">
      <animate attributeName="opacity" keyTimes="${keyTimes}" values="${values}" dur="${loopMs}ms" repeatCount="indefinite" />
      ${renderWebImpact(s.x, s.y, impactSize, webImageDataUri)}
    </g>`;
    })
    .join("\n    ");

  return `<svg viewBox="0 0 ${gridWidth} ${height}" xmlns="http://www.w3.org/2000/svg" width="100%">
  <g>
    ${squares}
    ${highlights}
    ${webBursts}
    ${beams}
    <g>
      ${renderHandIcon(handImageDataUri)}
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

const handImageDataUri = await loadImageAsDataUri(HAND_IMAGE_PATH);
const webImageDataUri = await loadImageAsDataUri(WEB_IMAGE_PATH);
console.log(`Loaded ${HAND_IMAGE_PATH} (${Math.round(handImageDataUri.length / 1024)}KB as base64)`);
console.log(`Loaded ${WEB_IMAGE_PATH} (${Math.round(webImageDataUri.length / 1024)}KB as base64)`);

const fs = await import("node:fs/promises");
await fs.mkdir("dist", { recursive: true });

for (const theme of ["light", "dark"]) {
  const svg = renderSVG({ gridDays, maxWeek, shots, loopMs, theme, handImageDataUri, webImageDataUri });
  const outPath = `dist/web-sling-trail${theme === "dark" ? "-dark" : ""}.svg`;
  await fs.writeFile(outPath, svg, "utf8");
  console.log(`Wrote ${outPath}`);
}

console.log(`Grid: ${maxWeek + 1} weeks x 7 days (${gridDays.length} total days)`);
console.log(`Loop duration: ${loopMs}ms`);
console.log(`Shots fired per loop: ${shots.length}`);
console.log("Sample shots:", shots.slice(0, 3).map((s) => ({ t: Math.round(s.t), col: s.col, row: s.row, baseLevel: s.baseLevel, boostedLevel: s.boostedLevel })));
