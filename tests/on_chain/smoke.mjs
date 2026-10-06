/* Unseen against GenLayer Studio (chain 61999), with throwaway accounts. Deploys its own copy.
 *
 *   npm ci                                        # genlayer-js 1.1.8 and viem 2.56.8, pinned by package-lock.json
 *   node tests/on_chain/smoke.mjs                 # the whole run, about twenty minutes
 *   RESUME=1 node tests/on_chain/smoke.mjs        # continue a run that was cut off, from the saved state
 *   STATE=/some/dir/run.json RESUME=1 node ...    # the state file: keys, contract address, every step made
 *   FRESH=1 node tests/on_chain/smoke.mjs         # start over even though a saved run exists
 *
 * Four accounts the script generates and funds itself play the whole story: F finds things and posts
 * them, O owns the backpack, I says the backpack is theirs and is not, and S is a stranger who lost a
 * scarf. Both items use a 30-minute claim window and a 25-minute reveal window (CLAIM_SECONDS, REVEAL_SECONDS).
 *
 * Phases:
 *   A  deploy; F posts a dark green backpack found on a morning ferry (I1) with only the sha256 of its
 *      private notes; O and I seal their claims on it with a deposit of exactly the reward. F posts a
 *      grey scarf (I2); S sends half the reward with a claim and it comes back in the same
 *      transaction, then S seals a claim on the scarf with the right deposit.
 *   B  the reveal window of I1: F reveals the notes, O reveals the claim that names the carabiner keys
 *      and the bird sketchbook, I tries to reveal a different description from the one sealed and is
 *      refused (it does not hash), judge before the deadline is refused, then I reveals the sealed
 *      claim (a laptop and a black leather wallet) and S is refused when revealing the notes of I1.
 *   C  after the deadline anyone judges I1: one consensus round, two askings per claim, and the
 *      vector, one verdict per claim in the order the claims landed (the two claims race, so the ids
 *      are read from the receipts): O's is match and I's is no. O is the owner, both deposits go to F
 *      in the same transaction, and a
 *      consumer reading item(I1) sees the owner's address.
 *   D  the finder never reveals the scarf's notes: judge(I2) is refused and names lapse, and lapse
 *      returns the stranger's deposit.
 *   E  the deployed code is read back and compared with contracts/unseen.py byte for byte; the views
 *      are read and checked against what the run did; the contract holds nothing; every account ends
 *      exactly where the settlement table says.
 *
 * Every refusal is a signed transaction. Balances are read before and after every step that moves
 * money. Transactions are polled with eth_getTransactionByHash, never with views (gen_call is limited
 * to 30 a minute per client, shared with sim_fundAccount). A round the validators do not carry stores
 * nothing; it is sent again and both transactions are kept. Every step is saved as it is made, so a run
 * cut off by a closed laptop continues with RESUME=1 without sending anything twice. A run cut off
 * inside a window may find that window closed when it continues; the checks then say so.
 */
import { createClient, createAccount } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { generatePrivateKey } from "viem/accounts";
import { getAddress } from "viem";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RPC = "https://studio.genlayer.com/api";
const EXPLORER = "https://explorer-studio.genlayer.com";
const STATE = process.env.STATE || join(tmpdir(), "unseen-smoke-state.json");
const RECORD = process.env.RECORD || STATE.replace(/\.json$/, "") + "-record.json";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 19);
const rpc = async (m, p) => {
  let last;
  for (let i = 0; i < 90; i++) {
    try {
      const r = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }) });
      const j = await r.json();
      if (j.error && (j.error.code === -32029 || r.status === 429)) { await sleep(((j.error.data?.retry_after_seconds) || 20) * 1000); continue; }
      if (j.error) { last = new Error(m + ": " + JSON.stringify(j.error).slice(0, 200)); await sleep(6000); continue; }
      return j.result;
    } catch (e) { last = e; await sleep(4000); }   // the connection itself failed, or the answer was not JSON
  }
  throw last;
};
let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  - " + d : ""}`); return !!c; };
const note = (s) => console.log(`      .. ${s}`);
const GEN = 10n ** 18n;
const tally = (v) => `${v.agree} agree, ${v.disagree} disagree, ${v.idle} idle`;
const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");

// ---------- state: keys, the contract address and every step already made survive a cut-off run ----------
if (existsSync(STATE) && !process.env.RESUME && !process.env.FRESH) {
  console.log(`A saved run exists at ${STATE}.\nRESUME=1 continues it; FRESH=1 starts over; STATE=<path> keeps another.`);
  process.exit(2);
}
const st = existsSync(STATE) && process.env.RESUME && !process.env.FRESH ? JSON.parse(readFileSync(STATE, "utf8")) : {};
st.keys = st.keys || {}; st.steps = st.steps || {}; st.views = st.views || {}; st.order = st.order || []; st.salts = st.salts || {};
const save = () => {
  writeFileSync(STATE, JSON.stringify(st, null, 1));
  const { keys, ...shown } = st;       // the record carries no key
  writeFileSync(RECORD, JSON.stringify(shown, null, 1));
};
const ROLES = { f: "the finder", o: "the owner of the backpack", i: "an impostor", s: "a stranger who lost a scarf" };
for (const k of Object.keys(ROLES)) {
  st.keys[k] = st.keys[k] || generatePrivateKey();
  st.salts[k] = st.salts[k] || randomBytes(8).toString("hex");   // 16 letters and digits, kept for the reveal
}
const acct = {}, client = {};
for (const k of Object.keys(ROLES)) { acct[k] = createAccount(st.keys[k]); client[k] = createClient({ chain: studionet, account: acct[k] }); }
const rd = createClient({ chain: studionet });
st.accounts = Object.fromEntries(Object.keys(ROLES).map((k) => [k, getAddress(acct[k].address)]));
save();
const low = (k) => acct[k].address.toLowerCase();
// what a claimant seals: sha256 of the lowercase address, the item id, the salt and the description, joined by |
const commit = (k, item, description) => sha(low(k) + "|" + item + "|" + st.salts[k] + "|" + description);

const balance = async (a) => BigInt(await rpc("eth_getBalance", [a, "latest"]) || "0x0");
const nonceOf = async (a) => Number(BigInt(await rpc("eth_getTransactionCount", [a, "latest"]) || "0x0"));
const fundOnce = async (k, whole) => {
  st.funded = st.funded || {};
  if (st.funded[k]) return;
  await rpc("sim_fundAccount", { account_address: getAddress(acct[k].address), amount: whole * 1e18 });   // checksummed
  for (let i = 0; i < 20 && (await balance(acct[k].address)) === 0n; i++) await sleep(3000);
  st.funded[k] = String(await balance(acct[k].address)); save();
};

// ---------- transactions ----------
const errText = (e) => String(e?.details || e?.shortMessage || e?.cause?.message || e?.message || e);
// A request the network refused or never received is made again. When the failure is ambiguous the
// sender's nonce says whether the transaction landed after all, and its hash is read back, so nothing
// is ever sent twice.
const sendRaw = async (who, what, make) => {
  const addr = acct[who].address;
  for (let i = 0; ; i++) {
    const n0 = await nonceOf(addr);
    try { return await make(); } catch (e) {
      const text = errText(e);
      if (i >= 8) throw e;
      console.log(`      ${what} was not taken (${text.slice(0, 70)}); looking again in 20s`);
      await sleep(20000);
      if ((await nonceOf(addr)) > n0) {
        const list = await rpc("sim_getTransactionsForAddress", [addr]);
        const hit = (list || []).find((t) => String(t.from_address).toLowerCase() === addr.toLowerCase() && Number(t.nonce) === n0);
        if (hit?.hash) return hit.hash;
        throw new Error(what + " landed but its hash could not be read back");
      }
    }
  }
};
const countVotes = (t) => { let a = 0, d = 0, idl = 0; for (const k in (t.consensus_data?.votes || {})) { const v = t.consensus_data.votes[k]; if (v === "agree") a++; else if (v === "disagree") d++; else idl++; } return { agree: a, disagree: d, idle: idl }; };
const wait = async (tx) => {
  let stuck = 0;
  for (let i = 0; i < 900; i++) {
    await sleep(4000);
    const t = await rpc("eth_getTransactionByHash", [tx]);
    if (t?.status === "FINALIZED") {
      const lr = t.consensus_data?.leader_receipt, one = Array.isArray(lr) ? lr[0] : lr;
      let msg = "";
      try { msg = Buffer.from(one.result, "base64").toString("utf8").replace(/[^\x20-\x7e]/g, " ").trim(); } catch (e) {}
      const v = countVotes(t);
      return { tx, msg, exec: one?.execution_result || "", votes: v, applied: v.agree * 2 > v.agree + v.disagree + v.idle, address: t.data?.contract_address || t.to_address || "" };
    }
    // a round no majority carried is final as it stands once it has been left alone for ten minutes
    if (t?.status === "UNDETERMINED" && (stuck = stuck + 1) > 150) return { tx, msg: "UNDETERMINED", exec: "", votes: countVotes(t), applied: false, address: "" };
    if (t?.status === "CANCELED") return { tx, msg: "CANCELED", exec: "", votes: { agree: 0, disagree: 0, idle: 0 }, applied: false, address: "" };
    if (i > 0 && i % 75 === 0) console.log(`      [${stamp()}] still ${t?.status || "unknown"} after ${Math.round(i * 4 / 60)} minutes: ${tx}`);
  }
  return { tx, msg: "TIMEOUT", exec: "", votes: { agree: 0, disagree: 0, idle: 0 }, applied: false, address: "" };
};
const jsonOf = (msg) => { const b = String(msg).indexOf("{"); if (b === -1) return null; try { return JSON.parse(String(msg).slice(b)); } catch (e) { return null; } };
const settle = async (a, before, want) => { for (let i = 0; i < 45; i++) { const b = await balance(a); if (b - before === want) return b; await sleep(4000); } return await balance(a); };

// One step of the run: a signed transaction, its tally, what it returned, and the balances it moved.
// opt.value is what is sent with it; opt.watch names the accounts whose balances are read before and
// after; opt.expect is the change each should show once every transfer has landed, a table or a
// function of what the call returned. A step already in the saved state is not sent again.
const call = async (id, who, fn, args = [], opt = {}) => {
  if (!st.steps[id]) { st.steps[id] = { id, who, fn, args: args.map(String), value: String(opt.value || 0n), tries: [] }; st.order.push(id); }
  const rec = st.steps[id];
  if (!rec.done) {
    const watch = opt.watch || [];
    if (!rec.before) { rec.before = {}; for (const k of watch) rec.before[k] = String(await balance(acct[k].address)); save(); }
    let r;
    for (;;) {
      if (!rec.pending) {
        rec.pending = await sendRaw(who, fn, () => client[who].writeContract({ address: st.unseen, functionName: fn, args, ...(opt.value ? { value: opt.value } : {}) }));
        save();
      }
      r = await wait(rec.pending);
      rec.tries.push({ tx: r.tx, votes: r.votes, exec: r.exec, applied: r.applied, msg: r.msg, at: stamp() });
      rec.pending = null; save();
      console.log(`      [${stamp()}] ${who.toUpperCase()} ${fn}(${args.map((x) => String(x).slice(0, 18)).join(", ")})${opt.value ? " +" + Number(opt.value) / 1e18 + " GEN" : ""}  ${r.tx}  ${tally(r.votes)}  ${r.exec}`);
      if (r.msg === "TIMEOUT" || rec.tries.length >= 4) break;
      if (!r.applied) { console.log("      the validators did not carry that round (" + tally(r.votes) + "), so nothing was stored; sending it again"); continue; }
      break;
    }
    const expect = typeof opt.expect === "function" ? opt.expect(jsonOf(r.msg)) : opt.expect;
    rec.after = {}; rec.delta = {};
    for (const k of watch) {
      const before = BigInt(rec.before[k]);
      const want = expect && expect[k] !== undefined ? BigInt(expect[k]) : null;
      const now = want === null ? await balance(acct[k].address) : await settle(acct[k].address, before, want);
      rec.after[k] = String(now); rec.delta[k] = String(now - before);
    }
    rec.done = true; save();
  }
  const last = rec.tries[rec.tries.length - 1];
  return { ...last, j: jsonOf(last.msg), tries: rec.tries, delta: rec.delta || {} };
};
const refused = (r, words) => r.exec === "ERROR" && r.msg.includes(words);
const moved = (r, k, want) => r.delta[k] === String(want);
const votes = (r) => r.tries.map((t) => tally(t.votes)).join(", then ");

const deploy = async (id, who, path) => {
  if (!st.steps[id]) { st.steps[id] = { id, who, fn: "deploy " + path.split("/").pop(), args: [], value: "0", tries: [] }; st.order.push(id); }
  const rec = st.steps[id];
  if (!rec.done) {
    const code = readFileSync(new URL(path, import.meta.url));
    for (;;) {
      if (!rec.pending) { rec.pending = await sendRaw(who, "deploy", () => client[who].deployContract({ code, args: [], leaderOnly: false })); save(); }
      const r = await wait(rec.pending);
      rec.tries.push({ tx: r.tx, votes: r.votes, exec: r.exec, applied: r.applied, msg: r.msg.slice(0, 300), at: stamp() });
      rec.address = r.address; rec.pending = null; save();
      console.log(`      [${stamp()}] ${who.toUpperCase()} deploy ${path.split("/").pop()}  ${r.tx}  ${tally(r.votes)}  ${r.exec}  ${r.address}`);
      if (r.applied || r.msg === "TIMEOUT" || rec.tries.length >= 3) break;
    }
    rec.done = true; save();
  }
  return rec.address;
};

// ---------- reads: paced, and made again on a 429 or on "Contract not found" instead of failing ----------
let lastRead = 0;
const read = async (fn, args = []) => {
  for (let i = 0; i < 30; i++) {
    const gap = 3500 - (Date.now() - lastRead);
    if (gap > 0) await sleep(gap);
    lastRead = Date.now();
    try { return JSON.parse(String(await rd.readContract({ address: st.unseen, functionName: fn, args }))); } catch (e) {
      if (i === 29) return { error: "VIEW ERROR " + fn + ": " + errText(e).slice(0, 100) };
      await sleep(/rate|429|limit/i.test(errText(e)) ? 25000 : 10000);
    }
  }
};
// a view read once for a check is kept with the run, so a continued run checks what was seen then
const seen = async (id, fn, args = []) => { if (!st.views[id]) { st.views[id] = { fn, args, at: stamp(), out: await read(fn, args) }; save(); } return st.views[id].out; };
// wait on the chain's own clock until a window of an item has passed
const until = async (item, field) => {
  for (;;) {
    const r = await read("item", [item]);
    if (!(Number(r[field]) > 0)) { note(`item ${item} could not be read (${r.error || "no " + field}); reading again`); await sleep(15000); continue; }
    const now = Number(r.now) > 0 ? Number(r.now) : Math.floor(Date.now() / 1000);
    const left = Number(r[field]) - now;
    if (left <= -10) return r;
    console.log(`      [${stamp()}] waiting ${left + 10}s for ${field} of ${item}`);
    await sleep(Math.min(left + 10, 120) * 1000);
  }
};

// ---------- the demonstration text: concrete, and one thing changed per demonstration ----------
// Windows are long enough for a slow Studio: on 6 Oct 2026 a transaction took up to seven minutes to land, which
// closed a 300-second claim window before the claims arrived. CLAIM_SECONDS / REVEAL_SECONDS override them.
const REWARD = 1n * GEN, REWARD2 = GEN / 2n;
const CLAIM_WINDOW = Number(process.env.CLAIM_SECONDS || 1800), REVEAL_WINDOW = Number(process.env.REVEAL_SECONDS || 1500);
const PUBLIC = "Dark green backpack found on the 07:40 ferry from the north pier on Tuesday morning, left under a bench on the upper deck.";
const NOTES = "Front pocket: a yellow sketchbook of bird drawings and three keys on a red climbing carabiner. Main compartment: a paperback novel in Dutch with a bus ticket as a bookmark. Nothing else is inside.";
const OWNER = "It is my backpack. The front pocket holds my three keys on a red climbing carabiner and a yellow sketchbook full of my bird drawings.";
const IMPOSTOR = "That green backpack is mine. Inside there is a silver laptop in a grey sleeve and a black leather wallet with my cards.";
const CHANGED = "That green backpack is mine. My three keys hang on a red climbing carabiner and I keep a sketchbook of birds in it.";
const SCARF = "Grey wool scarf with a knitted pattern of white diamonds, found on a bench by the pond in the botanical garden on Sunday afternoon.";
const SCARF_NOTES = "One end has the initials M.K. stitched in red thread, and a small brass pin shaped like a bee is fastened near the other end.";
const SCARF_CLAIM = "My grey scarf: the initials M.K. are stitched in red at one end and there is a brass bee pin near the other end.";

// what a claim gets back from a settled vector: an unclear claim, or a match on a contested item
const backOf = (j, cid, deposit) => {
  const v = String(j?.verdict || "").split(",").map((x) => x.split(":")).find(([c]) => c === cid)?.[1];
  return v === "unclear" || (v === "match" && j?.status === "contested") ? deposit : 0n;
};

await fundOnce("f", 5); await fundOnce("o", 20); await fundOnce("i", 20); await fundOnce("s", 20);
if (!st.start) { st.start = {}; for (const k of Object.keys(ROLES)) st.start[k] = String(await balance(acct[k].address)); st.started = new Date().toISOString(); save(); }
console.log(`[${stamp()}] ${Object.keys(ROLES).map((k) => k.toUpperCase() + " " + st.accounts[k] + "  " + ROLES[k]).join("\n           ")}\n           state ${STATE}`);

// ================================================================ phase A
console.log(`\n[${stamp()}] ---- phase A: deploy, two items posted, three claims sealed`);
st.unseen = st.unseen || await deploy("deploy", "f", "../../contracts/unseen.py");
save();
console.log(`      Unseen at ${st.unseen}`);
const p1 = await call("postBackpack", "f", "post_item", [PUBLIC, sha(NOTES), String(REWARD), CLAIM_WINDOW, REVEAL_WINDOW]);
ok("the finder posts the backpack as I1, with the public notice and only the sha256 of the private notes", p1.j?.ok === true && p1.j?.item === "I1" && p1.j?.reward === String(REWARD), `${votes(p1)}  ${p1.msg.slice(0, 120)}`);
const I1 = p1.j?.item || "I1";
// The two claims that need I1's claim window open are sent together, straight after it is posted.
const [co, ci] = await Promise.all([
  call("claimOwner", "o", "claim", [I1, commit("o", I1, OWNER)], { value: REWARD, watch: ["o"], expect: { o: -REWARD } }),
  call("claimImpostor", "i", "claim", [I1, commit("i", I1, IMPOSTOR)], { value: REWARD, watch: ["i"], expect: { i: -REWARD } }),
]);
// The two claims race, so either may land first: the ids are read from the contract's own answers, never assumed.
const OC = String(co.j?.claim || ""), IC = String(ci.j?.claim || "");
const byId = (a, b) => Number(a.slice(1)) - Number(b.slice(1));
const EXPECTED = [OC, IC].sort(byId).map((id) => `${id}:${id === OC ? "match" : "no"}`).join(",");
const sealedBy = (id) => (id === OC ? ["o", OWNER] : ["i", IMPOSTOR]);
ok(`the owner seals a claim on I1 with a deposit of exactly the reward (${OC})`, co.j?.ok === true && /^C\d+$/.test(OC) && moved(co, "o", -REWARD), `${votes(co)}  ${co.msg.slice(0, 100)}`);
ok(`the impostor seals a claim on I1 the same way (${IC})`, ci.j?.ok === true && /^C\d+$/.test(IC) && IC !== OC && [OC, IC].sort(byId).join() === "C1,C2", `${votes(ci)}  ${ci.msg.slice(0, 100)}`);
const p2 = await call("postScarf", "f", "post_item", [SCARF, sha(SCARF_NOTES), String(REWARD2), CLAIM_WINDOW, REVEAL_WINDOW]);
ok("the finder posts the scarf as I2", p2.j?.ok === true && p2.j?.item === "I2", `${votes(p2)}  ${p2.msg.slice(0, 100)}`);
const I2 = p2.j?.item || "I2";
const half = await call("claimHalf", "s", "claim", [I2, commit("s", I2, SCARF_CLAIM)], { value: REWARD2 / 2n, watch: ["s"], expect: { s: 0n } });
ok("a claim sent with half the reward is refused, and the half comes back in the same transaction", half.exec !== "ERROR" && half.j?.ok === false && String(half.j?.reason).includes("send exactly the reward") && half.j?.returned === String(REWARD2 / 2n) && moved(half, "s", 0n), `${votes(half)}  ${half.j?.reason}`);
const cs = await call("claimScarf", "s", "claim", [I2, commit("s", I2, SCARF_CLAIM)], { value: REWARD2, watch: ["s"], expect: { s: -REWARD2 } });
ok("the stranger claims the scarf again with exactly its reward", cs.j?.ok === true && cs.j?.claim === "C3" && moved(cs, "s", -REWARD2), `${votes(cs)}  ${cs.msg.slice(0, 100)}`);
{
  const v = await seen("itemI1sealed", "item", [I1]);
  ok("item(I1) holds two sealed claims, and neither description is anywhere on chain", v.claims === 2 && v.revealed === 0 && v.held === String(2n * REWARD) && v.hidden_text === "", JSON.stringify({ phase: v.phase, claims: v.claims, held: v.held }));
  const r = await seen("recordC1sealed", "claim_record", ["C1"]);
  ok("claim_record(C1), still sealed, shows its commitment and an empty description", r.commitment === commit(sealedBy("C1")[0], I1, sealedBy("C1")[1]) && r.description === "" && r.revealed === false, JSON.stringify({ revealed: r.revealed, description: r.description }));
}

// ================================================================ phase B
console.log(`\n[${stamp()}] ---- phase B: the reveal window of I1`);
{
  const r0 = await until(I1, "claim_end");
  // judge-before-the-deadline is only sent with time to spare: sent late, it would be the real judgment
  const spare = Number(r0.reveal_end) - (Number(r0.now) > 0 ? Number(r0.now) : Math.floor(Date.now() / 1000));
  const round = [
    call("notesBackpack", "f", "reveal_hidden", [I1, NOTES]),
    call("revealOwner", "o", "reveal_claim", [I1, OWNER, st.salts.o]),
    call("revealChanged", "i", "reveal_claim", [I1, CHANGED, st.salts.i]),
  ];
  if (st.steps.judgeEarly || spare > 150) round.push(call("judgeEarly", "s", "judge", [I1]));
  else note(`only ${spare}s left in the reveal window, so judge-before-the-deadline is not sent`);
  const [nb, ro, rc, je] = await Promise.all(round);
  ok("the finder reveals the private notes, and they hash to what was posted", nb.j?.ok === true && nb.j?.hidden_revealed === true, `${votes(nb)}  ${nb.msg.slice(0, 100)}`);
  ok("the owner reveals the claim that names the carabiner keys and the bird sketchbook", ro.j?.ok === true && ro.j?.claim === OC, `${votes(ro)}  ${ro.msg.slice(0, 100)}`);
  ok("the impostor tries to reveal a description naming the carabiner instead of the one sealed: refused, it does not hash", refused(rc, "do not hash to the commitment sealed as " + IC), `${votes(rc)}  ${rc.msg.slice(0, 110)}`);
  if (je) ok("judge before the reveal deadline is refused", refused(je, "can be judged once its reveal window closes"), `${votes(je)}  ${je.msg.slice(0, 100)}`);
  const [ri, sh] = await Promise.all([
    call("revealImpostor", "i", "reveal_claim", [I1, IMPOSTOR, st.salts.i]),
    call("notesStranger", "s", "reveal_hidden", [I1, NOTES]),
  ]);
  ok("the impostor reveals the claim actually sealed: a laptop and a black leather wallet", ri.j?.ok === true && ri.j?.claim === IC, `${votes(ri)}  ${ri.msg.slice(0, 100)}`);
  ok("a stranger may not reveal the finder's notes", refused(sh, "only the finder of I1 may reveal its private notes"), `${votes(sh)}  ${sh.msg.slice(0, 100)}`);
}

// ================================================================ phase C
console.log(`\n[${stamp()}] ---- phase C: the judgment of I1`);
{
  await until(I1, "reveal_end");
  const jb = await call("judgeBackpack", "s", "judge", [I1], {
    watch: ["f", "o", "i"],
    expect: (j) => ({ f: BigInt(j?.paid_finder || 0), o: backOf(j, OC, REWARD), i: backOf(j, IC, REWARD) }),
  });
  ok("the validators carry one vector, in one consensus round", jb.applied && /^C\d+:(match|no|unclear),C\d+:(match|no|unclear)$/.test(String(jb.j?.verdict)), `${votes(jb)}  -> ${jb.j?.verdict}`);
  ok(`the owner's claim is a match and the impostor's is not: ${EXPECTED}`, jb.j?.verdict === EXPECTED, String(jb.j?.verdict));
  ok("I1 is returned and the owner is recorded", jb.j?.status === "returned" && jb.j?.owner === low("o"), JSON.stringify({ status: jb.j?.status, owner: jb.j?.owner }));
  ok("the finder is paid the owner's deposit as the reward and the impostor's deposit, in the same transaction", jb.j?.paid_finder === String(2n * REWARD) && moved(jb, "f", 2n * REWARD) && moved(jb, "o", 0n) && moved(jb, "i", 0n), JSON.stringify(jb.delta));
  const v = await seen("itemI1returned", "item", [I1]);
  ok("a consumer reading item(I1) finds status returned and the owner's address", v.status === "returned" && v.owner === low("o") && v.verdict === EXPECTED, JSON.stringify({ status: v.status, owner: v.owner }));
  const c2 = await seen("recordImpostor", "claim_record", [IC]);
  ok(`claim_record(${IC}): the impostor's description, read no, its deposit to the finder`, c2.verdict === "no" && c2.outcome === "to finder" && c2.description === IMPOSTOR, JSON.stringify({ verdict: c2.verdict, outcome: c2.outcome }));
}

// ================================================================ phase D
console.log(`\n[${stamp()}] ---- phase D: the scarf, whose finder never reveals`);
{
  await until(I2, "reveal_end");
  const js = await call("judgeScarf", "o", "judge", [I2]);
  ok("judge(I2) is refused because the finder never revealed the notes, and the refusal names lapse", refused(js, "lapse(I2) returns every deposit"), `${votes(js)}  ${js.msg.slice(0, 120)}`);
  const lp = await call("lapseScarf", "o", "lapse", [I2], { watch: ["s"], expect: { s: REWARD2 } });
  ok("anyone may lapse I2, and the stranger's deposit comes back", lp.j?.status === "lapsed" && lp.j?.returned === String(REWARD2) && moved(lp, "s", REWARD2), `${votes(lp)}  ${lp.msg.slice(0, 100)}`);
}

// ================================================================ phase E
console.log(`\n[${stamp()}] ---- phase E: the code read back, the views, the balances`);
{
  const file = readFileSync(new URL("../../contracts/unseen.py", import.meta.url));
  const chain = Buffer.from(String(await rpc("gen_getContractCode", [st.unseen])), "base64");
  st.code = { address: st.unseen, bytes: chain.length, sha256: sha(chain), file_bytes: file.length, file_sha256: sha(file), identical: Buffer.compare(chain, file) === 0 };
  save();
  ok(`the code deployed at ${st.unseen} is byte for byte contracts/unseen.py`, st.code.identical, `${chain.length} bytes, sha256 ${st.code.sha256}`);
  const stats = await seen("stats", "stats", []);
  ok("stats(): two items, three claims, one returned, one lapsed, one refused claim, nothing held", stats.items === 2 && stats.claims === 3 && stats.returned === 1 && stats.lapsed === 1 && stats.open === 0 && stats.refused_claims === 1 && stats.held === "0" && stats.paid_to_finders === String(2n * REWARD) && stats.returned_to_claimants === String(REWARD2), JSON.stringify(stats));
  const page = await seen("items", "items", [0, 20]);
  ok("items(0, 20): both items, oldest first, with their endings", Array.isArray(page.rows) && page.rows.map((r) => r.item + ":" + r.status).join(" ") === "I1:returned I2:lapsed", JSON.stringify((page.rows || []).map((r) => r.item + ":" + r.status)));
  const of2 = await seen("claimsOfI2", "claims_of", [I2]);
  ok("claims_of(I2) lists the stranger's one claim; the refused one was never a claim", JSON.stringify(of2) === '["C3"]', JSON.stringify(of2));
  const rules = await seen("rules", "rules", []);
  ok("rules() publishes the comparison and the combine table in the contract's own words", String(rules.compared).includes("exact string equality") && rules.combine?.["yes then no"] === "match", String(rules.value));
  ok("the contract's own balance is zero", (await balance(st.unseen)) === 0n, String(await balance(st.unseen)));
  st.end = {}; for (const k of Object.keys(ROLES)) st.end[k] = String(await balance(acct[k].address));
  st.ended = new Date().toISOString(); save();
  const net = (k) => BigInt(st.end[k]) - BigInt(st.start[k]);
  const want = { f: 2n * REWARD, o: -REWARD, i: -REWARD, s: 0n };
  ok("every account ends where the settlement table says: the finder up two rewards, the owner and the impostor down one each, the stranger whole", Object.keys(want).every((k) => net(k) === want[k]), Object.keys(want).map((k) => k.toUpperCase() + " " + Number(net(k)) / 1e18).join("  "));
}

st.checks = { pass, fail }; save();
console.log(`\n${pass} passed, ${fail} failed`);
console.log(`Unseen: ${st.unseen}  ${EXPLORER}/address/${st.unseen}`);
console.log("transactions:", st.order.reduce((n, id) => n + st.steps[id].tries.length, 0), "in", st.order.length, "steps; sent a second time:", st.order.filter((id) => st.steps[id].tries.length > 1).join(", ") || "none");
for (const id of st.order) { const s = st.steps[id]; console.log(`${id.padEnd(15)} ${s.tries.map((t) => t.tx + " " + tally(t.votes) + " " + t.exec).join(" | ")}`); }
console.log("record:", RECORD);
process.exit(fail ? 1 : 0);
