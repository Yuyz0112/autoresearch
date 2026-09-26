import { createHash } from "node:crypto";
import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { AnyResearch } from "../types.ts";
import { researchView, type Point, type ResearchView } from "./model.ts";

/**
 * A static report of every research: its progress, its score trend, and each
 * checkpoint in detail. One HTML file with its data inlined and a folder of
 * images beside it, so it opens from disk and can be handed to anyone.
 *
 * What a research's own metrics mean is the harness's business, so each
 * research may supply a renderer for them; without one its metrics are shown
 * as they were recorded.
 */
export type DetailRenderer = (metrics: unknown, context: RenderContext) => Promise<string>;

export type RenderContext = {
  /** Copies a file next to the report and returns its URL, or undefined if it is gone. */
  asset(path: string): Promise<string | undefined>;
};

export async function writeReport(options: {
  researches: AnyResearch[];
  renderers: Record<string, DetailRenderer>;
  outDir: string;
  title?: string;
}): Promise<string> {
  const assets = join(options.outDir, "assets");
  await mkdir(assets, { recursive: true });
  const context: RenderContext = {
    async asset(path) {
      try {
        await stat(path);
      } catch {
        return undefined;
      }
      const name = createHash("sha1").update(path).digest("hex").slice(0, 16) + extname(path);
      await copyFile(path, join(assets, name));
      return `assets/${name}`;
    },
  };

  const sections: string[] = [];
  const researches = [...options.researches].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const research of researches) {
    const view = researchView(research);
    const renderer = options.renderers[research.name] ?? rawMetrics;
    const details: string[] = [];
    for (const [index, checkpoint] of research.checkpoints.entries()) {
      details.push(detail(view.points[index]!, await renderer(checkpoint.metrics, context)));
    }
    sections.push(section(view, details));
  }

  const file = join(options.outDir, "index.html");
  await writeFile(file, page(options.title ?? "autoresearch", sections));
  return file;
}

// --- sections ---------------------------------------------------------------

function section(view: ResearchView, details: string[]): string {
  const { counts, best } = view;
  const versions = view.segments.map((one) => one.version);
  const meta = [
    `${view.points.length} checkpoints`,
    `<span class="keep">${counts.keep} kept</span>`,
    `${counts.discard} discarded`,
    counts.crash > 0 ? `<span class="crash">${counts.crash} crashed</span>` : "",
    best === undefined ? "" : `best <b>${num(best.value)}</b> at #${best.index}`,
    versions.length === 0 ? "" : `score ${versions.map((one) => `v${esc(one)}`).join(" → ")}`,
    `updated ${esc(when(view.updatedAt))}`,
  ].filter((part) => part !== "");

  const latest = view.points.length - 1;
  return `<section class="research" data-latest="${latest}">
  <header><h2>${esc(view.name)}</h2><p class="meta">${meta.join(" · ")}</p></header>
  ${
    view.points.length === 0
      ? `<p class="empty">No checkpoints yet.</p>`
      : `<div class="trend">${chart(view)}</div>
  <div class="body">
    <ol class="list">${[...view.points].reverse().map(row).join("")}</ol>
    <div class="details">${details
      .map(
        (html, index) => `<article class="detail" data-index="${index}" hidden>${html}</article>`,
      )
      .join("")}</div>
  </div>`
  }
</section>`;
}

function row(point: Point): string {
  return `<li><button class="pick" data-index="${point.index}">
  <span class="dot ${point.status}"></span><span class="idx">#${point.index}</span>
  <span class="score">${point.score === null ? "—" : num(point.score)}</span>
  <span class="text">${esc(point.error?.split("\n")[0] ?? point.summary ?? point.status)}</span>
</button></li>`;
}

function detail(point: Point, specific: string): string {
  const facts: [string, string][] = [
    ["status", `<span class="${point.status}">${point.status}</span>`],
    [
      "score",
      point.score === null
        ? "—"
        : `${num(point.score)} <span class="muted">v${esc(point.version ?? "")}</span>`,
    ],
    ["at", esc(when(point.createdAt))],
  ];
  if (point.commit !== undefined) {
    facts.push(["commit", `<code>${esc(point.commit.slice(0, 10))}</code>`]);
  }
  for (const [name, ms] of Object.entries(point.timings)) {
    facts.push([name.replace(/Ms$/, ""), duration(ms)]);
  }
  if (point.usage !== undefined) {
    const { input, output, cacheRead, cacheWrite } = point.usage;
    facts.push([
      "tokens",
      `${num(output)} out · ${num(input)} in` +
        (cacheRead === undefined ? "" : ` · ${num(cacheRead)} cache read`) +
        (cacheWrite === undefined ? "" : ` · ${num(cacheWrite)} cache write`),
    ]);
  }
  return `<h3>#${point.index} <span class="dot ${point.status}"></span></h3>
<dl class="facts">${facts.map(([name, value]) => `<dt>${name}</dt><dd>${value}</dd>`).join("")}</dl>
${point.summary === undefined ? "" : `<p class="summary">${esc(point.summary)}</p>`}
${point.error === undefined ? "" : `<pre class="error">${esc(point.error)}</pre>`}
${specific}`;
}

// --- chart ------------------------------------------------------------------

const W = 720;
const H = 200;
const PAD = { left: 44, right: 16, top: 22, bottom: 26 };

/**
 * Score by checkpoint. The line follows what was kept, since that is the
 * research's progress; a discard is a hollow dot off it, a crash a mark on
 * the floor. A new score version starts a new line under its own label:
 * scores from different versions are not the same measure.
 */
function chart(view: ResearchView): string {
  const { points, segments } = view;
  const scored = points.filter((point) => point.score !== null).map((point) => point.score!);
  const dataLow = scored.length === 0 ? 0 : Math.min(...scored);
  const dataHigh = scored.length === 0 ? 1 : Math.max(...scored);
  // A flat score sits in the middle rather than on the floor.
  const flat = dataHigh === dataLow;
  let low = flat ? dataLow - 1 : dataLow;
  let high = flat ? dataHigh + 1 : dataHigh;
  const span = high - low;
  low -= span * 0.05;
  high += span * 0.08;
  const x = (index: number) =>
    points.length === 1
      ? (PAD.left + W - PAD.right) / 2
      : PAD.left + ((W - PAD.left - PAD.right) * index) / (points.length - 1);
  const y = (value: number) =>
    PAD.top + (H - PAD.top - PAD.bottom) * (1 - (value - low) / (high - low));
  const floor = H - PAD.bottom;

  const parts: string[] = [];
  // Version bands, labelled, alternating so a boundary shows.
  segments.forEach((segment, at) => {
    const from = segment.from === 0 ? PAD.left : (x(segment.from - 1) + x(segment.from)) / 2;
    const to =
      segment.to === points.length - 1 ? W - PAD.right : (x(segment.to) + x(segment.to + 1)) / 2;
    if (at % 2 === 1) {
      parts.push(
        `<rect class="band" x="${from}" y="${PAD.top}" width="${to - from}" height="${floor - PAD.top}"/>`,
      );
    }
    if (segments.length > 1) {
      parts.push(
        `<text class="version" x="${from + 4}" y="${PAD.top - 8}">v${esc(segment.version)}</text>`,
      );
    }
  });
  // Axis: three values, and the first and last index.
  for (const value of new Set([dataLow, (dataLow + dataHigh) / 2, dataHigh])) {
    parts.push(
      `<line class="grid" x1="${PAD.left}" x2="${W - PAD.right}" y1="${y(value)}" y2="${y(value)}"/>`,
    );
    parts.push(
      `<text class="tick" x="${PAD.left - 8}" y="${y(value) + 4}" text-anchor="end">${num(round(value))}</text>`,
    );
  }
  parts.push(`<text class="tick" x="${x(0)}" y="${H - 6}" text-anchor="middle">#0</text>`);
  if (points.length > 1) {
    parts.push(
      `<text class="tick" x="${x(points.length - 1)}" y="${H - 6}" text-anchor="middle">#${points.length - 1}</text>`,
    );
  }
  // The kept line, one per version.
  for (const segment of segments) {
    const kept = points.filter(
      (point) =>
        point.index >= segment.from &&
        point.index <= segment.to &&
        point.status === "keep" &&
        point.score !== null,
    );
    if (kept.length > 1) {
      parts.push(
        `<polyline class="line" points="${kept.map((point) => `${x(point.index)},${y(point.score!)}`).join(" ")}"/>`,
      );
    }
  }
  for (const point of points) {
    const cx = x(point.index);
    const title = `<title>#${point.index} ${point.status}${point.score === null ? "" : ` ${num(point.score)}`}</title>`;
    if (point.score === null) {
      parts.push(
        `<g class="pt crash" data-index="${point.index}"><path d="M${cx - 4},${floor - 8} l8,8 m0,-8 l-8,8"/><rect x="${cx - 7}" y="${floor - 11}" width="14" height="14" fill="transparent"/>${title}</g>`,
      );
    } else {
      parts.push(
        `<g class="pt ${point.status}" data-index="${point.index}"><circle cx="${cx}" cy="${y(point.score)}" r="4.5"/><circle class="hit" cx="${cx}" cy="${y(point.score)}" r="10"/>${title}</g>`,
      );
    }
  }
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="score by checkpoint">${parts.join("")}</svg>`;
}

// --- raw metrics ------------------------------------------------------------

/** What a research without a renderer gets: its metrics, as recorded. */
export const rawMetrics: DetailRenderer = async (metrics) =>
  `<details class="raw"><summary>metrics</summary><pre>${esc(JSON.stringify(metrics, null, 2))}</pre></details>`;

// --- page -------------------------------------------------------------------

function page(title: string, sections: string[]): string {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLE}</style>
<body>
<main>
<h1>${esc(title)}</h1>
<p class="meta">generated ${esc(when(new Date().toISOString()))}</p>
${sections.join("\n")}
</main>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

const STYLE = `
:root { --bg:#fbfbfa; --fg:#1d1d1f; --muted:#8a8a8e; --line:#e6e6e3; --band:#f1f1ee; --accent:#3b6ef5; --keep:#3b6ef5; --discard:#a8a8ad; --crash:#d4453b; --pass:#2f9e62; --fail:#d4453b; --sel:#eef2fe; }
@media (prefers-color-scheme: dark) { :root { --bg:#141416; --fg:#e8e8ea; --muted:#8e8e94; --line:#2a2a2e; --band:#1c1c20; --accent:#7c9dff; --keep:#7c9dff; --discard:#5c5c63; --crash:#f06a60; --pass:#4cc38a; --fail:#f06a60; --sel:#1f2436; } }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif; }
main { max-width:1080px; margin:0 auto; padding:40px 24px 80px; }
h1 { font-size:20px; font-weight:600; margin:0; letter-spacing:-.01em; }
h2 { font-size:17px; font-weight:600; margin:0; }
h3 { font-size:15px; font-weight:600; margin:0 0 12px; display:flex; align-items:center; gap:8px; }
.meta { color:var(--muted); margin:4px 0 0; }
.meta b { color:var(--fg); font-weight:600; }
.research { margin-top:48px; padding-top:28px; border-top:1px solid var(--line); }
.empty { color:var(--muted); }
.trend { margin:20px 0 8px; overflow-x:auto; }
.trend svg { min-width:520px; }
svg { width:100%; height:auto; display:block; overflow:visible; }
.band { fill:var(--band); }
.grid { stroke:var(--line); stroke-width:1; }
.tick, .version { fill:var(--muted); font-size:11px; }
.line { fill:none; stroke:var(--accent); stroke-width:2; stroke-linejoin:round; }
.pt { cursor:pointer; }
.pt .hit { fill:transparent; stroke:none; }
.pt.keep circle:first-child { fill:var(--keep); }
.pt.discard circle:first-child { fill:var(--bg); stroke:var(--discard); stroke-width:1.5; }
.pt.crash path { stroke:var(--crash); stroke-width:2; }
.pt.sel circle:first-child { r:6.5; stroke:var(--fg); stroke-width:2; }
.pt.sel path { stroke-width:3; }
.body { display:grid; grid-template-columns:minmax(220px,300px) 1fr; gap:28px; margin-top:16px; align-items:start; }
@media (max-width:760px) { .body { grid-template-columns:1fr; } }
.list { list-style:none; margin:0; padding:0; max-height:560px; overflow:auto; border-right:1px solid var(--line); padding-right:8px; }
@media (max-width:760px) { .list { border-right:0; padding-right:0; max-height:260px; } }
.pick { all:unset; box-sizing:border-box; width:100%; display:grid; grid-template-columns:10px 32px 56px 1fr; gap:8px; align-items:center; padding:6px 8px; border-radius:6px; cursor:pointer; }
.pick:hover { background:var(--band); }
.pick.sel { background:var(--sel); }
.pick .idx, .pick .score { font-variant-numeric:tabular-nums; }
.pick .idx { color:var(--muted); }
.pick .text { color:var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.dot { width:8px; height:8px; border-radius:50%; display:inline-block; }
.dot.keep { background:var(--keep); }
.dot.discard { background:transparent; box-shadow:inset 0 0 0 1.5px var(--discard); }
.dot.crash { background:var(--crash); border-radius:2px; }
.keep { color:var(--keep); } .crash { color:var(--crash); } .discard { color:var(--muted); }
.muted { color:var(--muted); }
.facts { display:grid; grid-template-columns:max-content 1fr; gap:4px 16px; margin:0 0 16px; }
.facts dt { color:var(--muted); } .facts dd { margin:0; font-variant-numeric:tabular-nums; }
.summary { margin:0 0 16px; padding:10px 12px; background:var(--band); border-radius:8px; }
pre { margin:0; font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; white-space:pre-wrap; word-break:break-word; }
.error { color:var(--crash); background:var(--band); padding:10px 12px; border-radius:8px; margin-bottom:16px; }
details { margin:10px 0; } summary { cursor:pointer; color:var(--muted); }
.raw pre { background:var(--band); padding:10px 12px; border-radius:8px; max-height:420px; overflow:auto; }
code { font:12px ui-monospace,SFMono-Regular,Menlo,monospace; }
.stat { display:flex; flex-wrap:wrap; gap:8px 28px; margin:4px 0 14px; }
.stat b { display:block; font-size:18px; font-weight:600; font-variant-numeric:tabular-nums; }
.stat span { color:var(--muted); font-size:12px; }
.case { border-top:1px solid var(--line); padding:12px 0; }
.case > summary { color:var(--fg); display:flex; gap:10px; align-items:center; list-style:none; }
.case > summary::-webkit-details-marker { display:none; }
.case img { width:100%; border-radius:6px; margin:10px 0; border:1px solid var(--line); }
.checks { display:grid; grid-template-columns:max-content max-content 1fr; gap:3px 12px; margin:6px 0; }
.pass { color:var(--pass); } .fail { color:var(--fail); }
.tag { font-size:11px; padding:1px 7px; border-radius:10px; background:var(--band); color:var(--muted); white-space:nowrap; }
.tag.pass { color:var(--pass); } .tag.fail { color:var(--fail); }
ul.plain { margin:6px 0; padding-left:18px; color:var(--muted); }
`;

/** Selecting a checkpoint: from the chart or the list, one per research. */
const SCRIPT = `
for (const section of document.querySelectorAll(".research")) {
  const select = (index) => {
    for (const el of section.querySelectorAll(".detail")) el.hidden = el.dataset.index !== String(index);
    for (const el of section.querySelectorAll(".pick, .pt")) el.classList.toggle("sel", el.dataset.index === String(index));
  };
  section.addEventListener("click", (event) => {
    const target = event.target.closest("[data-index].pick, [data-index].pt");
    if (target && section.contains(target)) select(target.dataset.index);
  });
  if (section.dataset.latest !== "-1") select(section.dataset.latest);
}
`;

// --- formatting -------------------------------------------------------------

export function esc(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function num(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function round(value: number): number {
  const magnitude = Math.pow(10, Math.max(0, 2 - Math.floor(Math.log10(Math.abs(value) || 1))));
  return Math.round(value * magnitude) / magnitude;
}

function duration(ms: number): string {
  return ms < 1000
    ? `${ms} ms`
    : ms < 120_000
      ? `${(ms / 1000).toFixed(1)} s`
      : `${(ms / 60_000).toFixed(1)} min`;
}

/** Local time, minutes precision: when a person looks at it, not a machine. */
function when(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
