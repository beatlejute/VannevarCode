// The extension icon, drawn rather than shipped: a rotary selector seen from the front — a spindle,
// eight contacts around it and the blade thrown onto one of them. It is literally what the extension
// does to a tab, and it is the switching Shannon was pointed at in 1936, which is where the name and
// the whole story in the README come from.
//
//   node scripts/make-icon.mjs        # writes images/icon.png at 256×256
//
// The silhouette is radial because a selector is radial, and that is the whole of the resemblance to
// anybody else's mark: a starburst is tapered rays and nothing in the middle, this is a hub with
// terminals on the ends, in two weights, with one arm thrown off-centre. Nobody's logo is traced,
// borrowed or recoloured here — see "Trademark hygiene" in docs/vannevar-code-plan.md.
//
// Drawn at 4× and box-filtered down, because the alternative is either aliasing or a dependency.
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { rgbaToPng, resizeRgba } from './png.mjs';

const SIZE = 256;
const SCALE = 4;
const N = SIZE * SCALE;

// Ink on a deep ground: readable as a 16-pixel tab favicon and as a gallery tile, in either theme
const GROUND = [22, 25, 33, 255];
const LINE = [233, 236, 244, 255];
const DIM = [96, 104, 124, 255];
const LIVE = [255, 168, 76, 255];

const px = new Uint8Array(N * N * 4);
for (let i = 0; i < N * N; i++) px.set(GROUND, i * 4);

function blend(x, y, color, alpha) {
    if (x < 0 || y < 0 || x >= N || y >= N || alpha <= 0) return;
    const i = (y * N + x) * 4;
    for (let c = 0; c < 3; c++) px[i + c] = Math.round(px[i + c] * (1 - alpha) + color[c] * alpha);
    px[i + 3] = 255;
}

// Every stroke is a capsule, so the whole drawing is "distance to a segment" — with the width allowed
// to taper along it, which is what turns the wiper from a bar into an arm.
function stroke(ax, ay, bx, by, w0, w1, color) {
    const r = Math.max(w0, w1) / 2;
    const dx = bx - ax;
    const dy = by - ay;
    const length = dx * dx + dy * dy;
    for (let y = Math.floor(Math.min(ay, by) - r - 2); y <= Math.ceil(Math.max(ay, by) + r + 2); y++)
        for (let x = Math.floor(Math.min(ax, bx) - r - 2); x <= Math.ceil(Math.max(ax, bx) + r + 2); x++) {
            const t = length ? Math.max(0, Math.min(1, ((x + 0.5 - ax) * dx + (y + 0.5 - ay) * dy) / length)) : 0;
            const d = Math.hypot(x + 0.5 - (ax + t * dx), y + 0.5 - (ay + t * dy));
            const half = (w0 + (w1 - w0) * t) / 2;
            blend(x, y, color, Math.max(0, Math.min(1, half - d + 0.5)));
        }
}

function disc(cx, cy, r, color) {
    for (let y = Math.floor(cy - r - 2); y <= Math.ceil(cy + r + 2); y++)
        for (let x = Math.floor(cx - r - 2); x <= Math.ceil(cx + r + 2); x++) {
            const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
            blend(x, y, color, Math.max(0, Math.min(1, r - d + 0.5)));
        }
}

function ring(cx, cy, r, width, color, from = 0, to = Math.PI * 2) {
    const steps = Math.ceil((to - from) * r);
    for (let i = 0; i < steps; i++) {
        const a = from + ((to - from) * i) / steps;
        const b = from + ((to - from) * (i + 1)) / steps;
        stroke(cx + Math.cos(a) * r, cy + Math.sin(a) * r, cx + Math.cos(b) * r, cy + Math.sin(b) * r, width, width, color);
    }
}

const u = N / 16; // one unit of the 16-column grid the shape is laid out on
const cx = 8 * u;
const cy = 8 * u;

// Eight positions, the live one at the upper right. Twelve o'clock is deliberately not a position:
// a dial whose first stop is off-axis reads as a selector rather than as a star.
const POSITIONS = 8;
const LIVE_AT = 7; // counting clockwise from the one just right of the top
const START = -Math.PI / 2 + Math.PI / POSITIONS;
const CONTACT_R = 5.5 * u;

// No rim. A ring closes the shape into a wheel, and a wheel is a thing that turns rather than a thing
// that chooses; without it the eight contacts float and the only closed path is the live one.

// One spoke per position — the wiring a selector has inside it, and the reason the silhouette is
// radial at all. Dim and thin except the one carrying current, which is the whole statement: the
// symmetry is there to be broken by which way the switch is thrown.
for (let i = 0; i < POSITIONS; i++) {
    const a = START + (Math.PI * 2 * i) / POSITIONS;
    const live = i === LIVE_AT;
    if (live) continue;
    stroke(
        cx + Math.cos(a) * 2.6 * u,
        cy + Math.sin(a) * 2.6 * u,
        cx + Math.cos(a) * (CONTACT_R - 0.85 * u),
        cy + Math.sin(a) * (CONTACT_R - 0.85 * u),
        0.72 * u,
        0.3 * u,
        DIM,
    );
    disc(cx + Math.cos(a) * CONTACT_R, cy + Math.sin(a) * CONTACT_R, 0.52 * u, LINE);
}

// The closed position: the wiper, thrown onto its contact and touching it
const liveAngle = START + (Math.PI * 2 * LIVE_AT) / POSITIONS;
stroke(
    cx,
    cy,
    cx + Math.cos(liveAngle) * CONTACT_R,
    cy + Math.sin(liveAngle) * CONTACT_R,
    1.6 * u,
    0.7 * u,
    LIVE,
);
disc(cx + Math.cos(liveAngle) * CONTACT_R, cy + Math.sin(liveAngle) * CONTACT_R, 1.05 * u, LIVE);
disc(cx + Math.cos(liveAngle) * CONTACT_R, cy + Math.sin(liveAngle) * CONTACT_R, 0.36 * u, GROUND);

// The spindle
disc(cx, cy, 1.6 * u, LINE);
disc(cx, cy, 0.66 * u, GROUND);

const small = resizeRgba(px, N, N, SIZE, SIZE);
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'images', 'icon.png');
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, rgbaToPng(SIZE, SIZE, small));
console.log(`${path.relative(process.cwd(), out)}: ${SIZE}×${SIZE}`);
