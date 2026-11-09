"use strict";
// Renders data/latest.json and data/history.json. All values go through textContent / DOM attributes, never innerHTML.
const STALE_AFTER_MS = 3 * 60 * 60 * 1000;
const SVG = "http://www.w3.org/2000/svg";

function el(tag, text, cls) {
  const n = document.createElement(tag);
  if (text !== undefined && text !== null) n.textContent = text;
  if (cls) n.className = cls;
  return n;
}

// "1620548.77021" -> "1,620,548.77021" without going through floats.
function group(xrp) {
  if (xrp === null || xrp === undefined) return "n/a";
  const [whole, frac] = String(xrp).split(".");
  const sign = whole.startsWith("-") ? "-" : "";
  const digits = whole.replace("-", "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return sign + digits + (frac ? "." + frac : "");
}

function dropsToXrp(drops) {
  const d = BigInt(drops);
  const neg = d < 0n;
  const a = neg ? -d : d;
  const frac = (a % 1000000n).toString().padStart(6, "0").replace(/0+$/, "");
  return (neg ? "-" : "") + (a / 1000000n).toString() + (frac ? "." + frac : "");
}

function ago(iso) {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 90) return s + " s ago";
  if (s < 5400) return Math.round(s / 60) + " min ago";
  if (s < 172800) return Math.round(s / 3600) + " h ago";
  return Math.round(s / 86400) + " days ago";
}

function renderBanner(d) {
  const b = document.getElementById("banner");
  const stale = Date.now() - Date.parse(d.takenAt) > STALE_AFTER_MS;
  const status = d.report.status;
  const cls = stale || status === "unverified" ? "warn" : status === "backed" && !d.problems.length ? "ok" : "bad";
  const title = { backed: "Fully backed", undercollateralised: "UNDERCOLLATERALISED", unverified: "Unverified" }[status] || status;
  b.className = "banner " + cls;
  b.replaceChildren(el("span", title + (stale ? " — data is stale" : "")), el("small", "Snapshot taken " + ago(d.takenAt) + " at XRPL ledger " + d.xrplLedger));
}

function card(label, value, unit) {
  const c = el("div", null, "card");
  c.append(el("div", label, "label"));
  const v = el("div", value, "value");
  if (unit) v.append(" ", el("span", unit, "unit"));
  c.append(v);
  return c;
}

function renderCards(d) {
  const cards = document.getElementById("cards");
  const ratio = d.report.collateralRatio;
  cards.replaceChildren(
    card("Backing (locked on XRPL)", group(d.human.backingXrp), "XRP"),
    card("Outstanding on destinations", group(d.human.outstandingXrp), "XRP"),
    card("Surplus", group(d.human.surplusXrp), "XRP"),
    card("Collateral ratio", ratio === null ? "n/a" : ratio.toFixed(6), "")
  );
}

function renderOutstanding(d) {
  const tbody = document.querySelector("#outstanding tbody");
  const rows = d.outstanding.map((o) => {
    const tr = el("tr");
    tr.append(el("td", o.chain), el("td", group(dropsToXrp(o.drops)), "num"), el("td", o.method));
    return tr;
  });
  for (const chain of d.unmeasured) {
    const tr = el("tr");
    tr.append(el("td", chain), el("td", "not measured", "num"), el("td", "Holds the token but has no tracked supply or on-chain measurer"));
    rows.push(tr);
  }
  tbody.replaceChildren(...rows);
}

function renderSigners(d) {
  const p = document.getElementById("signers");
  if (!d.signers) { p.textContent = "No signer list found on the gateway account."; return; }
  p.textContent = d.signers.count + " signers; quorum " + group(String(d.signers.quorum)) + " weight; at least " + d.signers.minForQuorum + " signers are needed to move funds.";
}

function renderProblems(d) {
  const sec = document.getElementById("problems-section");
  const ul = document.getElementById("problems");
  sec.hidden = d.problems.length === 0;
  ul.replaceChildren(...d.problems.map((x) => el("li", x)));
}

function renderChart(history) {
  const box = document.getElementById("chart");
  const note = document.getElementById("chart-note");
  const pts = history.filter((p) => p.ratio !== null);
  if (pts.length < 2) { box.replaceChildren(el("p", "Not enough history yet.", "note")); note.textContent = ""; return; }
  const W = 800, H = 160, L = 52, R = 10, T = 10, B = 22;
  const t0 = Date.parse(pts[0].t), t1 = Date.parse(pts[pts.length - 1].t);
  let lo = Math.min(1, ...pts.map((p) => p.ratio)), hi = Math.max(1, ...pts.map((p) => p.ratio));
  const rMin = Math.min(...pts.map((p) => p.ratio)), rMax = Math.max(...pts.map((p) => p.ratio));
  const pad = (hi - lo) * 0.15 || 0.001; lo -= pad; hi += pad;
  const x = (t) => L + ((Date.parse(t) - t0) / (t1 - t0 || 1)) * (W - L - R);
  const y = (r) => T + (1 - (r - lo) / (hi - lo)) * (H - T - B);
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 " + W + " " + H);
  svg.setAttribute("preserveAspectRatio", "none");
  const ref = document.createElementNS(SVG, "line");
  ref.setAttribute("class", "ref");
  ref.setAttribute("x1", L); ref.setAttribute("x2", W - R); ref.setAttribute("y1", y(1)); ref.setAttribute("y2", y(1));
  const line = document.createElementNS(SVG, "polyline");
  line.setAttribute("class", "line");
  line.setAttribute("points", pts.map((p) => x(p.t).toFixed(1) + "," + y(p.ratio).toFixed(1)).join(" "));
  svg.append(ref, line);
  box.replaceChildren(svg);
  note.textContent = pts.length + " snapshots, " + pts[0].t.slice(0, 10) + " to " + pts[pts.length - 1].t.slice(0, 10) + ". Range " + rMin.toFixed(4) + " to " + rMax.toFixed(4) + "; latest " + pts[pts.length - 1].ratio.toFixed(6) + ". Dashed line: ratio 1.";
}

function renderFooter(d) {
  const f = document.getElementById("footer");
  const a = el("a", d.gateway);
  a.href = "https://livenet.xrpl.org/accounts/" + encodeURIComponent(d.gateway);
  a.rel = "noopener noreferrer";
  f.replaceChildren("Gateway account on the XRPL (" + d.network + "): ", a);
}

async function load(path) {
  const r = await fetch(path, { cache: "no-store" });
  if (!r.ok) throw new Error(path + " HTTP " + r.status);
  return r.json();
}

(async () => {
  try {
    const d = await load("data/latest.json");
    renderBanner(d); renderCards(d); renderOutstanding(d); renderSigners(d); renderProblems(d); renderFooter(d);
    try { renderChart(await load("data/history.json")); } catch { renderChart([]); }
  } catch (e) {
    const b = document.getElementById("banner");
    b.className = "banner bad";
    b.textContent = "Could not load the latest snapshot.";
  }
})();
