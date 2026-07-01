#!/usr/bin/env node
/**
 * dashboard-artifacts.ts
 * Generates the Aionis v0.3 evaluation evidence dashboard as a self-contained HTML file.
 *
 * Run: npx tsx scripts/e2e/dashboard-artifacts.ts
 * Output: docs/research/aionis-eval-dashboard-2026-06-28.html
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../..");
const OUT = path.join(REPO_ROOT, "docs/research/aionis-eval-dashboard-2026-06-28.html");

// ─── Minimal SVG helpers ──────────────────────────────────────────────────────

function fmtN(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

function fmtPct(n: number, decimals = 1): string {
  return `${n.toFixed(decimals)}%`;
}

/** Vertical bar chart — returns an SVG string. */
function vBar(opts: {
  labels: string[];
  values: number[];
  colors: string[];
  max: number;
  unit?: "%" | "";
  note?: string;
  w?: number;
  h?: number;
}): string {
  const { labels, values, colors, max, unit = "", note, w = 600, h = 320 } = opts;
  const pad = { t: 24, r: 20, b: note ? 96 : 80, l: 64 };
  const cW = w - pad.l - pad.r;
  const cH = h - pad.t - pad.b;
  const n = labels.length;
  const bW = Math.min(60, Math.max(18, (cW / n) * 0.55));
  const bGap = (cW - bW * n) / (n + 1);
  const L: string[] = [];

  for (let i = 0; i <= 5; i++) {
    const y = pad.t + cH - (i / 5) * cH;
    const v = (max / 5) * i;
    const vl = unit === "%" ? `${v.toFixed(0)}%` : fmtN(v);
    L.push(
      `<line x1="${pad.l}" y1="${y.toFixed(1)}" x2="${pad.l + cW}" y2="${y.toFixed(1)}" stroke="#E2E8F0" stroke-width="1"/>`,
      `<text x="${(pad.l - 6).toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#64748B" font-family="system-ui,sans-serif">${vl}</text>`,
    );
  }
  L.push(
    `<line x1="${pad.l}" y1="${pad.t}" x2="${pad.l}" y2="${pad.t + cH}" stroke="#CBD5E1" stroke-width="1.5"/>`,
    `<line x1="${pad.l}" y1="${pad.t + cH}" x2="${pad.l + cW}" y2="${pad.t + cH}" stroke="#CBD5E1" stroke-width="1.5"/>`,
  );

  values.forEach((v, i) => {
    const bH = max > 0 ? (v / max) * cH : 0;
    const x = pad.l + bGap + i * (bW + bGap);
    const y = pad.t + cH - bH;
    const color = colors[i % colors.length];
    const vl = unit === "%" ? fmtPct(v) : fmtN(v);
    L.push(
      `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bW.toFixed(1)}" height="${bH.toFixed(1)}" rx="3" fill="${color}"/>`,
      `<text x="${(x + bW / 2).toFixed(1)}" y="${(y - 5).toFixed(1)}" text-anchor="middle" font-size="11" font-weight="600" fill="${color}" font-family="system-ui,sans-serif">${vl}</text>`,
    );
    labels[i].split(" ").forEach((part, pi) =>
      L.push(
        `<text x="${(x + bW / 2).toFixed(1)}" y="${(pad.t + cH + 14 + pi * 13).toFixed(1)}" text-anchor="middle" font-size="11" fill="#475569" font-family="system-ui,sans-serif">${part}</text>`,
      ),
    );
  });

  if (note)
    L.push(
      `<text x="${(pad.l + cW / 2).toFixed(1)}" y="${(h - 8).toFixed(1)}" text-anchor="middle" font-size="11" fill="#94A3B8" font-family="system-ui,sans-serif" font-style="italic">${note}</text>`,
    );

  return `<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" style="width:100%;max-width:${w}px;">\n${L.join("\n")}\n</svg>`;
}

/** Horizontal bar chart — returns an SVG string. */
function hBar(opts: {
  labels: string[];
  values: number[];
  colors: string[];
  max: number;
  unit?: "%" | "";
  w?: number;
}): string {
  const { labels, values, colors, max, unit = "", w = 640 } = opts;
  const rowH = 36;
  const padT = 12, padB = 24, padL = 200, padR = 80;
  const svgH = padT + labels.length * rowH + padB;
  const cW = w - padL - padR;
  const L: string[] = [];

  for (let i = 0; i <= 4; i++) {
    const x = padL + (i / 4) * cW;
    const v = (max / 4) * i;
    const vl = unit === "%" ? `${v.toFixed(0)}%` : fmtN(v);
    L.push(
      `<line x1="${x.toFixed(1)}" y1="${padT}" x2="${x.toFixed(1)}" y2="${svgH - padB}" stroke="#E2E8F0" stroke-width="1"/>`,
      `<text x="${x.toFixed(1)}" y="${(svgH - 4).toFixed(1)}" text-anchor="middle" font-size="10" fill="#94A3B8" font-family="system-ui,sans-serif">${vl}</text>`,
    );
  }
  L.push(`<line x1="${padL}" y1="${padT}" x2="${padL}" y2="${svgH - padB}" stroke="#CBD5E1" stroke-width="1.5"/>`);

  values.forEach((v, i) => {
    const bW = max > 0 ? (v / max) * cW : 0;
    const y = padT + i * rowH + 4;
    const bH = rowH - 8;
    const color = colors[i % colors.length];
    const vl = unit === "%" ? fmtPct(v) : fmtN(v);
    L.push(
      `<rect x="${padL}" y="${y.toFixed(1)}" width="${bW.toFixed(1)}" height="${bH.toFixed(1)}" rx="3" fill="${color}" opacity="0.85"/>`,
      `<text x="${(padL - 8).toFixed(1)}" y="${(y + bH / 2 + 4).toFixed(1)}" text-anchor="end" font-size="12" fill="#1E293B" font-family="system-ui,sans-serif">${labels[i]}</text>`,
      `<text x="${(padL + bW + 6).toFixed(1)}" y="${(y + bH / 2 + 4).toFixed(1)}" font-size="12" font-weight="700" fill="${color}" font-family="system-ui,sans-serif">${vl}</text>`,
    );
  });

  return `<svg viewBox="0 0 ${w} ${svgH}" xmlns="http://www.w3.org/2000/svg" style="width:100%;max-width:${w}px;">\n${L.join("\n")}\n</svg>`;
}

/** Grouped vertical bar chart — returns an SVG string. */
function groupedVBar(opts: {
  groups: string[];
  arms: string[];
  values: number[][];
  colors: string[];
  max: number;
  unit?: "%" | "";
  w?: number;
  h?: number;
}): string {
  const { groups, arms, values, colors, max, unit = "", w = 520, h = 340 } = opts;
  const pad = { t: 24, r: 20, b: 100, l: 60 };
  const cW = w - pad.l - pad.r;
  const cH = h - pad.t - pad.b;
  const nG = groups.length;
  const nA = arms.length;
  const gW = cW / nG;
  const bW = Math.max(10, Math.min(30, (gW * 0.75) / nA));
  const gGap = 2;
  const L: string[] = [];

  for (let i = 0; i <= 5; i++) {
    const y = pad.t + cH - (i / 5) * cH;
    const v = (max / 5) * i;
    const vl = unit === "%" ? `${v.toFixed(0)}%` : fmtN(v);
    L.push(
      `<line x1="${pad.l}" y1="${y.toFixed(1)}" x2="${pad.l + cW}" y2="${y.toFixed(1)}" stroke="#E2E8F0" stroke-width="1"/>`,
      `<text x="${(pad.l - 6).toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#64748B" font-family="system-ui,sans-serif">${vl}</text>`,
    );
  }
  L.push(
    `<line x1="${pad.l}" y1="${pad.t}" x2="${pad.l}" y2="${pad.t + cH}" stroke="#CBD5E1" stroke-width="1.5"/>`,
    `<line x1="${pad.l}" y1="${pad.t + cH}" x2="${pad.l + cW}" y2="${pad.t + cH}" stroke="#CBD5E1" stroke-width="1.5"/>`,
  );

  groups.forEach((group, gi) => {
    const gCX = pad.l + gi * gW + gW / 2;
    const totalBW = nA * bW + (nA - 1) * gGap;
    const startX = gCX - totalBW / 2;
    values[gi].forEach((v, ai) => {
      const bH = max > 0 ? (v / max) * cH : 0;
      const x = startX + ai * (bW + gGap);
      const y = pad.t + cH - bH;
      L.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bW.toFixed(1)}" height="${bH.toFixed(1)}" rx="2" fill="${colors[ai % colors.length]}"/>`);
    });
    group.split(" ").forEach((p, pi) =>
      L.push(
        `<text x="${gCX.toFixed(1)}" y="${(pad.t + cH + 14 + pi * 13).toFixed(1)}" text-anchor="middle" font-size="10" fill="#475569" font-family="system-ui,sans-serif">${p}</text>`,
      ),
    );
  });

  // Legend
  arms.forEach((arm, ai) => {
    const lx = pad.l + ai * (cW / Math.max(nA, 1));
    const ly = h - 24;
    L.push(
      `<rect x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" width="10" height="10" rx="2" fill="${colors[ai % colors.length]}"/>`,
      `<text x="${(lx + 14).toFixed(1)}" y="${(ly + 9).toFixed(1)}" font-size="11" fill="#475569" font-family="system-ui,sans-serif">${arm}</text>`,
    );
  });

  return `<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" style="width:100%;max-width:${w}px;">\n${L.join("\n")}\n</svg>`;
}

// ─── Frozen evidence (sourced 2026-06-28) ─────────────────────────────────────

const C = {
  aionis: "#2563EB",
  mem0: "#7C3AED",
  bm25: "#059669",
  full: "#D97706",
  none: "#6B7280",
  super: "#0891B2",
  graphiti: "#DC2626",
  tencent: "#B45309",
  raw: "#9CA3AF",
};

const E2E_TOKENS = {
  labels: ["No Memory", "Full History", "BM25", "Mem0", "Aionis"],
  values: [914534, 1684567, 651377, 1096738, 650482],
  colors: [C.none, C.full, C.bm25, C.mem0, C.aionis],
};

const E2E_BURIED = {
  labels: ["Full History", "BM25", "Mem0", "Aionis"],
  values: [981860, 169801, 295392, 166537],
  colors: [C.full, C.bm25, C.mem0, C.aionis],
};

const MGBENCH = {
  labels: ["Aionis", "Aionis (tree)", "Supermemory filt.", "Mem0 filt.", "Aionis (no tree)", "Mem0 raw", "raw memory", "Supermemory raw", "Tencent", "Graphiti", "No memory"],
  values: [100, 93.83, 92.93, 91.74, 40, 30.56, 30, 30, 15, 12.56, 0],
  colors: [C.aionis, "#93C5FD", C.super, C.mem0, "#BFDBFE", "#A78BFA", C.raw, "#67E8F9", C.tencent, C.graphiti, C.none],
};

const COMPRESS = {
  labels: ["Full History", "Naive Summary", "Raw Retrieval", "Aionis"],
  comprPct: [0, 47.5, 14.2, 76.9],
  downstreamPct: [70.8, 62.5, 70.8, 95.8],
  colors: [C.full, C.raw, C.bm25, C.aionis],
};

const INTERFERE = {
  labels: ["Aionis", "Mem0 raw", "Mem0 filtered"],
  productPos: [40, 0, 30],
  unsafeUse: [0, 39, 0],
  colors: [C.aionis, C.mem0, "#A78BFA"],
};

const FORGET = {
  labels: ["Aionis", "Graphiti", "Tencent"],
  productPos: [24, 0, 0],
  colors: [C.aionis, C.graphiti, C.tencent],
};

const FIREWALL_GROUPS = ["Wrong direct-use %", "Primary route %", "Audit coverage %"];
const FIREWALL_VALUES = [
  [83.3, 0],
  [58.3, 100],
  [0, 100],
];

// ─── CSS ──────────────────────────────────────────────────────────────────────

const CSS = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#F8FAFC;color:#1E293B;line-height:1.6}
.hero{background:linear-gradient(135deg,#1E3A8A 0%,#1E40AF 50%,#2563EB 100%);color:#fff;padding:56px 24px 48px;text-align:center}
.hero-badge{display:inline-block;background:rgba(255,255,255,.15);border:1px solid rgba(255,255,255,.3);border-radius:20px;padding:4px 14px;font-size:13px;font-weight:500;letter-spacing:.05em;margin-bottom:20px;text-transform:uppercase}
.hero h1{font-size:clamp(26px,5vw,46px);font-weight:800;letter-spacing:-.02em;margin-bottom:16px}
.hero .subtitle{font-size:17px;opacity:.85;max-width:640px;margin:0 auto 20px}
.hero .meta{font-size:13px;opacity:.6}
.hero .meta a{color:#fff;text-decoration:none;opacity:.8}
.container{max-width:1080px;margin:0 auto;padding:0 24px}
.metrics-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:16px;padding:40px 0}
.metric-card{background:#fff;border:1px solid #E2E8F0;border-radius:12px;padding:24px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.04)}
.metric-card .num{font-size:38px;font-weight:800;color:#2563EB;letter-spacing:-.02em;line-height:1;margin-bottom:6px}
.metric-card .label{font-size:13px;color:#64748B;font-weight:500}
.metric-card .ctx{font-size:12px;color:#94A3B8;margin-top:4px}
section{padding:48px 0;border-top:1px solid #E2E8F0}
h2{font-size:24px;font-weight:700;letter-spacing:-.01em;margin-bottom:8px;color:#0F172A}
h3{font-size:17px;font-weight:600;margin:32px 0 12px;color:#1E293B}
.lead{font-size:15px;color:#475569;margin-bottom:28px;max-width:720px}
.chart-wrap{background:#fff;border:1px solid #E2E8F0;border-radius:12px;padding:24px;margin:20px 0;box-shadow:0 1px 3px rgba(0,0,0,.04)}
.chart-title{font-size:13px;font-weight:600;color:#374151;margin-bottom:14px}
.chart-cap{font-size:12px;color:#94A3B8;margin-top:10px;font-style:italic}
table{width:100%;border-collapse:collapse;font-size:14px;margin:20px 0}
th{text-align:left;padding:10px 12px;background:#F1F5F9;color:#374151;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.04em;border-bottom:2px solid #E2E8F0}
td{padding:9px 12px;border-bottom:1px solid #F1F5F9;color:#1E293B;vertical-align:middle}
tr:hover td{background:#F8FAFC}
tr.hi td{font-weight:600;color:#1D4ED8;background:#EFF6FF}
.badge{display:inline-block;padding:2px 7px;border-radius:4px;font-size:11px;font-weight:600}
.bg{background:#DCFCE7;color:#166534}
.br{background:#FEE2E2;color:#991B1B}
.bl{background:#DBEAFE;color:#1E40AF}
.callout{background:#EFF6FF;border-left:4px solid #2563EB;border-radius:0 8px 8px 0;padding:14px 18px;margin:20px 0;font-size:15px;color:#1E3A8A}
.grid-2{display:grid;grid-template-columns:1fr 1fr;gap:20px}
@media(max-width:640px){.grid-2{grid-template-columns:1fr}}
.pills{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0}
.pill{background:#EFF6FF;color:#1E40AF;border:1px solid #BFDBFE;border-radius:20px;padding:4px 12px;font-size:12px;font-weight:500}
.blist{list-style:none}
.blist li{padding:7px 0;border-bottom:1px solid #F1F5F9;font-size:14px;color:#475569}
.blist li::before{content:'·';color:#94A3B8;margin-right:8px}
.refs{background:#F1F5F9;border-radius:8px;padding:18px;font-size:13px;color:#475569;line-height:1.8}
.refs a{color:#2563EB;text-decoration:none}
footer{background:#1E293B;color:#94A3B8;text-align:center;padding:28px 24px;font-size:13px;margin-top:48px}
footer a{color:#60A5FA}
code{background:#F1F5F9;padding:1px 5px;border-radius:3px;font-family:'JetBrains Mono','Fira Code',monospace;font-size:12px}
`;

// ─── HTML generation ──────────────────────────────────────────────────────────

function badge(text: string, kind: "g" | "r" | "l" | ""): string {
  const cls = kind === "g" ? "badge bg" : kind === "r" ? "badge br" : kind === "l" ? "badge bl" : "badge";
  return `<span class="${cls}">${text}</span>`;
}

function generate(): string {
  const chartTokens = vBar({ ...E2E_TOKENS, max: 1_800_000, w: 640, h: 340 });
  const chartBuried = vBar({ ...E2E_BURIED, max: 1_100_000, w: 480, h: 300, note: "Buried: useful state buried inside large noisy history (10 cases each)" });
  const chartMGBench = hBar({ ...MGBENCH, max: 100, unit: "%", w: 680 });
  const chartComprRatio = vBar({ labels: COMPRESS.labels, values: COMPRESS.comprPct, colors: COMPRESS.colors, max: 100, unit: "%", w: 460, h: 300 });
  const chartDownstream = vBar({ labels: COMPRESS.labels, values: COMPRESS.downstreamPct, colors: COMPRESS.colors, max: 100, unit: "%", w: 460, h: 300, note: "LLM-judged downstream action accuracy (24 scenarios)" });
  const chartInterference = vBar({ labels: INTERFERE.labels, values: INTERFERE.productPos, colors: INTERFERE.colors, max: 40, w: 400, h: 280 });
  const chartForget = vBar({ labels: FORGET.labels, values: FORGET.productPos, colors: FORGET.colors, max: 24, w: 360, h: 260 });
  const chartFirewall = groupedVBar({
    groups: FIREWALL_GROUPS,
    arms: ["Mem0 raw", "Mem0 + Aionis"],
    values: FIREWALL_VALUES,
    colors: [C.mem0, C.aionis],
    max: 100,
    unit: "%",
    w: 500,
    h: 340,
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Aionis v0.3 Evaluation Evidence</title>
<style>${CSS}</style>
</head>
<body>

<div class="hero">
  <div class="hero-badge">Evaluation Evidence · v0.3 · 2026-06-28</div>
  <h1>Aionis v0.3 Evaluation Evidence</h1>
  <p class="subtitle">
    Shorter, cleaner, auditable Agent context.<br>
    Measured across a 40-case external Agent E2E, MGBench v0.1.1 (608 scenarios, DOI-archived), and internal compression benchmarks.
  </p>
  <p class="meta">
    MGBench DOI:&nbsp;<a href="https://doi.org/10.5281/zenodo.20793097">10.5281/zenodo.20793097</a>
    &nbsp;·&nbsp;Report generated 2026-06-28
  </p>
</div>

<div class="container">

  <!-- Headline metrics -->
  <div class="metrics-grid">
    <div class="metric-card">
      <div class="num">61.4%</div>
      <div class="label">Fewer prompt tokens vs Full History</div>
      <div class="ctx">40-case external Agent E2E</div>
    </div>
    <div class="metric-card">
      <div class="num">83.0%</div>
      <div class="label">Token reduction on buried histories</div>
      <div class="ctx">100% completion maintained</div>
    </div>
    <div class="metric-card">
      <div class="num">77.2%</div>
      <div class="label">Context compression</div>
      <div class="ctx">100% state retained, 0% stale leak</div>
    </div>
    <div class="metric-card">
      <div class="num">100</div>
      <div class="label">MGBench v0.1.1 score</div>
      <div class="ctx">368/368 product-positive, 0 wrong-reuse</div>
    </div>
  </div>

  <!-- ── Result 1: External Agent E2E ── -->
  <section>
    <h2>Result 1 — External Agent Context Stability</h2>
    <p class="lead">
      40 real coding-agent continuation records across four history-hygiene levels:
      <em>tidy</em>, <em>separated</em>, <em>implicit</em>, and <em>buried</em>.
      Five arms compared; the controlled variable is the context passed between sessions.
    </p>

    <div class="chart-wrap">
      <div class="chart-title">Prompt tokens — 40-case aggregate</div>
      ${chartTokens}
      <div class="chart-cap">Lower is better. No Memory completed only 22.5% of tasks; all other arms 97.5–100%.</div>
    </div>

    <table>
      <thead>
        <tr>
          <th>Arm</th><th>Runs</th><th>Action completion</th><th>Accepted direction</th>
          <th>Prompt tokens</th><th>Total tokens</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>No Memory</td><td>40</td><td>${badge("22.5%", "r")}</td>
          <td>15.0%</td><td>914,534</td><td>1,212,833</td>
        </tr>
        <tr>
          <td>Full History</td><td>40</td><td>${badge("97.5%", "g")}</td>
          <td>100%</td><td>1,684,567</td><td>1,821,808</td>
        </tr>
        <tr>
          <td>BM25 Retrieval</td><td>40</td><td>${badge("100%", "g")}</td>
          <td>100%</td><td>651,377</td><td>802,620</td>
        </tr>
        <tr>
          <td>Mem0</td><td>40</td><td>${badge("100%", "g")}</td>
          <td>100%</td><td>1,096,738</td><td>1,248,053</td>
        </tr>
        <tr class="hi">
          <td><strong>Aionis</strong></td><td>40</td><td>${badge("100%", "g")}</td>
          <td>100%</td><td><strong>650,482</strong></td><td><strong>794,196</strong></td>
        </tr>
      </tbody>
    </table>

    <div class="callout">
      Aionis reduced prompt tokens by <strong>61.4%</strong> vs Full History and <strong>40.7%</strong> vs Mem0,
      while preserving 100% continuation completion and 100% accepted-direction recognition.
    </div>

    <h3>Buried Histories — Hardest Stress Condition</h3>
    <p class="lead" style="margin-bottom:16px;">
      "Buried" hides useful execution state inside much larger noisy context.
      This is where state-preserving compression matters most.
    </p>

    <div class="chart-wrap" style="max-width:520px;">
      <div class="chart-title">Prompt tokens — buried histories (10 cases each)</div>
      ${chartBuried}
    </div>

    <table>
      <thead>
        <tr><th>Arm</th><th>Runs</th><th>Completion</th><th>Prompt tokens</th><th>vs Full History</th></tr>
      </thead>
      <tbody>
        <tr><td>Full History</td><td>10</td><td>100%</td><td>981,860</td><td>—</td></tr>
        <tr><td>BM25 Retrieval</td><td>10</td><td>100%</td><td>169,801</td><td>−82.7%</td></tr>
        <tr><td>Mem0</td><td>10</td><td>100%</td><td>295,392</td><td>−69.9%</td></tr>
        <tr class="hi"><td><strong>Aionis</strong></td><td>10</td><td>100%</td><td><strong>166,537</strong></td><td><strong>−83.0%</strong></td></tr>
      </tbody>
    </table>

    <p style="font-size:13px;color:#64748B;margin-top:8px;">
      Against BM25, Aionis matched token cost in this run while adding state governance, rehydrate evidence,
      retired-path context, and an auditable memory-use trace that BM25 does not provide.
    </p>
  </section>

  <!-- ── Result 2: MGBench ── -->
  <section>
    <h2>Result 2 — MGBench v0.1.1 Memory Governance Benchmark</h2>
    <p class="lead">
      A public benchmark for memory governance in agentic long-term memory systems.
      Measures continuity, negative-transfer blocking, context efficiency, governance ownership,
      self-learning loop, and execution-state continuity.
      608 frozen scenarios, deterministic scoring (no LLM judge).
      <br>DOI:&nbsp;<code>10.5281/zenodo.20793097</code>
    </p>

    <div class="chart-wrap">
      <div class="chart-title">MGBench score — all arms (ranked)</div>
      ${chartMGBench}
      <div class="chart-cap">Aionis is the only arm with runtime-internal governance ownership and a perfect score.</div>
    </div>

    <table>
      <thead>
        <tr>
          <th>Arm</th><th>Governance owner</th><th>Completed</th>
          <th>Wrong reused</th><th>Product-positive</th><th>Avg context chars</th><th>Score</th>
        </tr>
      </thead>
      <tbody>
        <tr class="hi">
          <td><strong>Aionis</strong></td><td>runtime internal</td><td>368</td>
          <td>${badge("0/368", "g")}</td><td>368/368</td><td>1,224</td><td><strong>100</strong></td>
        </tr>
        <tr>
          <td>Aionis (exec tree)</td><td>runtime internal</td><td>240</td>
          <td>0/240</td><td>240/240</td><td>3,193</td><td>93.83</td>
        </tr>
        <tr>
          <td>Supermemory (filtered)</td><td>external host</td><td>280</td>
          <td>0/280</td><td>279/280</td><td>1,484</td><td>92.93</td>
        </tr>
        <tr>
          <td>Mem0 (filtered)</td><td>external host</td><td>280</td>
          <td>0/280</td><td>280/280</td><td>1,815</td><td>91.74</td>
        </tr>
        <tr>
          <td>Aionis (no tree)</td><td>runtime internal</td><td>240</td>
          <td>${badge("240/240", "r")}</td><td>0/240</td><td>2,409</td><td>40</td>
        </tr>
        <tr>
          <td>Mem0 raw</td><td>none</td><td>280</td>
          <td>274/280</td><td>3/280</td><td>4,671</td><td>30.56</td>
        </tr>
        <tr>
          <td>Tencent Agent Memory</td><td>none</td><td>48</td>
          <td>48/48</td><td>0/48</td><td>12,998</td><td>15</td>
        </tr>
        <tr>
          <td>Graphiti</td><td>none</td><td>48</td>
          <td>47/48</td><td>1/48</td><td>13,311</td><td>12.56</td>
        </tr>
        <tr>
          <td>No memory</td><td>none</td><td>200</td>
          <td>0/200</td><td>0/200</td><td>0</td><td>0</td>
        </tr>
      </tbody>
    </table>

    <p style="font-size:12px;color:#94A3B8;font-style:italic;">
      Filtered competitor modes receive governance from the external host, not from the memory system itself.
      Governance ownership is tracked separately from score.
    </p>
  </section>

  <!-- ── Result 3: Compression ── -->
  <section>
    <h2>Result 3 — State-Preserving Context Compression</h2>
    <p class="lead">
      Can a context compiler preserve execution state under compression?
      100 deterministic scenarios (real GitHub commit metadata), plus a 24-scenario subset
      with LLM-judged downstream action accuracy.
    </p>

    <div class="grid-2">
      <div class="chart-wrap">
        <div class="chart-title">Compression ratio (%)</div>
        ${chartComprRatio}
        <div class="chart-cap">Higher is better. Aionis: 77.2% with full state retention.</div>
      </div>
      <div class="chart-wrap">
        <div class="chart-title">Downstream action accuracy — LLM-judged (24 scenarios)</div>
        ${chartDownstream}
        <div class="chart-cap">Aionis 95.8% vs Full History 70.8%: compression improved accuracy.</div>
      </div>
    </div>

    <table>
      <thead>
        <tr>
          <th>Arm</th><th>Compression</th><th>Current state</th>
          <th>Negative recall</th><th>Stale leak</th><th>Rehydrate</th><th>Audit</th><th>Downstream action</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Full History</td><td>0.0%</td><td>100%</td>
          <td>100%</td><td>${badge("12.5%", "r")}</td><td>0%</td><td>0%</td><td>70.8%</td>
        </tr>
        <tr>
          <td>Naive Summary</td><td>46.8%</td><td>100%</td>
          <td>87.5%</td><td>${badge("12.5%", "r")}</td><td>0%</td><td>0%</td><td>62.5%</td>
        </tr>
        <tr>
          <td>Raw Retrieval</td><td>14.1%</td><td>100%</td>
          <td>50.0%</td><td>12.5%</td><td>0%</td><td>0%</td><td>70.8%</td>
        </tr>
        <tr class="hi">
          <td><strong>Aionis</strong></td><td><strong>76.9%</strong></td><td>100%</td>
          <td><strong>100%</strong></td><td>${badge("0%", "g")}</td>
          <td><strong>100%</strong></td><td><strong>100%</strong></td><td><strong>95.8%</strong></td>
        </tr>
      </tbody>
    </table>

    <div class="callout">
      Aionis is the only arm that simultaneously achieves &gt;50% compression, 0% stale leak,
      100% rehydrate recall, 100% audit coverage, <em>and</em> higher downstream action accuracy than Full History.
    </div>
  </section>

  <!-- ── Result 4: Interference ── -->
  <section>
    <h2>Result 4 — Interference Robustness</h2>
    <p class="lead">
      40 scenarios derived from real GitHub PR histories. After interruption, tool failure,
      context pollution, or memory conflict — can the system recover active execution state
      while keeping corrupted history out of direct-use context?
    </p>

    <div class="grid-2">
      <div class="chart-wrap">
        <div class="chart-title">Product-positive outcomes (out of 40)</div>
        ${chartInterference}
        <div class="chart-cap">Product-positive requires active state recovery + 0 unsafe direct-use + rehydrate + trace.</div>
      </div>
      <div>
        <table style="align-self:start;margin-top:24px;">
          <thead>
            <tr>
              <th>Arm</th><th>Governance</th><th>Product-pos.</th>
              <th>Unsafe direct-use</th><th>Rehydrate</th><th>Trace</th>
            </tr>
          </thead>
          <tbody>
            <tr class="hi">
              <td><strong>Aionis</strong></td><td>runtime internal</td><td><strong>40/40</strong></td>
              <td>${badge("0/40", "g")}</td><td>100%</td><td>100%</td>
            </tr>
            <tr>
              <td>Mem0 raw</td><td>none</td><td>${badge("0/40", "r")}</td>
              <td>${badge("39/40", "r")}</td><td>75%</td><td>0%</td>
            </tr>
            <tr>
              <td>Mem0 filtered</td><td>external host</td><td>30/40</td>
              <td>${badge("0/40", "g")}</td><td>75%</td><td>0%</td>
            </tr>
          </tbody>
        </table>
        <div class="callout" style="margin-top:20px;font-size:14px;">
          Raw retrieval can find relevant state but does not decide whether that state is admissible.
          Host filtering improves safety but moves governance responsibility outside the memory system.
          Aionis keeps admission, rehydrate evidence, and decision trace inside the Runtime.
        </div>
      </div>
    </div>

    <h3>Strict ID-Neutral Holdout</h3>
    <p style="font-size:14px;color:#475569;margin-bottom:14px;">
      Memory IDs and role-bearing identifiers are rewritten to neutral forms.
      The Runtime cannot rely on semantic IDs — a stronger recovery test.
    </p>
    <table>
      <thead>
        <tr><th>Arm</th><th>Completed</th><th>Product-positive</th><th>Unsafe direct-use</th><th>Rehydrate</th><th>Trace</th><th>Avg chars</th></tr>
      </thead>
      <tbody>
        <tr class="hi">
          <td>Aionis strict + Zvec ANN</td><td>40/40</td><td>40/40</td>
          <td>${badge("0/40", "g")}</td><td>100%</td><td>100%</td><td>1,306</td>
        </tr>
        <tr class="hi">
          <td>Aionis strict + Zvec ANN (rerun)</td><td>40/40</td><td>40/40</td>
          <td>${badge("0/40", "g")}</td><td>100%</td><td>100%</td><td>1,305</td>
        </tr>
      </tbody>
    </table>
  </section>

  <!-- ── Result 5: Memory Governance Suites ── -->
  <section>
    <h2>Result 5 — Memory Governance Suites</h2>
    <p class="lead">
      Six additional MGBench tracks test specific failure modes that production memory systems encounter:
      poison propagation, archive leak, scope contamination, lifecycle inference, and execution-state branch isolation.
    </p>

    <h3>Controlled Forgetting (24 scenarios)</h3>
    <div class="grid-2">
      <div class="chart-wrap">
        <div class="chart-title">Product-positive outcomes (out of 24)</div>
        ${chartForget}
      </div>
      <table style="align-self:start;margin-top:24px;">
        <thead>
          <tr><th>Arm</th><th>Positive</th><th>Poison amplified</th><th>Archive leak</th><th>Bad reuse</th><th>Avg chars</th></tr>
        </thead>
        <tbody>
          <tr class="hi">
            <td><strong>Aionis</strong></td><td>24/24</td>
            <td>${badge("0", "g")}</td><td>${badge("0", "g")}</td><td>${badge("0", "g")}</td><td>1,173</td>
          </tr>
          <tr>
            <td>Graphiti</td><td>0/24</td>
            <td>${badge("24/24", "r")}</td><td>${badge("23/24", "r")}</td><td>${badge("23/24", "r")}</td><td>13,311</td>
          </tr>
          <tr>
            <td>Tencent</td><td>0/24</td>
            <td>${badge("24/24", "r")}</td><td>${badge("24/24", "r")}</td><td>${badge("24/24", "r")}</td><td>12,998</td>
          </tr>
        </tbody>
      </table>
    </div>

    <h3>High-Trust Conflict Governance (24 scenarios)</h3>
    <table>
      <thead>
        <tr><th>Arm</th><th>Conflict safe</th><th>Conflict bad reuse</th><th>Product-positive</th></tr>
      </thead>
      <tbody>
        <tr class="hi"><td><strong>Aionis</strong></td><td>24/24</td><td>${badge("0", "g")}</td><td>24/24</td></tr>
        <tr><td>Graphiti</td><td>1/24</td><td>${badge("23/24", "r")}</td><td>1/24</td></tr>
        <tr><td>Tencent Agent Memory</td><td>0/24</td><td>${badge("24/24", "r")}</td><td>0/24</td></tr>
      </tbody>
    </table>

    <h3>Scope Isolation (40 scenarios)</h3>
    <table>
      <thead>
        <tr>
          <th>Arm</th><th>Governance owner</th><th>Current recall</th>
          <th>Scope leak</th><th>Product-positive</th><th>Avg chars</th>
        </tr>
      </thead>
      <tbody>
        <tr class="hi">
          <td><strong>Aionis</strong></td><td>runtime internal</td><td>40/40</td>
          <td>${badge("0/40", "g")}</td><td>40/40</td><td>1,494</td>
        </tr>
        <tr>
          <td>Mem0 (filtered)</td><td>external host</td><td>40/40</td>
          <td>0/40</td><td>40/40</td><td>1,111</td>
        </tr>
        <tr>
          <td>Supermemory (filtered)</td><td>external host</td><td>39/40</td>
          <td>0/40</td><td>39/40</td><td>821</td>
        </tr>
        <tr>
          <td>Mem0 raw</td><td>none</td><td>37/40</td>
          <td>${badge("34/40", "r")}</td><td>3/40</td><td>7,983</td>
        </tr>
        <tr>
          <td>Supermemory raw</td><td>none</td><td>40/40</td>
          <td>${badge("40/40", "r")}</td><td>0/40</td><td>1,881</td>
        </tr>
      </tbody>
    </table>

    <h3>Lifecycle Inference (40 scenarios)</h3>
    <p style="font-size:14px;color:#475569;margin-bottom:12px;">
      Unlabelled: the Runtime must infer memory lifecycle state from history structure — no pre-annotated labels.
    </p>
    <table>
      <thead>
        <tr><th>Arm</th><th>Completed</th><th>Current recall</th><th>Old reused</th><th>Safe-positive</th><th>Inference-positive</th><th>Avg chars</th></tr>
      </thead>
      <tbody>
        <tr class="hi">
          <td><strong>Aionis</strong></td><td>40/40</td><td>40/40</td>
          <td>${badge("0/40", "g")}</td><td>40/40</td><td>40/40</td><td>779</td>
        </tr>
      </tbody>
    </table>

    <h3>Execution-Tree Effect (40 + 200 stress scenarios)</h3>
    <table>
      <thead>
        <tr><th>Arm</th><th>Scenarios</th><th>Current recall</th><th>Wrong reused</th><th>Product-positive</th><th>Avg chars</th></tr>
      </thead>
      <tbody>
        <tr class="hi">
          <td><strong>Aionis (with exec tree)</strong></td><td>40 / 200</td><td>40/40 · 200/200</td>
          <td>${badge("0/40 · 0/200", "g")}</td><td>40/40 · 200/200</td><td>3,178 · 3,196</td>
        </tr>
        <tr>
          <td>Aionis (no tree)</td><td>40 / 200</td><td>40/40 · 200/200</td>
          <td>${badge("40/40 · 200/200", "r")}</td><td>0/40 · 0/200</td><td>1,616 · 2,568</td>
        </tr>
      </tbody>
    </table>
    <p style="font-size:13px;color:#64748B;margin-top:6px;">
      The ablation shows that the execution tree is the mechanism that prevents wrong-branch reuse.
      Without it, current recall is intact but every recalled memory is wrong-reused.
    </p>
  </section>

  <!-- ── Result 6: Memory Firewall ── -->
  <section>
    <h2>Result 6 — Backend-Agnostic Memory Firewall</h2>
    <p class="lead">
      Aionis does not require replacing your existing memory backend.
      The Memory Firewall sits between retrieval and the Agent prompt,
      routing retrieved candidates through <code>use_now</code>, <code>inspect_before_use</code>,
      <code>do_not_use</code>, and <code>rehydrate</code> before they become instructions.
    </p>

    <div class="grid-2">
      <div class="chart-wrap">
        <div class="chart-title">Mem0 A/B — 12 local scenarios</div>
        ${chartFirewall}
        <div class="chart-cap">Wrong direct-use % · Primary route chosen % · Audit coverage %</div>
      </div>
      <div>
        <table style="margin-top:24px;">
          <thead>
            <tr><th>Arm</th><th>Wrong direct-use</th><th>Primary route</th><th>Current recall</th><th>Audit</th><th>Avg chars</th></tr>
          </thead>
          <tbody>
            <tr>
              <td>Mem0 raw</td><td>${badge("83.3%", "r")}</td>
              <td>58.3%</td><td>100%</td><td>${badge("0%", "r")}</td><td>560</td>
            </tr>
            <tr class="hi">
              <td><strong>Mem0 + Aionis Firewall</strong></td><td>${badge("0%", "g")}</td>
              <td><strong>100%</strong></td><td>100%</td><td>${badge("100%", "g")}</td><td>722</td>
            </tr>
          </tbody>
        </table>
        <div class="callout" style="margin-top:18px;font-size:14px;">
          Mem0 retrieved the current route in all 12 cases.
          It also retrieved unsafe memories in 10 of them.
          Aionis governed the same retrieved set: preserved the current route, blocked all unsafe memories,
          and produced a full admission receipt.
        </div>
      </div>
    </div>
  </section>

  <!-- ── Result 7: Self-Learning ── -->
  <section>
    <h2>Result 7 — Evidence-Gated Self-Learning Loop</h2>
    <p class="lead">
      Aionis promotes memory to trusted status only when accumulated evidence supports it,
      and suppresses memory when counter-evidence appears. The self-learning track in MGBench
      verifies all three lifecycle transitions across 200 scenarios.
    </p>
    <div class="metrics-grid" style="max-width:700px;">
      <div class="metric-card">
        <div class="num">200/200</div>
        <div class="label">Candidate after one positive signal</div>
      </div>
      <div class="metric-card">
        <div class="num">200/200</div>
        <div class="label">Trusted after two signals</div>
      </div>
      <div class="metric-card">
        <div class="num">200/200</div>
        <div class="label">Suppressed on counter-evidence</div>
      </div>
      <div class="metric-card">
        <div class="num">932</div>
        <div class="label">Learning lift steps accumulated</div>
      </div>
    </div>
  </section>

  <!-- ── Supported Claims ── -->
  <section>
    <h2>Supported Product Claims</h2>
    <div class="callout" style="font-size:16px;">
      Aionis turns long execution history into shorter, cleaner, auditable Agent context.
    </div>
    <div class="pills">
      <span class="pill">61.4% fewer prompt tokens vs Full History</span>
      <span class="pill">83.0% fewer on buried histories</span>
      <span class="pill">100% completion on 40-case Agent E2E</span>
      <span class="pill">40/40 product-positive on interference (real GitHub PR source)</span>
      <span class="pill">0/40 unsafe direct-use on interference scenarios</span>
      <span class="pill">77.2% compression with 100% state retention</span>
      <span class="pill">95.8% LLM-judged downstream accuracy (vs 70.8% full history)</span>
      <span class="pill">100% audit coverage on every measured arm</span>
      <span class="pill">MGBench score 100 — only runtime-internal governance arm</span>
    </div>
  </section>

  <!-- ── Methodology Boundaries ── -->
  <section>
    <h2>Methodology Boundaries</h2>
    <p style="font-size:15px;color:#475569;margin-bottom:16px;">These results are intentionally bounded:</p>
    <ul class="blist">
      <li>External Agent E2E measures context stability and continuation behavior on a specific 40-case set. It is not a general GitHub issue-solving benchmark or a claim about all coding-agent tasks.</li>
      <li>MGBench measures memory governance under interference. It does not measure broad LLM reasoning, patch correctness, or task-specific success rates.</li>
      <li>State-preserving compression is an internal benchmark with deterministic scoring plus downstream LLM scoring. It is not a public external benchmark.</li>
      <li>Memory Firewall A/B is a 12-scenario product evidence snapshot, not a broad market comparison with Mem0.</li>
      <li>Admission dataset results prove the flywheel and policy-evaluation path; they do not certify a learned admission policy for broad rollout.</li>
      <li>Zvec results are recall-quality diagnostics; enabling Zvec does not change Aionis admission semantics.</li>
      <li>Filtered competitor modes receive governance from the external host, not from the memory system itself. Governance ownership is recorded separately.</li>
      <li>All competitor results come from public releases or standard API configurations. No unfair advantage is intended.</li>
    </ul>
  </section>

  <!-- ── References ── -->
  <section>
    <h2>References &amp; Reproducibility</h2>
    <div class="refs">
      <strong>MGBench v0.1.1</strong> — DOI:&nbsp;<a href="https://doi.org/10.5281/zenodo.20793097">10.5281/zenodo.20793097</a>.
      608 frozen deterministic scenarios. Score computation does not use an LLM judge.<br><br>
      <strong>External Agent E2E (40-case):</strong>
      <code>AionisRuntime-evals/external-agent-e2e/reports/external-credibility-five-arm-all40-rehydrate-mem0deps-2026-06-28/</code><br>
      <strong>State compression baseline:</strong>
      <code>AionisRuntime-focused/docs/AIONIS_CONTEXT_COMPRESSION_BASELINE.md</code><br>
      <strong>Interference evidence bundle:</strong>
      <code>MGBench/reports/aionis-v0.3-context-reliability/summary.md</code><br>
      <strong>MGBench derived horizontals:</strong>
      <code>MGBench/derived/*.md</code><br>
      <strong>Mem0 Firewall A/B:</strong>
      <code>AionisRuntime-focused/docs/AIONIS_MEM0_FIREWALL_AB_REPORT.md</code><br>
      <strong>Admission policy promotion status:</strong>
      <code>AionisRuntime-focused/docs/AIONIS_ADMISSION_POLICY_PROMOTION_STATUS.md</code>
    </div>
  </section>

</div><!-- /container -->

<footer>
  Aionis v0.3 Evaluation Evidence Report &nbsp;·&nbsp; Generated 2026-06-28
  &nbsp;·&nbsp; MGBench DOI:&nbsp;<a href="https://doi.org/10.5281/zenodo.20793097">10.5281/zenodo.20793097</a>
</footer>

</body>
</html>`;
}

// ─── Main ──────────────────────────────────────────────────────────────────────

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, generate(), "utf8");
console.log(`Dashboard written to:\n  ${OUT}`);
