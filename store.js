/*
 * budgetTracker -- how the app page reaches the data on the phone: Dropbox.
 *
 * build-phone.mjs publishes this as store.js beside the page (entry.html,
 * published as index.html), in place of laptop-store.js; see that file for
 * what a store gives the page. The page holds no figures. It signs in to
 * Dropbox once (OAuth with PKCE, so no app secret) and works only in the
 * app's own Dropbox folder, the one place Dropbox lets it see:
 *
 *   - It reads budget.json, the file the laptop app writes.
 *   - It never writes budget.json. Each save made here becomes one small
 *     file of its own in inbox/, which the laptop app adds into budget.json
 *     the next time it runs (server.mjs). Until then this page shows
 *     budget.json with those changes laid on top, using foldChanges() from
 *     model.mjs, the same function the laptop uses to add them.
 *   - Payslip PDFs go to payslips/, as on the laptop.
 *
 * A save is kept on the phone first (the "outbox", in IndexedDB) and sent
 * when Dropbox can be reached, so nothing entered offline is lost. The last
 * good copy of everything read is kept too, so the app opens at once and
 * offline; every open checks Dropbox for something newer.
 */
import { localYmd, pad, dLong, diffDocs, foldChanges, changeProblems, validate, sameEntry, findEntry, RE_MONTH } from "./model.js?v=Ok7HKjjFO";

const CFG = JSON.parse(document.getElementById("config").textContent);
const DIR = CFG.file.replace(/[^/]*$/, "");
const INBOX = DIR + "inbox";
const slipPath = month => `${DIR}payslips/${month}.pdf`;
const WRITE = "files.content.write";
const GONE_AFTER = 7 * 864e5; // see check(): a last resort for a change file that vanished unrecorded

/* Browser storage: one IndexedDB store of small records, the same one the
   read-only app used, so its sign-in carries over. Every call may fail
   (private window, cleared data); callers then carry on without it. A write
   counts as done only once its transaction has completed. */
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("budgetTracker", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("keys");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function kv(mode, fn) {
  try {
    const db = await idb();
    return await new Promise(res => {
      const tx = db.transaction("keys", mode);
      const req = fn(tx.objectStore("keys"));
      let v;
      req.onsuccess = () => (v = req.result);
      tx.oncomplete = () => { db.close(); res({ ok: true, v }); };
      tx.onerror = tx.onabort = () => { db.close(); res({ ok: false }); };
    });
  } catch { return { ok: false }; }
}
const kvGet = async id => (await kv("readonly", s => s.get(id))).v ?? null;
const kvPut = async (id, v) => (await kv("readwrite", s => s.put(v, id))).ok;
const kvDel = async id => (await kv("readwrite", s => s.delete(id))).ok;
/* The outbox: one record per unsent change ("out:<id>"), so two copies of the
   app open at once (the installed app and a browser tab) never overwrite
   each other's. */
const OUT = () => IDBKeyRange.bound("out:", "out:\uffff");
const outAll = async () => { const r = await kv("readonly", s => s.getAll(OUT())); return r.ok ? r.v : null; };
const outPut = f => kvPut("out:" + f.id, f);
const outDel = id => kvDel("out:" + id);
const byMade = (a, b) => Date.parse(a.made) - Date.parse(b.made) || (a.id < b.id ? -1 : 1);

/* ------------------------------------------------------------------ *
 * State
 *   auth    { refresh, access, expiresAt, scope }   the Dropbox sign-in
 *   copy    { data, rev, modified, checked, inbox } the last good read:
 *           budget.json, its Dropbox rev, and the change files seen in
 *           inbox/, as { id: { file, missingSince } }
 *   outbox  [change file]                           saves not sent yet, one
 *                                                   record each ("out:<id>")
 * ------------------------------------------------------------------ */
let page = null, auth = null, copy = null, outbox = [], problem = null, checking = null, flushing = null, signInNote = "";
/* May this sign-in save? What Dropbox has said when a save was tried (auth.write)
   comes first; then the scopes it named at sign-in; a sign-in kept from the
   read-only app has neither, and is tried. */
const canWrite = () => auth?.write ?? (auth?.scope != null ? auth.scope.split(" ").includes(WRITE) : null);
async function learned(write) { if (auth && auth.write !== write) { auth = { ...auth, write }; await kvPut("dropbox", auth); } }

class DbxError extends Error {
  // kind: "net" (no answer), "signedout", "scope" (may read, not write), "missing", "conflict", "bad"
  constructor(kind, message = "") { super(message); this.kind = kind; }
}
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const hhmm = t => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const when = t => `${localYmd(new Date(t)) === localYmd(new Date()) ? "today" : dLong(localYmd(new Date(t)))}, ${hhmm(t)}`;
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const newId = () => "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
function localIso(d = new Date()) {
  const off = -d.getTimezoneOffset(), sign = off < 0 ? "-" : "+";
  return `${localYmd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

/* ------------------------------------------------------------------ *
 * Dropbox
 * ------------------------------------------------------------------ */
async function tokenCall(params) {
  let r;
  try { r = await fetch(CFG.api + "/oauth2/token", { method: "POST", body: new URLSearchParams({ client_id: CFG.appKey, ...params }) }); }
  catch { throw new DbxError("net", "no connection"); }
  const j = await r.json().catch(() => ({}));
  if (r.status === 400 || r.status === 401) throw new DbxError("signedout", j.error_description || j.error || `Dropbox answered ${r.status}`);
  if (!r.ok || !j.access_token) throw new DbxError("net", `Dropbox answered ${r.status}`);
  return j;
}
async function accessToken(force) {
  if (!force && auth.access && auth.expiresAt > Date.now()) return auth.access;
  const t = await tokenCall({ grant_type: "refresh_token", refresh_token: auth.refresh });
  auth = { ...auth, access: t.access_token, expiresAt: Date.now() + (t.expires_in - 300) * 1000 };
  await kvPut("dropbox", auth);
  return auth.access;
}
async function dbx(host, path, init, retried = false) {
  const token = await accessToken(retried);
  let r;
  try { r = await fetch(host + path, { method: "POST", ...init, headers: { Authorization: "Bearer " + token, ...init.headers } }); }
  catch { throw new DbxError("net", "no connection"); }
  if (r.status === 401) {
    const j = await r.json().catch(() => ({}));
    // Signed in, but Dropbox lets this app read only: a new sign-in is needed to save.
    if (/missing_scope/.test(j.error_summary || "")) throw new DbxError("scope", "Dropbox does not let this app save yet");
    if (!retried) return dbx(host, path, init, true);
    throw new DbxError("signedout", "Dropbox no longer accepts this phone's sign-in");
  }
  if (r.status === 409) {
    const j = await r.json().catch(() => ({}));
    const s = j.error_summary || "";
    throw new DbxError(/not_found/.test(s) ? "missing" : /conflict/.test(s) ? "conflict" : "bad", s || "Dropbox error");
  }
  if (!r.ok) throw new DbxError("net", `Dropbox answered ${r.status}`);
  return r;
}
const arg = o => ({ "Dropbox-API-Arg": JSON.stringify(o) });
const apiJson = async (path, body) => (await dbx(CFG.api, path, { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
const download = path => dbx(CFG.content, "/2/files/download", { headers: arg({ path }) });
const upload = (path, body, mode) => dbx(CFG.content, "/2/files/upload",
  { headers: { "Content-Type": "application/octet-stream", ...arg({ path, mode, autorename: false, mute: true }) }, body });

async function listInbox() {
  const names = [];
  let j;
  try { j = await apiJson("/2/files/list_folder", { path: INBOX }); }
  catch (e) { if (e.kind === "missing") return names; throw e; }
  for (;;) {
    for (const e of j.entries) if (e[".tag"] === "file" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.json$/.test(e.name)) names.push(e.name.replace(/\.json$/, ""));
    if (!j.has_more) return names;
    j = await apiJson("/2/files/list_folder/continue", { cursor: j.cursor });
  }
}

/* ------------------------------------------------------------------ *
 * Signing in
 * ------------------------------------------------------------------ */
const PKCE = "budgetTracker-pkce";
async function signIn() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  try { localStorage.setItem(PKCE, JSON.stringify({ verifier, state })); }
  catch { return connect("This browser is refusing storage, so it cannot stay signed in. Turn off private browsing and try again."); }
  location.href = CFG.www + "/oauth2/authorize?" + new URLSearchParams({ client_id: CFG.appKey, response_type: "code",
    token_access_type: "offline", code_challenge: challenge, code_challenge_method: "S256", redirect_uri: CFG.redirect, state });
}

/* Back from Dropbox's sign-in page with ?code= (or ?error=). */
async function finishSignIn(q) {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(PKCE)); localStorage.removeItem(PKCE); } catch {}
  history.replaceState(null, "", location.pathname + location.hash);
  if (q.get("error")) return connect(`Dropbox did not sign you in (${q.get("error_description") || q.get("error")}).`), false;
  if (!saved || saved.state !== q.get("state")) return connect("That sign-in did not match this page. Please try again."), false;
  try {
    const t = await tokenCall({ grant_type: "authorization_code", code: q.get("code"), code_verifier: saved.verifier, redirect_uri: CFG.redirect });
    if (!t.refresh_token) throw new DbxError("signedout", "Dropbox gave no lasting sign-in");
    auth = { refresh: t.refresh_token, access: t.access_token, expiresAt: Date.now() + (t.expires_in - 300) * 1000, scope: t.scope || "" };
  } catch (e) { return connect(`Sign-in did not finish: ${e.message}.`), false; }
  if (!(await kvPut("dropbox", auth))) signInNote = "This browser would not keep the sign-in, so it will ask again next time.";
  return true;
}

async function signOut() {
  outbox = (await outAll()) || outbox;
  if (outbox.length && !confirm(`${plural(outbox.length, "change")} made on this phone ${outbox.length === 1 ? "has" : "have"} not reached Dropbox yet, and would be lost. Sign out anyway?`)) return;
  if (auth) {
    // Revoking the access token also cancels the refresh token behind it.
    try { const token = await accessToken(); await fetch(CFG.api + "/2/auth/token/revoke", { method: "POST", headers: { Authorization: "Bearer " + token } }); } catch {}
  }
  auth = null; copy = null; outbox = []; problem = null;
  await kvDel("dropbox"); await kvDel("copy"); await kv("readwrite", s => s.delete(OUT()));
  connect("Signed out. Nothing from your budget is kept on this phone now.", false);
}

/* ------------------------------------------------------------------ *
 * What the page shows: budget.json with every change not yet in it laid
 * on top -- those in inbox/ and those still on this phone -- oldest first.
 * ------------------------------------------------------------------ */
/* Dealt with by the laptop (added in, or set aside): named in budget.json's
   fromPhone. Already in budget.json: every entry it changes is as it left it. */
const dealt = id => (copy.data.fromPhone || []).includes(id);
const absorbed = f => f.changes.every(c => sameEntry(c.kind, findEntry(copy.data, c.kind, c.key), c.after));
function pendingFiles() {
  const m = new Map();
  for (const x of Object.values(copy.inbox)) if (x.file && !dealt(x.file.id)) m.set(x.file.id, x.file);
  for (const f of outbox) m.set(f.id, f);
  return [...m.values()];
}
function compose() {
  const files = pendingFiles();
  const r = foldChanges(copy.data, files);
  const waiting = r.applied.filter(f => !absorbed(f)).length;
  const stamp = copy.modified ? `Updated ${when(copy.modified)}` : "Updated";
  return {
    doc: r.doc, sample: copy.data.sample === true, missing: false,
    etag: [copy.rev, ...files.map(f => f.id).sort()].join("+"),
    held: r.held.map(h => ({ id: h.file.id, made: h.file.made, note: h.file.note ?? null, why: h.why, conflicts: h.conflicts ?? [], problems: h.problems ?? [] })),
    unsent: outbox.length,
    label: stamp + (outbox.length ? ` · ${outbox.length} on this phone only` : waiting ? ` · ${waiting} not yet on the laptop` : ""),
  };
}

function connect(message = "", isError = true) {
  page.show({ connect: { signedIn: !!auth, checking: !!checking, message: message || connectText(), isError: message ? isError : !!problem && problem.kind !== "missing" } });
}
function connectText() {
  if (checking) return "Checking Dropbox…";
  if (!problem) return "";
  return {
    net: "Can't reach Dropbox. Check the connection and try again.",
    signedout: "Dropbox has signed this phone out. Please sign in again.",
    missing: "Signed in. There is no budget file in the app's Dropbox folder yet. Start your budget in the laptop app; it appears here after that.",
    bad: `The file in Dropbox could not be read: ${problem.message}`,
  }[problem.kind] || problem.message;
}

/* The line across the top: what went wrong, or what needs doing. */
function report() {
  const st = copy ? compose() : null;
  const last = copy ? `Showing the copy checked ${when(copy.checked)}.` : "";
  const kept = st?.unsent ? ` ${plural(st.unsent, "change")} made here ${st.unsent === 1 ? "is" : "are"} kept on this phone and sent when it can.` : "";
  const again = { label: "Sign in again", act: "signin" };
  if (problem?.kind === "net") return page.status("info", `Can't reach Dropbox. ${last}${kept}`);
  if (problem?.kind === "signedout") return page.status("warn", `Dropbox has signed this phone out. ${last}${kept}`, again);
  if (problem?.kind === "missing") return page.status("warn", `The budget file is no longer in Dropbox. ${last}`);
  if (problem?.kind === "bad") return page.status("warn", `The file in Dropbox could not be read (${problem.message}). Showing the last good copy.`);
  if (auth && canWrite() === false)
    return page.status("warn", "Dropbox lets this app read your budget but not save to it yet." +
      (auth.scope != null && !auth.scope.includes(WRITE) ? " Allow it in the Dropbox App Console (Permissions: files.content.write), then sign in again." : " Sign in again to allow it.") + kept, again);
  if (st?.held.length) return page.status("warn", `${plural(st.held.length, "change")} made on this phone ${st.held.length === 1 ? "clashes" : "clash"} with a change made on the laptop. Open the laptop app to decide.`);
  page.status(null);
}

/* ------------------------------------------------------------------ *
 * Sending and checking
 * ------------------------------------------------------------------ */
/* Send the outbox, oldest first, including any another copy of the app has
   kept. Stops at the first failure and keeps the rest. One send at a time: a
   save made while one runs joins it. A change sent twice (its answer lost)
   is either refused by Dropbox as already there, or set aside by the laptop
   as already dealt with. */
function flush() {
  return (flushing ??= (async () => {
    try {
      for (const f of (await outAll()) || []) if (!outbox.some(x => x.id === f.id)) outbox.push(f);
      outbox.sort(byMade);
      while (outbox.length) {
        const f = outbox[0];
        try { await upload(`${INBOX}/${f.id}.json`, JSON.stringify(f), "add"); }
        catch (e) {
          if (e.kind === "scope") await learned(false);
          if (e.kind !== "conflict") throw e; // conflict: it is there already, from a send whose answer was lost
        }
        await learned(true);
        outbox = outbox.filter(x => x !== f);
        copy.inbox[f.id] = { file: f, missingSince: null };
        await outDel(f.id);
        await kvPut("copy", copy);
      }
    } finally { flushing = null; }
  })());
}

/* Read budget.json if it has changed, and the change files in inbox/.
   The laptop records each change it deals with in budget.json's fromPhone,
   in the same write, and only then moves the change file out of inbox/. But
   Dropbox may bring the two to the phone in either order. So a change is
   shown until budget.json names it, whether or not its file is still listed;
   and a change already in the file is passed over, so showing it twice does
   no harm. GONE_AFTER is a last resort, for a change file that went without
   being recorded (taken out by hand). */
async function check() {
  if (checking) return checking;
  checking = (async () => {
    if (!copy) connect();
    page.busy?.(true);
    try {
      if (outbox.length && copy && canWrite() !== false) await flush().catch(e => { if (e.kind !== "scope") throw e; });
      const meta = await apiJson("/2/files/get_metadata", { path: CFG.file });
      if (!copy || meta.rev !== copy.rev) {
        const text = await (await download(CFG.file)).text();
        let data;
        try { data = JSON.parse(text); validate(data); } catch (e) { throw new DbxError("bad", e.message); }
        copy = { inbox: {}, ...copy, data, rev: meta.rev, modified: meta.client_modified };
      }
      const now = Date.now(), listed = new Set(await listInbox());
      for (const id of listed) {
        const x = copy.inbox[id];
        if (x) { x.missingSince = null; continue; }
        let file = null;
        try { file = JSON.parse(await (await download(`${INBOX}/${id}.json`)).text()); if (changeProblems(file).length || file.id !== id) file = null; }
        catch (e) { if (e.kind === "net" || e.kind === "signedout") throw e; }
        copy.inbox[id] = { file, missingSince: null }; // file null: unreadable, so not shown (the laptop holds it)
      }
      for (const [id, x] of Object.entries(copy.inbox)) {
        if (listed.has(id)) continue;
        if (!x.file || dealt(id) || (x.missingSince && now - x.missingSince > GONE_AFTER)) delete copy.inbox[id];
        else x.missingSince ??= now;
      }
      copy.checked = now;
      await kvPut("copy", copy);
      problem = null;
    } catch (e) {
      problem = e instanceof DbxError ? e : new DbxError("bad", String(e?.message || e));
      if (problem.kind === "signedout") { auth = null; await kvDel("dropbox"); }
    } finally {
      checking = null;
      page.busy?.(false);
    }
    if (copy) page.show(compose()); else connect();
    report();
    if (signInNote) { page.note(signInNote); signInNote = ""; }
  })();
  return checking;
}

/* ------------------------------------------------------------------ */
export const store = {
  kind: "phone",
  starter: null,

  async start(p) {
    page = p;
    // Inside another site's frame it could be made to save what you did not mean to; refuse.
    if (window.top !== window.self) return connect("This app does not run inside another page. Open it directly.");
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
    const q = new URLSearchParams(location.search);
    if ((q.has("code") || q.has("error")) && !(await finishSignIn(q))) return;
    auth = auth || await kvGet("dropbox");
    copy = await kvGet("copy");
    outbox = ((await outAll()) || []).sort(byMade);
    if (copy) { copy.inbox ||= {}; page.show(compose()); }
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && auth && Date.now() - (copy?.checked || 0) > 60000) check();
    });
    window.addEventListener("online", () => { if (auth) check(); });
    if (!auth) {
      problem = copy ? new DbxError("signedout") : null;
      return copy ? report() : connect();
    }
    await check();
  },

  refresh: () => (auth ? check() : connect()),
  signIn,
  signOut,

  /* One save: the entries it changed, as one change file. Kept on the phone
     first, then sent. Refused if it would not pass the laptop's checks. If
     what the page shows is older than what this store now holds (a check
     brought something newer meanwhile), say so: the page lays its change
     onto the newer state and saves again, so nothing newer is undone. */
  async save(next, etag, note) {
    if (!copy) return { error: "Nothing is loaded yet." };
    if (canWrite() === false) return { error: "Not saved: Dropbox lets this app read but not save yet. See the note at the top." };
    const cur = compose();
    if (etag !== cur.etag) return { conflict: true, state: cur };
    const changes = diffDocs(cur.doc, next);
    if (!changes.length) return { ok: true, state: cur };
    const file = { version: 1, id: newId(), made: localIso(), ...(note ? { note } : {}), base: copy.rev, changes };
    const bad = changeProblems(file);
    if (bad.length) return { error: "Not saved: " + bad[0] };
    const r = foldChanges(cur.doc, [file]);
    if (r.held.length) return { error: "Not saved: " + (r.held[0].problems?.slice(0, 2).join("; ") || "it clashes with what is there") };
    outbox.push(file);
    const kept = await outPut(file);
    // A send already under way may have finished its round before this file joined; then send again.
    for (let i = 0; i < 2 && outbox.includes(file); i++) {
      try { await flush(); }
      catch (e) {
        if (e.kind === "signedout") { auth = null; await kvDel("dropbox"); }
        if (e.kind !== "scope") problem = e;
        break;
      }
    }
    const sent = !outbox.includes(file);
    if (!sent && !kept) { outbox = outbox.filter(f => f !== file); return { error: "Not saved: Dropbox could not be reached, and this browser would not keep the change." }; }
    report();
    return { ok: true, state: compose(), saved: sent ? `Saved to Dropbox · ${hhmm(Date.now())}` : "Kept on this phone; sent when Dropbox can be reached" };
  },

  async putPayslip(month, file) {
    if (!RE_MONTH.test(month)) return { error: "month must be YYYY-MM" };
    if (canWrite() === false) return { error: "Dropbox lets this app read but not save yet, so the PDF was not saved." };
    if (file.size > 15 << 20) return { error: "That PDF is over 15 MB." };
    const buf = await file.arrayBuffer();
    if (String.fromCharCode(...new Uint8Array(buf.slice(0, 5))) !== "%PDF-") return { error: "That file is not a PDF." };
    try { await upload(slipPath(month), buf, "overwrite"); await learned(true); }
    catch (e) {
      if (e.kind === "scope") { await learned(false); report(); }
      return { error: e.kind === "net" ? "Can't reach Dropbox, so the PDF was not saved. Try again when online." : `The PDF was not saved: ${e.message}` };
    }
    return { file: `payslips/${month}.pdf` };
  },

  /* A phone opens a PDF by downloading it: the link carries no sign-in. */
  async openPayslip(month) {
    try {
      const blob = new Blob([await (await download(slipPath(month))).arrayBuffer()], { type: "application/pdf" });
      const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `payslip-${month}.pdf` });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    } catch (e) {
      page.note(e.kind === "net" ? "Can't reach Dropbox to fetch the PDF." : e.kind === "missing" ? "That PDF is not in Dropbox." : `Could not fetch the PDF: ${e.message}`, "crit");
    }
  },
};
