// Builds the Kurama logo, favicons, wordmarks and og.png into public/. Run: npm run brand
// ponytail: uses the macOS Arial Rounded font for PNG text; point `font` at a TTF elsewhere.
import { writeFileSync, mkdirSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";

const pub = new URL("../public", import.meta.url).pathname;
mkdirSync(`${pub}/brand`, { recursive: true });

const grad = `
  <linearGradient id="fireV" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#D62B1F"/><stop offset=".55" stop-color="#FF6A1A"/><stop offset="1" stop-color="#FFA23A"/></linearGradient>
  <linearGradient id="tail" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="-62"><stop offset="0" stop-color="#C8231B"/><stop offset=".55" stop-color="#FF6A1A"/><stop offset="1" stop-color="#FFB347"/></linearGradient>`;

const head = `
  <path d="M34 56 C28 40 28 24 34 14 C46 20 56 32 60 44 Z M94 56 C100 40 100 24 94 14 C82 20 72 32 68 44 Z" fill="#FF6A1A"/>
  <path d="M37 48 C34 38 34 28 37 22 C44 27 50 34 53 42 Z M91 48 C94 38 94 28 91 22 C84 27 78 34 75 42 Z" fill="#C8231B"/>
  <path d="M64 40 C92 40 108 58 106 78 C104 98 86 110 64 110 C42 110 24 98 22 78 C20 58 36 40 64 40Z" fill="#FF7A1A"/>
  <path d="M28 86 C38 92 50 94 64 104 C78 94 90 92 100 86 C98 100 84 110 64 110 C44 110 30 100 28 86Z" fill="#FFF3E6"/>
  <path d="M38 80 L46 84 M90 80 L82 84" stroke="#C8231B" stroke-width="2.6" stroke-linecap="round"/>
  <ellipse cx="48" cy="72" rx="6.5" ry="8.5" fill="#2A1410"/><ellipse cx="80" cy="72" rx="6.5" ry="8.5" fill="#2A1410"/>
  <circle cx="50.5" cy="68.5" r="2.6" fill="#fff"/><circle cx="82.5" cy="68.5" r="2.6" fill="#fff"/>
  <ellipse cx="64" cy="90" rx="4.2" ry="3" fill="#2A1410"/>
  <path d="M57.5 95 Q61 98.5 64 95 Q67 98.5 70.5 95" stroke="#2A1410" stroke-width="2" fill="none" stroke-linecap="round"/>`;

const tip = `fill="#FFE6C7"`;
const curved = `<path d="M0 0 C-20 -8 -30 -36 -16 -62 C-10 -46 4 -30 14 -14 C10 -6 6 -2 0 0Z" fill="url(#tail)"/><path d="M-16 -62 C-20 -54 -21 -48 -19 -43 Q-12 -42 -8 -46 C-9 -52 -12 -57 -16 -62Z" ${tip}/>`;
const straight = `<path d="M0 0 C-22 -16 -20 -46 0 -64 C20 -46 22 -16 0 0Z" fill="url(#tail)"/><path d="M0 -64 C-7 -58 -10 -52 -9 -47 Q0 -43 9 -47 C10 -52 7 -58 0 -64Z" ${tip}/>`;
const angles = [-74, -52, -30, -10];

// nine-tailed chibi fox, 128 box
const mascot = `<g transform="translate(64 88)">
  ${angles.map((a) => `<g transform="rotate(${a})">${curved}</g>`).join("")}
  ${angles.map((a) => `<g transform="scale(-1 1) rotate(${a})">${curved}</g>`).join("")}
  ${straight}</g>
  <g transform="translate(19 36) scale(.7)">${head}</g>`;

// K lettermark: upper arm is an ear, lower arm a tail
const kParts = (stem, arm, inner, low, tipFill) => `
  <rect x="26" y="16" width="22" height="96" rx="7" fill="${stem}"/>
  <path d="M46 60 L88 16 Q98 10 100 22 L102 50 L64 82 L46 82 Z" fill="${arm}"/>
  <path d="M88 30 L95 26 L96 46 L80 54 Z" fill="${inner}"/>
  <path d="M46 78 L60 70 C78 80 96 94 108 114 C94 112 78 104 64 96 L46 88 Z" fill="${low}"/>
  <path d="M108 114 C102 104 96 99 88 96 C92 103 98 109 108 114Z" fill="${tipFill}"/>`;
const k = kParts("url(#fireV)", "#FF6A1A", "#C8231B", "#E8401C", "#FFE6C7");
const badge = (rx) => `<rect width="128" height="128" rx="${rx}" fill="url(#fireV)"/>
  <g transform="translate(16 14) scale(.78)">${kParts("#fff", "#fff", "#FF6A1A", "#fff", "#FFC27A")}</g>`;

const svg = (body, title, w = 128, h = 128) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">\n<title>${title}</title>\n<defs>${grad}</defs>\n${body}\n</svg>\n`;

const font = "/System/Library/Fonts/Supplemental/Arial Rounded Bold.ttf";
const png = (src, width, file) => {
  const r = new Resvg(src, { fitTo: { mode: "width", value: width }, font: { fontFiles: [font], loadSystemFonts: false, defaultFontFamily: "Arial Rounded MT Bold" } });
  writeFileSync(file, r.render().asPng());
};
const save = (file, body) => writeFileSync(file, body);

const mascotSvg = svg(mascot, "Kurama, the nine-tailed fox");
const kSvg = svg(k, "Kurama K");
const badgeSvg = svg(badge(30), "Kurama");
save(`${pub}/brand/kurama.svg`, mascotSvg);
save(`${pub}/brand/kurama-k.svg`, kSvg);
save(`${pub}/brand/kurama-badge.svg`, badgeSvg);
save(`${pub}/favicon.svg`, kSvg);
png(kSvg, 32, `${pub}/favicon-32.png`);
png(svg(badge(0), "Kurama"), 180, `${pub}/apple-touch-icon.png`);
png(badgeSvg, 512, `${pub}/brand/kurama-badge-512.png`);
png(mascotSvg, 512, `${pub}/brand/kurama-512.png`);

// wordmarks: mascot + "kurama"
const wordmark = (fg) =>
  svg(`<g transform="scale(1.25)">${mascot}</g><text x="168" y="118" font-family="Arial Rounded MT Bold" font-size="92" fill="${fg}">kurama</text>`, "kurama", 520, 160);
png(wordmark("#2A1410"), 1040, `${pub}/brand/kurama-wordmark.png`);
png(wordmark("#FFF3E6"), 1040, `${pub}/brand/kurama-wordmark-dark.png`);

// social card
const og = svg(`
  <rect width="1200" height="630" fill="#FFF8F1"/>
  <g stroke="#F3E2D2" stroke-width="2">${Array.from({ length: 16 }, (_, i) => `<line x1="${i * 80}" y1="0" x2="${i * 80}" y2="630"/>`).join("")}${Array.from({ length: 9 }, (_, i) => `<line x1="0" y1="${i * 80}" x2="1200" y2="${i * 80}"/>`).join("")}</g>
  <g transform="translate(60 135) scale(2.8)">${mascot}</g>
  <g font-family="Arial Rounded MT Bold">
    <text x="500" y="200" font-size="36" fill="#C8231B">@kurama/excel-kit</text>
    <text x="500" y="285" font-size="56" fill="#2A1410">Read huge Excel files</text>
    <text x="500" y="355" font-size="56" fill="#2A1410">with <tspan fill="#E8401C">10× less memory</tspan></text>
    <text x="500" y="430" font-size="28" fill="#7A5A4A">Rust + WebAssembly, for browsers and Node.js</text>
  </g>`, "Kurama excel-kit", 1200, 630);
png(og, 1200, `${pub}/og.png`);
console.log("ok");
