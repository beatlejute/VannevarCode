// The extension icon, drawn rather than shipped: a relay — two contacts and the armature between them,
// thrown to one side. It is what the extension does to a tab, and it is what Shannon was pointed at in
// 1936, which is where the name comes from. No logo of anybody else's is anywhere near it.
//
//   node scripts/make-icon.mjs        # writes images/icon.png at 256×256
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
const LIVE = [255, 168, 76, 255];

const px = new Uint8Array(N * N * 4);
for (let i = 0; i < N * N; i++) px.set(GROUND, i * 4);

function blend(x, y, color, alpha) {
    if (x < 0 || y < 0 || x >= N || y >= N || alpha <= 0) return;
    const i = (y * N + x) * 4;
    for (let c = 0; c < 3; c++) px[i + c] = Math.round(px[i + c] * (1 - alpha) + color[c] * alpha);
    px[i + 3] = 255;
}

// Distance from a point to a segment, which is all the drawing this needs: every stroke is a capsule
function segmentDistance(px0, py0, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    const length = dx * dx + dy * dy;
    const t = length ? Math.max(0, Math.min(1, ((px0 - ax) * dx + (py0 - ay) * dy) / length)) : 0;
    return Math.hypot(px0 - (ax + t * dx), py0 - (ay + t * dy));
}

function stroke(ax, ay, bx, by, width, color) {
    const r = width / 2;
    const [x0, x1] = [Math.min(ax, bx) - r - 2, Math.max(ax, bx) + r + 2];
    const [y0, y1] = [Math.min(ay, by) - r - 2, Math.max(ay, by) + r + 2];
    for (let y = Math.floor(y0); y <= Math.ceil(y1); y++)
        for (let x = Math.floor(x0); x <= Math.ceil(x1); x++) {
            const d = segmentDistance(x + 0.5, y + 0.5, ax, ay, bx, by);
            blend(x, y, color, Math.max(0, Math.min(1, r - d + 0.5)));
        }
}

function disc(cx, cy, r, color) {
    for (let y = Math.floor(cy - r - 2); y <= Math.ceil(cy + r + 2); y++)
        for (let x = Math.floor(cx - r - 2); x <= Math.ceil(cx + r + 2); x++) {
            const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
            blend(x, y, color, Math.max(0, Math.min(1, r - d + 0.5)));
        }
}

const u = N / 16; // one unit of the 16-column grid the shape is laid out on

// The two contacts, one above the other on the right
const contactX = 10.2 * u;
const upper = 4.4 * u;
const lower = 10.8 * u;
stroke(contactX, upper, 14.2 * u, upper, 0.8 * u, LINE);
stroke(contactX, lower, 14.2 * u, lower, 0.8 * u, LIVE);

// The pivot on the left, and the armature thrown down onto the live contact
const pivotX = 3.4 * u;
const pivotY = 7.2 * u;
stroke(pivotX, pivotY, contactX + 0.6 * u, lower, 0.9 * u, LIVE);
disc(pivotX, pivotY, 1.1 * u, LINE);
disc(pivotX, pivotY, 0.45 * u, GROUND);

// The coil that throws it: three turns under the pivot
for (let i = 0; i < 3; i++) {
    const y = (11.6 + i * 1.3) * u;
    stroke(2.6 * u, y, 7.2 * u, y, 0.55 * u, LINE);
}
stroke(2.6 * u, 11.6 * u, 2.6 * u, 14.2 * u, 0.55 * u, LINE);

// The line in: from the left edge to the pivot
stroke(1.4 * u, pivotY, pivotX - 0.9 * u, pivotY, 0.8 * u, LINE);

const small = resizeRgba(px, N, N, SIZE, SIZE);
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'images', 'icon.png');
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, rgbaToPng(SIZE, SIZE, small));
console.log(`${path.relative(process.cwd(), out)}: ${SIZE}×${SIZE}`);
