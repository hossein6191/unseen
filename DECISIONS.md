# Decisions

Why each rule of `contracts/unseen.py` is the way it is, and what is verified
and what is not.

## 1. What the network agrees on

**The stored value is a vector of closed words, one per revealed claim.**
`C1:match,C2:no`. Nothing the model wrote reaches storage: `_read_answer` maps
an answer onto `yes`, `no`, `unclear` or nothing, and `_combine` writes the
verdict. A per-claim score, a reason or a summary would be a value the
validators could never compare exactly.

**The validator reruns the whole task and compares the whole vector.** Not a
sample of the claims, not the shape of the leader's answer: every asking is
asked again and the string must be equal. A tolerance would let one node store
`match` while another believed `unclear`, and the money moves on that word.

**A leader that raised is never agreed with.** A failure is not a verdict. The
round stores nothing and `judge` can be called again; nothing was paid and
nothing was recorded, so a retry rolls nothing back that anybody relied on. A
round that reaches agreement is final, `unclear` included: `judge` refuses an
item that is not `open`.

**The validator's own failure is a disagreement.** Its rerun is inside
try/except. Without that, a node whose model could not be reached would raise
out of the comparison instead of voting.

## 2. Two orders, two framings, one block

The direct question is asked with the notes before the claim; the inverse
question with the claim before the notes. Both in one block, in sequence. A
model that leans towards yes, or towards no, answers both questions the same
way, and the pair (yes, yes) or (no, no) is `unclear`, never a verdict. That is
where position and framing bias land: in the stored value, as a word that
returns the deposit.

The orders are tied to the framings rather than crossed (four askings per claim)
to keep the round at two askings per claim, eight at the most. A bias that
follows both the order and the framing at once could still agree with itself;
that is not ruled out here and is listed under what is not verified.

**What counts as a detail is written down, once, for both askings.** A detail
counts only when the notes state it and the notice does not show it; repeating
the notice proves nothing; a detail the claim adds that the notes do not
mention never counts for it; and when the notes describe the contents as
complete, an object they do not list contradicts them. Without that last
sentence an impostor who names a laptop has named "a detail beyond the public
notice", and the inverse question would read it the wrong way.

## 3. The prompt is where trust changes hands

All three texts are untrusted: the finder writes two of them and the claimant
the third, and each has money at stake. So every one is fenced with
`str(raw).replace("<", "(").replace(">", ")")` (replace, never delete, so a
length cap still holds after fencing), sits between delimiter lines carrying
the first 16 hex characters of its own sha256, and is declared untrusted before
the first block. The tag depends on every byte of the text, so a text cannot
carry its own closing line. The label on a delimiter line is one of the
contract's three constants, and anything else prints as `BLOCK`. A static test
fails if a value reaches a prompt without being fenced or a contract constant.

Angle brackets are allowed at the door and fenced at the prompt. A commitment
cannot be changed after it is sealed, so refusing a character at reveal time
would cost a claimant the deposit over punctuation; the fence makes the
character harmless instead. Line breaks and non-ASCII are refused, at posting
for the notice and at reveal for the notes and descriptions, so a text cannot
start a line of its own.

## 4. Sealing

**The commitment binds the claimant's address and the item.** sha256 of
`<lowercase address>|<item id>|<salt>|<description>`. A commitment copied from
somebody else, onto the same item or another, can be sealed (it costs the
copier a deposit) but never opened, so its deposit goes to the finder. For
that reason the contract does not refuse a commitment it has already seen: a
copier who landed first would otherwise block the owner's exact commitment.

**The salt is letters and digits only.** With a `|` allowed in the salt, the
same hash could be opened as two different descriptions (salt `a|b` and
description `c`, or salt `a` and description `b|c`), which would let a claimant
seal two guesses and reveal whichever suited the notes once they were public.

**Nothing opens while a claim can still be made.** Descriptions and notes are
revealed only after the claim window closes, and a claimant who sees the notes
in the reveal window cannot change what they sealed.

**The address is lowercased on both sides.** A checksummed address reveals the
claim it sealed with the lowercase form; a test sends one.

## 5. Money

**Exact, and in the same call.** `judge` writes every claim's verdict and
outcome, the item's status, owner and totals, and then makes the transfers:
one to the finder for everything kept, one back to each claimant whose deposit
is returned. `lapse` does the same with every deposit going back.

**The reward is the owner's deposit.** The finder posts nothing, so posting is
free and needs no escrow; the owner pays the reward out of the deposit that
proved them. A claim that names nothing hidden pays its deposit to the finder,
which is the cost of guessing. `unclear` returns the deposit, because the
network did not decide anything.

**Unrevealed claims pay the finder, unless the finder failed first.** A claimant
who seals and never opens has spent a slot for nothing; the deposit goes to the
finder at `judge`. If the finder never reveals the notes, nothing can be judged
and `lapse` returns every deposit, unrevealed ones too.

**`judge` with nothing to ask settles by rule.** A round needs at least one
revealed claim to ask about. Refusing `judge` without one would leave the item
no way to end, and its unrevealed deposits held for ever, so `judge` closes it
as `unclaimed` without a round and sends those deposits to the finder.

**The balance is always the deposits still held.** `held_total` goes up by
every accepted deposit and down by everything settled; each item's `held` is
the sum of its claims that have no outcome yet. The suite checks both against
the money actually moved after every step of forty seeded random journeys.

## 6. Who may do what

`post_item`, `judge` and `lapse` refuse nobody by sender, on purpose, and the
static test that checks every write for a sender gate lists them with the
reason: posting binds nobody else; settlement must not depend on any one party
showing up, and what it does is fixed by the sealed texts and the agreed
vector, never by the caller. `claim` refuses the finder; `reveal_claim` only
opens the sender's own claim; `reveal_hidden` only accepts the finder.

**A refused party always has somewhere to go**, and each route is a test
written as a journey: a claim with the wrong deposit is refunded and the same
address claims again; an `unclear` owner has the deposit back and claims again
when the finder posts once more; a contested item returns every match; a
finder who never reveals makes every claimant whole through `lapse`; a reveal
that does not hash can be sent again correctly before the deadline.

## 7. Storage and the runtime

Scalars only inside the two dataclasses; claim ids in a JSON string; indexes in
`TreeMap`s; ids assigned by the contract. Every `json.loads` goes through
`_loads`, whose hooks refuse a fraction, an exponent, NaN and Infinity, because
a float traps the VM in deterministic mode. Every argument of every public
method is checked with `isinstance` or read through `_number_arg`, which takes
an int or a string of digits and refuses a bool, a float and everything else.
The clock is `gl.message_raw["datetime"]` read to seconds by a hand-written
integer calendar; when it is missing, a write that took no value refuses and a
claim returns its deposit, rather than guess. Every view takes an id or a
number, never a text, because a Studio read call fails once its encoded
arguments pass 256 bytes.

## 8. Verified, and not verified

Verified on this repository:

- `pytest tests/ -q`: 102 tests pass with no network. They drive the
  consensus round with a scripted model per node (the leader and each validator
  in its own world), every write and refusal, the settlement table, the views,
  the static rules above, and forty seeded random journeys checked for
  conservation after every step.
- `python tools/mutate.py`: 115 defences removed or inverted one at a time,
  none survives; `tests/MUTATIONS.md` names the test that caught each.
- `genvm-lint check contracts/unseen.py` (genvm-linter 0.11.0): lint passed,
  12 methods, 6 view and 6 write.
- `tests/on_chain/smoke.mjs` passes `node --check` and its imports resolve
  against the pinned genlayer-js 1.1.8 and viem 2.56.8.

Verified on chain (6 October 2026, register `0x36188D3A549300fd393471a4962F0E3336672d41`,
`tests/on_chain/smoke-run.log`): 16 transactions, 29 checks, 0 failed. Studio's validators read the
backpack demo as the owner `match` and the impostor `no`, in one round (3 agree, 2 idle); the deployed
bytes equal this file (sha256 `ef0c2ea6…`); every balance moved as the settlement table says and the
contract's own balance ended at zero. A slow Studio took up to seven minutes per transaction that day,
which closed a 300-second claim window before the claims landed on a first deployment
(`0x2344BFc4…`), so the run uses a 30-minute claim window and a 25-minute reveal window.

Not verified yet:

- How often real models answer `unclear` on borderline descriptions; the run produced none.
- Whether a bias that follows both the order and the framing at once exists in
  the models Studio runs. Crossing the orders with the framings would rule it
  out at twice the askings.
- The 256-byte read limit was measured on another contract on Studio, not on
  this one; the views here are kept far inside it.
