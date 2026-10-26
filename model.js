/*
 * budgetTracker -- the rules.
 *
 * Every figure the app shows is worked out here, from the data file alone.
 * Every view uses this one file: render.mjs (the PDF) and server.mjs import
 * it, the app page (entry.html, on the laptop and the phone) loads it as
 * model.js, and build-phone.mjs pastes it into the sealed sample, so no two
 * of them can disagree about a balance. HANDOVER.md §2 states the rules in
 * words; §9 states how a change made on the phone reaches the file.
 *
 * Keep it plain: no Node APIs and no browser APIs, only functions over the
 * data. Every export is a "function" or "const" declaration at the start of
 * a line, because build-phone.mjs strips the word "export" to inline it.
 */

/* ------------------------------------------------------------------ *
 * Dates. Every date in the data is a "YYYY-MM-DD" string and is only
 * ever compared as a string or converted through UTC, so no time zone
 * can shift a day. "Today" comes from local time, never toISOString().
 * ------------------------------------------------------------------ */
export const pad = n => String(n).padStart(2, "0");
export const localYmd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const MONTH = ["January", "February", "March", "April", "May", "June", "July", "August",
  "September", "October", "November", "December"];
export const WEEKDAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const parts = s => s.split("-").map(Number);
export const dayNo = s => { const [y, m, d] = parts(s); return Date.UTC(y, m - 1, d) / 864e5; };
export const daysBetween = (a, b) => dayNo(b) - dayNo(a);
export const dShort = s => { const [, m, d] = parts(s); return `${d} ${MON[m - 1]}`; };
export const dLong = s => { const [y, m, d] = parts(s); return `${d} ${MON[m - 1]} ${y}`; };
export const dFull = s => {
  const [y, m, d] = parts(s);
  return `${WEEKDAY[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d} ${MONTH[m - 1]} ${y}`;
};
export const monthName = ym => { const [y, m] = parts(ym); return `${MONTH[m - 1]} ${y}`; };
/* The Indian financial year runs April to March. */
export const fyStart = s => { const [y, m] = parts(s); return `${m >= 4 ? y : y - 1}-04-01`; };
export const fyLabel = s => { const y = Number(fyStart(s).slice(0, 4)); return `${y}–${String(y + 1).slice(2)}`; };
export const days = n => (n === 1 ? "1 day" : `${n} days`);

/* ------------------------------------------------------------------ *
 * Money. Budgets are in rupees. An expense in another currency carries
 * its foreign amount and a rate; its rupee figure is the one fixed for
 * reimbursement, and until that is known it is estimated at the rate
 * and shown with "≈".
 * ------------------------------------------------------------------ */
export const IN0 = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
export const IN2 = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const rs = n => (n < 0 ? "−₹" : "₹") + IN0.format(Math.abs(Math.round(n)));
export const bare = n => IN0.format(Math.round(n));
export const sum = (xs, f = x => x) => xs.reduce((a, x) => a + f(x), 0);

export const rupees = e => e.inr ?? Math.round(e.foreign.amount * e.foreign.rate);
export const estimated = e => e.inr == null;
export const approx = (n, est) => (est ? "≈ " : "") + rs(n);
/* The date an expense reached the head's books: when you were reimbursed,
   or when the institute charged it directly. Null while still on its way. */
export const chargedOn = e => (e.paidBy === "me" ? e.reimbursed : e.charged) || null;
export const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
/* Where an expense stands: settled (reimbursed or charged), waiting (claimed,
   or booked by the institute and not yet charged) or toclaim (you paid and
   have not claimed). */
export const stage = e => (e.paidBy === "me"
  ? (e.reimbursed ? "settled" : e.claimed ? "waiting" : "toclaim")
  : (e.charged ? "settled" : "waiting"));
/* The same, in words, as [icon kind, text]. Icon kinds: good, wait, todo. */
export function standing(e, today) {
  if (e.paidBy === "me") {
    if (e.reimbursed) return ["good", `Reimbursed ${dShort(e.reimbursed)}`];
    if (e.claimed) return ["wait", `Claimed ${dShort(e.claimed)}, waiting ${days(daysBetween(e.claimed, today))}`];
    return ["todo", "Not claimed yet"];
  }
  return e.charged ? ["good", `Charged ${dShort(e.charged)}`] : ["wait", "Not charged yet"];
}

export const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/* ------------------------------------------------------------------ *
 * Checks. No view draws from a file it cannot trust, and the laptop
 * never writes one that fails. Every field is checked, and a field
 * not listed here is refused, so a typo fails at once instead of
 * living in the file. HANDOVER.md §1 describes each field.
 * ------------------------------------------------------------------ */
export const RE_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
export const RE_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
export const RE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const FIELDS = {
  file: ["version", "sample", "_note", "heads", "statements", "expenses", "payslips", "fromPhone"],
  head: ["id", "name", "code", "kind", "total", "validTill", "usedFor", "closed"],
  statement: ["head", "asOn", "balance", "source"],
  expense: ["id", "head", "date", "item", "purpose", "paidBy", "inr", "foreign", "claimed", "reimbursed", "charged"],
  foreign: ["currency", "amount", "rate"],
  payslip: ["month", "earnings", "deductions", "credited", "file"],
  earning: ["label", "amount"],
  deduction: ["label", "amount", "kind"],
  credited: ["date", "amount"],
};
export function problems(d) {
  const bad = [];
  const obj = v => v && typeof v === "object" && !Array.isArray(v);
  const num = v => typeof v === "number" && Number.isFinite(v);
  const text = v => typeof v === "string" && v.trim() !== "";
  const date = v => typeof v === "string" && RE_DATE.test(v);
  const optText = v => v == null || typeof v === "string";
  const optDate = v => v == null || date(v);
  const only = (o, kind, at) => { for (const k of Object.keys(o)) if (!FIELDS[kind].includes(k)) bad.push(`${at}: unexpected field "${k}"`); };
  if (!obj(d)) return ["the file is not a JSON object"];
  only(d, "file", "file");
  for (const k of ["heads", "statements", "expenses", "payslips"]) if (!Array.isArray(d[k])) bad.push(`"${k}" is not a list`);
  if (d.fromPhone != null && !(Array.isArray(d.fromPhone) && d.fromPhone.length <= 1000 && d.fromPhone.every(x => typeof x === "string" && RE_ID.test(x))))
    bad.push(`"fromPhone" must be a list of change ids`);
  if (bad.length) return bad;

  const kinds = new Map();
  d.heads.forEach((h, i) => {
    const at = `head ${i + 1}${h?.id ? ` (${h.id})` : ""}`;
    if (!obj(h)) return bad.push(`${at}: not an object`);
    only(h, "head", at);
    if (typeof h.id !== "string" || !RE_ID.test(h.id)) bad.push(`${at}: bad id`);
    else if (kinds.has(h.id)) bad.push(`${at}: id used twice`);
    if (!text(h.name)) bad.push(`${at}: no name`);
    if (h.kind !== "finite" && h.kind !== "open") bad.push(`${at}: kind must be finite or open`);
    if (!optText(h.code) || !optText(h.usedFor)) bad.push(`${at}: code and usedFor must be text`);
    if (h.total != null && (!num(h.total) || h.kind !== "finite")) bad.push(`${at}: total must be a number, on a finite head`);
    if (!optDate(h.validTill)) bad.push(`${at}: validTill must be a date`);
    if (h.closed != null && typeof h.closed !== "boolean") bad.push(`${at}: closed must be true or false`);
    kinds.set(h.id, h.kind);
  });

  const seenSt = new Set();
  d.statements.forEach((s, i) => {
    const at = `balance ${i + 1}${s?.asOn ? ` (${s.head}, ${s.asOn})` : ""}`;
    if (!obj(s)) return bad.push(`${at}: not an object`);
    only(s, "statement", at);
    if (kinds.get(s.head) !== "finite") bad.push(`${at}: head must be a finite head`);
    if (!date(s.asOn)) bad.push(`${at}: asOn must be a date`);
    if (!num(s.balance)) bad.push(`${at}: balance must be a number`);
    if (!optText(s.source)) bad.push(`${at}: source must be text`);
    if (seenSt.has(s.head + s.asOn)) bad.push(`${at}: a second balance for the same head and date`);
    seenSt.add(s.head + s.asOn);
  });

  const seenEx = new Set();
  d.expenses.forEach((e, i) => {
    const at = `expense ${i + 1}${e?.id ? ` (${e.id})` : ""}`;
    if (!obj(e)) return bad.push(`${at}: not an object`);
    only(e, "expense", at);
    if (typeof e.id !== "string" || !RE_ID.test(e.id)) bad.push(`${at}: bad id`);
    else if (seenEx.has(e.id)) bad.push(`${at}: id used twice`);
    seenEx.add(e.id);
    if (!kinds.has(e.head)) bad.push(`${at}: unknown head "${e.head}"`);
    if (!date(e.date)) bad.push(`${at}: date must be a date`);
    if (!text(e.item)) bad.push(`${at}: no item`);
    if (!optText(e.purpose)) bad.push(`${at}: purpose must be text`);
    if (e.paidBy !== "me" && e.paidBy !== "institute") bad.push(`${at}: paidBy must be me or institute`);
    if (e.inr != null && !num(e.inr)) bad.push(`${at}: inr must be a number`);
    if (e.foreign != null) {
      if (!obj(e.foreign)) bad.push(`${at}: foreign must be an object`);
      else {
        only(e.foreign, "foreign", at + " foreign");
        if (typeof e.foreign.currency !== "string" || !/^[A-Z]{3}$/.test(e.foreign.currency)) bad.push(`${at}: currency must be a three-letter code`);
        if (!num(e.foreign.amount)) bad.push(`${at}: foreign amount must be a number`);
        if (!num(e.foreign.rate) || e.foreign.rate <= 0) bad.push(`${at}: rate must be a positive number`);
      }
    }
    if (e.inr == null && e.foreign == null) bad.push(`${at}: no rupee amount and no foreign amount`);
    for (const k of ["claimed", "reimbursed", "charged"]) if (!optDate(e[k])) bad.push(`${at}: ${k} must be a date`);
    if (e.paidBy === "me" && e.charged != null) bad.push(`${at}: "charged" is for institute bookings`);
    if (e.paidBy === "institute" && (e.claimed != null || e.reimbursed != null)) bad.push(`${at}: "claimed" and "reimbursed" are for expenses you paid`);
  });

  const seenMonth = new Set();
  d.payslips.forEach((p, i) => {
    const at = `payslip ${i + 1}${p?.month ? ` (${p.month})` : ""}`;
    if (!obj(p)) return bad.push(`${at}: not an object`);
    only(p, "payslip", at);
    if (typeof p.month !== "string" || !RE_MONTH.test(p.month)) bad.push(`${at}: month must be YYYY-MM`);
    else if (seenMonth.has(p.month)) bad.push(`${at}: a second payslip for the same month`);
    seenMonth.add(p.month);
    for (const [k, kind] of [["earnings", "earning"], ["deductions", "deduction"]]) {
      if (!Array.isArray(p[k])) { bad.push(`${at}: ${k} is not a list`); continue; }
      p[k].forEach((x, j) => {
        if (!obj(x)) return bad.push(`${at} ${k} ${j + 1}: not an object`);
        only(x, kind, `${at} ${k} ${j + 1}`);
        if (!text(x.label) || !num(x.amount)) bad.push(`${at} ${k} ${j + 1}: needs a label and an amount`);
        if (kind === "deduction" && !["tax", "retirement", "other"].includes(x.kind)) bad.push(`${at} ${k} ${j + 1}: kind must be tax, retirement or other`);
      });
    }
    if (p.credited != null) {
      if (!obj(p.credited)) bad.push(`${at}: credited must be an object`);
      else {
        only(p.credited, "credited", at + " credited");
        if (!date(p.credited.date) || !num(p.credited.amount)) bad.push(`${at}: credited needs a date and an amount`);
      }
    }
    if (!optText(p.file)) bad.push(`${at}: file must be text`);
  });
  return bad;
}
export function validate(d) {
  const bad = problems(d);
  if (bad.length) throw new Error("data file has problems:\n  " + bad.slice(0, 20).join("\n  ") + (bad.length > 20 ? `\n  … and ${bad.length - 20} more` : ""));
}

/* ------------------------------------------------------------------ *
 * The file as written: one line per entry, fields in a fixed order,
 * entries sorted, so it reads well and Dropbox's version history shows
 * small, clear changes. An empty field is left out; a null rupee amount
 * is kept, because it means "foreign, not fixed yet".
 * ------------------------------------------------------------------ */
export function pick(o, kind) {
  const out = {};
  for (const k of FIELDS[kind]) {
    const v = o[k];
    if (v === undefined || (v === null && k !== "inr") || v === "") continue;
    out[k] = k === "foreign" ? pick(v, "foreign") : k === "credited" ? pick(v, "credited")
      : k === "earnings" ? v.map(x => pick(x, "earning")) : k === "deductions" ? v.map(x => pick(x, "deduction")) : v;
  }
  return out;
}
/* fromPhone: the ids of the phone's change files the laptop has dealt with
   (added in, or set aside), latest last, the most recent FROM_PHONE_KEPT of
   them. HANDOVER.md §9 says what it is for. */
export const FROM_PHONE_KEPT = 200;
export function canonical(doc) {
  const by = (...keys) => (a, b) => { for (const k of keys) { if (a[k] < b[k]) return -1; if (a[k] > b[k]) return 1; } return 0; };
  return {
    version: 1,
    heads: doc.heads.map(h => pick(h, "head")),
    statements: doc.statements.map(s => pick(s, "statement")).sort(by("head", "asOn")),
    expenses: doc.expenses.map(e => pick(e, "expense")).sort(by("date", "id")),
    payslips: doc.payslips.map(p => pick(p, "payslip")).sort(by("month")),
    ...(doc.fromPhone?.length ? { fromPhone: doc.fromPhone.slice(-FROM_PHONE_KEPT) } : {}),
  };
}
export function format(doc) {
  const keys = Object.keys(doc);
  const lines = ["{"];
  keys.forEach((k, i) => {
    const v = doc[k], comma = i < keys.length - 1 ? "," : "";
    if (!Array.isArray(v) || v.every(x => typeof x !== "object")) lines.push(`  ${JSON.stringify(k)}: ${JSON.stringify(v)}${comma}`);
    else lines.push(`  ${JSON.stringify(k)}: [`, ...v.map((x, j) => `    ${JSON.stringify(x)}${j < v.length - 1 ? "," : ""}`), `  ]${comma}`);
  });
  return lines.join("\n") + "\n}\n";
}

/* ------------------------------------------------------------------ *
 * Changes. A save is described as the entries it changed, each with
 * its state before and after, so it can be laid onto a file that has
 * moved on since: that is how a change made on the phone reaches the
 * laptop's file, how a laptop save survives a phone change arriving
 * first, and how Undo takes back one change and nothing else.
 *
 * An entry is known by its key: a head or an expense by its id, a
 * balance by head and date, a payslip by its month. A change is
 *   { kind, key, before, after, pos? }
 * with before null for a new entry and after null for a deleted one.
 * pos, on heads only, is [index before, index after], so a head put
 * back by Undo returns to its place.
 *
 * A change is applied only if the entry is still as it was before.
 * If it is already as it should be after, it is passed over (so a
 * change applied twice does no harm). Anything else is a conflict:
 * the entry was changed somewhere else meanwhile, and a person decides.
 * ------------------------------------------------------------------ */
export const KINDS = ["head", "statement", "expense", "payslip"];
export const LIST = { head: "heads", statement: "statements", expense: "expenses", payslip: "payslips" };
export function entryKey(kind, x) {
  return kind === "statement" ? `${x.head}|${x.asOn}` : kind === "payslip" ? x.month : x.id;
}
export function sameEntry(kind, a, b) {
  if (a == null || b == null) return a == null && b == null;
  return JSON.stringify(pick(a, kind)) === JSON.stringify(pick(b, kind));
}
export function findEntry(doc, kind, key) {
  return doc[LIST[kind]].find(x => entryKey(kind, x) === key) || null;
}

export function diffDocs(a, b) {
  const out = [];
  for (const kind of KINDS) {
    const index = d => new Map(d[LIST[kind]].map((x, i) => [entryKey(kind, x), [x, i]]));
    const am = index(a), bm = index(b);
    for (const key of new Set([...am.keys(), ...bm.keys()])) {
      const [x, i] = am.get(key) || [null, null], [y, j] = bm.get(key) || [null, null];
      if (sameEntry(kind, x, y)) continue;
      const c = { kind, key, before: x && pick(x, kind), after: y && pick(y, kind) };
      if (kind === "head") c.pos = [i, j];
      out.push(c);
    }
  }
  return out;
}
export const invert = changes => changes.map(c => ({ ...c, before: c.after, after: c.before, ...(c.pos ? { pos: [c.pos[1], c.pos[0]] } : {}) }));

/* force applies each change whatever the entry holds now: "use this
   version" after a person has looked at a conflict. */
export function applyChanges(doc, changes, force = false) {
  const out = JSON.parse(JSON.stringify(doc));
  const conflicts = [];
  for (const c of changes) {
    const list = out[LIST[c.kind]];
    const i = list.findIndex(x => entryKey(c.kind, x) === c.key);
    const cur = i >= 0 ? list[i] : null;
    if (sameEntry(c.kind, cur, c.after)) continue;
    if (!force && !sameEntry(c.kind, cur, c.before)) { conflicts.push({ ...c, current: cur }); continue; }
    if (c.after == null) list.splice(i, 1);
    else if (i >= 0) list[i] = c.after;
    else if (c.pos?.[1] != null) list.splice(Math.min(c.pos[1], list.length), 0, c.after);
    else list.push(c.after);
  }
  return { doc: out, conflicts };
}

/* One entry on its own, checked as problems() would check it in a file. A
   balance or expense is given a stand-in head, since its head is checked
   only once it is laid on. */
export function entryProblems(kind, x) {
  const d = { heads: [], statements: [], expenses: [], payslips: [] };
  if (kind === "head") d.heads.push(x);
  else if (kind === "payslip") d.payslips.push(x);
  else {
    d.heads.push({ id: typeof x.head === "string" && RE_ID.test(x.head) ? x.head : "h", name: "h", kind: "finite" });
    d[LIST[kind]].push(x);
  }
  return problems(d);
}

/* A change file: one save made on the phone, written to inbox/ in the
   app folder. made is the phone's local time; note is what the phone
   said when it saved ("Added “Taxi”, ₹450 on FDA."). */
export const CHANGE_FIELDS = ["version", "id", "made", "note", "base", "changes"];
export function changeProblems(f) {
  const obj = v => v && typeof v === "object" && !Array.isArray(v);
  if (!obj(f)) return ["not a JSON object"];
  const bad = [];
  for (const k of Object.keys(f)) if (!CHANGE_FIELDS.includes(k)) bad.push(`unexpected field "${k}"`);
  if (f.version !== 1) bad.push("version must be 1");
  if (typeof f.id !== "string" || !RE_ID.test(f.id)) bad.push("bad id");
  if (typeof f.made !== "string" || Number.isNaN(Date.parse(f.made))) bad.push("made must be a time");
  if (f.note != null && typeof f.note !== "string") bad.push("note must be text");
  if (f.base != null && typeof f.base !== "string") bad.push("base must be text");
  if (!Array.isArray(f.changes) || !f.changes.length) return [...bad, "no changes"];
  f.changes.forEach((c, i) => {
    const at = `change ${i + 1}`;
    if (!obj(c) || !KINDS.includes(c.kind) || typeof c.key !== "string") return bad.push(`${at}: needs a kind and a key`);
    for (const k of Object.keys(c)) if (!["kind", "key", "before", "after", "pos"].includes(k)) bad.push(`${at}: unexpected field "${k}"`);
    if (c.before == null && c.after == null) bad.push(`${at}: neither before nor after`);
    for (const side of ["before", "after"]) {
      if (c[side] == null) continue;
      if (!obj(c[side])) { bad.push(`${at}: ${side} must be an entry`); continue; }
      const wrong = entryProblems(c.kind, c[side]);
      if (wrong.length) bad.push(`${at}: ${side}: ${wrong[0]}`);
      else if (entryKey(c.kind, c[side]) !== c.key) bad.push(`${at}: ${side} does not match the key`);
    }
    if (c.pos != null && !(Array.isArray(c.pos) && c.pos.length === 2 && c.pos.every(n => n === null || Number.isInteger(n)))) bad.push(`${at}: bad pos`);
  });
  return bad;
}

/* Lay change files onto a file, oldest first. A file is applied whole
   or not at all (it is one save: deleting a head takes its entries with
   it), and only if the result still passes every check. The rest are
   held, with the reason. The laptop uses this to add the phone's changes
   into budget.json; the phone uses it to show them before that. */
export function foldChanges(doc, files) {
  const order = [...files].sort((a, b) => Date.parse(a.made) - Date.parse(b.made) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  let cur = doc;
  const applied = [], held = [];
  for (const f of order) {
    const r = applyChanges(cur, f.changes);
    if (r.conflicts.length) { held.push({ file: f, why: "conflict", conflicts: r.conflicts }); continue; }
    const bad = problems(r.doc);
    if (bad.length) { held.push({ file: f, why: "invalid", problems: bad }); continue; }
    cur = r.doc;
    applied.push(f);
  }
  return { doc: cur, applied, held };
}

/* ------------------------------------------------------------------ *
 * The model: everything a view shows, computed once.
 * ------------------------------------------------------------------ */
export function finiteHead(h, d, today) {
  const sts = d.statements.filter(s => s.head === h.id).sort((a, b) => (a.asOn < b.asOn ? -1 : 1));
  const exps = d.expenses.filter(e => e.head === h.id).sort(byDate);
  const last = sts.at(-1) || null;

  // Each statement is checked against the one before it, less what was charged in between.
  const checks = sts.slice(1).map((s, i) => {
    const prev = sts[i];
    const between = exps.filter(e => { const c = chargedOn(e); return c && c > prev.asOn && c <= s.asOn; });
    const expected = prev.balance - sum(between, rupees);
    return { statement: s, prev, expected, gap: s.balance - expected };
  });

  // Available = the latest balance from accounts, less everything not yet in it.
  // With neither a balance nor a total there is nothing to subtract from, so
  // available is unknown (null), not a negative number.
  const pending = exps.filter(e => { const c = chargedOn(e); return !(last && c && c <= last.asOn); });
  const base = last ? last.balance : (h.total ?? null);
  const available = base == null ? null : base - sum(pending, rupees);
  const usedShare = h.total && available != null ? (h.total - available) / h.total : null;
  const left = h.validTill ? daysBetween(today, h.validTill) : null;

  const flags = [];
  if (!last) flags.push(["warn", "No balance from accounts entered yet"]);
  if (available != null && available < 0) flags.push(["crit", `Overspent by ${rs(-available)}`]);
  else if (usedShare >= 0.8) flags.push(["warn", `Running low: ${Math.round(usedShare * 100)}% used`]);
  if (left != null && left < 0) flags.push(["crit", `Ended ${dLong(h.validTill)}`]);
  else if (left != null && left <= 90 && h.total && available != null && available / h.total > 0.25)
    flags.push(["warn", `Ends in ${days(left)} with ${Math.round((available / h.total) * 100)}% unspent`]);
  const lastCheck = checks.at(-1);
  if (lastCheck && Math.round(lastCheck.gap) !== 0)
    flags.push(["warn", `${dShort(lastCheck.statement.asOn)} statement ${rs(Math.abs(lastCheck.gap))} ${lastCheck.gap < 0 ? "below" : "above"} expected`]);

  const state = available == null ? "none" : available < 0 ? "crit" : usedShare >= 0.8 ? "warn" : "ok";
  return { h, sts, exps, last, checks, pending, available, usedShare, left, flags, state,
    est: pending.some(estimated) };
}

export function openHead(h, d, today) {
  const fy0 = fyStart(today);
  const exps = d.expenses.filter(e => e.head === h.id).sort(byDate);
  const fy = exps.filter(e => e.date >= fy0);
  const byPurpose = new Map();
  for (const e of fy) {
    const k = e.purpose || "No purpose given";
    const p = byPurpose.get(k) || { total: 0, est: false };
    p.total += rupees(e);
    p.est ||= estimated(e);
    byPurpose.set(k, p);
  }
  const flags = [];
  const missing = exps.filter(e => !e.purpose).length;
  if (missing) flags.push(["warn", `${missing} expense${missing > 1 ? "s" : ""} with no purpose recorded`]);
  return { h, exps, fy, total: sum(fy, rupees), est: fy.some(estimated), flags,
    purposes: [...byPurpose].sort((a, b) => b[1].total - a[1].total) };
}

export const gross = p => sum(p.earnings, x => x.amount);
export const net = p => gross(p) - sum(p.deductions, x => x.amount);
export const ofKind = (p, k) => sum(p.deductions.filter(x => x.kind === k), x => x.amount);
export const creditGap = p => (p.credited ? Math.round(p.credited.amount - net(p)) : null);

/* A closed head (closed: true) is one no longer in use. Its entries stay in
   the history and still count in "owed to you", but the summaries list only
   the open heads, in `active`. `heads` keeps every head, for the ledgers. */
export function buildModel(d, today) {
  const fy0 = fyStart(today);
  const heads = d.heads.map(h => (h.kind === "finite" ? finiteHead(h, d, today) : openHead(h, d, today)));
  const active = heads.filter(x => !x.h.closed);
  const headName = Object.fromEntries(d.heads.map(h => [h.id, h.name]));

  const mine = d.expenses.filter(e => e.paidBy === "me" && !e.reimbursed);
  const claimed = mine.filter(e => e.claimed).sort((a, b) => (a.claimed < b.claimed ? -1 : 1));
  const unclaimed = mine.filter(e => !e.claimed).sort(byDate);

  const slips = [...d.payslips].sort((a, b) => (a.month < b.month ? -1 : 1));
  const fySlips = slips.filter(p => p.month >= fy0.slice(0, 7));
  const short = fySlips.filter(p => p.credited && creditGap(p) !== 0);

  return { d, today, fy0, heads, active, headName, mine, claimed, unclaimed, slips, fySlips, short,
    latest: slips.at(-1) || null };
}
