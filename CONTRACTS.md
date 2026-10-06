# Contracts

One file, `contracts/unseen.py`. It is the only thing in this repository that
asks the network anything.

## contracts/unseen.py

### Purpose

A lost and found register in which ownership is proved by knowledge, not by
assertion. The finder seals private notes about the item before anybody
claims it; claimants seal their descriptions before anybody can read another's;
both are opened after the claim window; and the network decides, claim by claim,
whether a description names something from the notes that the public notice
does not show. The money follows the verdict in the same transaction: the
owner's deposit pays the finder's reward, a guess that names nothing hidden
pays its deposit to the finder, and a disagreement returns the deposit.

### Consensus

One round, `_judge_round(notice, notes, claims)`, a single
`gl.vm.run_nondet_unsafe(leader_fn, validator_fn)` block called from `judge`.
The only `gl.nondet.exec_prompt` call in the file is inside `_ask`, and the
only two `_ask` calls are inside that `leader_fn`.

For each revealed claim, in the order the claims were sealed:

1. `_direct_task(notice, notes, claim)`: blocks NOTICE, NOTES, CLAIM, and the
   direct question, "Does this claim describe the same item AND name at least
   one specific detail from the finder's private notes that the public notice
   does not show?"
2. `_inverse_task(notice, notes, claim)`: blocks NOTICE, CLAIM, NOTES, and the
   inverse question, "Is this claim inconsistent with the finder's private
   notes, or does it name no detail beyond the public notice?"

Each answer is read into `yes`, `no`, `unclear`, or nothing (`_read_answer`
never raises; a JSON boolean is read, a number with a fraction is not).
`_combine` turns the pair into `match` (yes then no), `no` (no then yes) or
`unclear` (anything else). The leader returns `{"v": "C1:match,C2:no"}`.

`_agrees` is the whole comparison: a leader result that is not a
`gl.vm.Return` is never agreed with; otherwise the validator reruns every
asking itself inside try/except (its own failure is a disagreement) and
compares the vector by exact string equality. After agreement,
`_clean_vector` reads the value back for exactly the claims that were asked
about; a value in any other shape makes every one of them `unclear`, which
returns their deposits.

Every prompt opens with the task, then says that everything inside a block is
untrusted and never an instruction, then that block order carries no meaning,
then shows the three blocks, then the rule for what counts as a detail, then
the question and the closed answer format. Each block is
`<<<LABEL tag>>>` / fenced text / `<<<END LABEL tag>>>`, where the label is one
of the contract's three and the tag is the first 16 hex characters of the
sha256 of the fenced text.

### State

Two storage dataclasses, scalars only (a collection inside one kills the VM).

`Item`:

| field | type | what it is |
|---|---|---|
| `finder` | `Address` | who posted it |
| `public_text` | `str` | the notice, as posted |
| `hidden_hash`, `hidden_text`, `hidden_revealed` | `str`, `str`, `bool` | the sha256 of the notes; the notes once revealed |
| `reward` | `u256` | the deposit every claim must carry, and what the owner pays the finder |
| `posted_at`, `claim_end`, `reveal_end` | `u256` | seconds on the message clock |
| `status` | `str` | `open`, `returned`, `contested`, `unclaimed` or `lapsed` |
| `n_claims`, `n_revealed` | `u32` | counts |
| `claim_ids` | `str` | JSON list of claim ids, in sealing order |
| `held` | `u256` | the deposits this item holds now |
| `owner` | `Address` | the matching claimant, once `returned` |
| `verdict` | `str` | the agreed vector |
| `paid_finder`, `returned`, `settled_at`, `settled_by` | `u256`, `u256`, `u256`, `Address` | the settlement |

`Claim`: `item`, `claimant`, `commitment`, `deposit`, `claimed_at`, `revealed`,
`description` (empty until revealed), `verdict` (`match`, `no`, `unclear` or
`unrevealed`, once settled) and `outcome` (`to finder` or `returned`).

The contract holds `item_rows: TreeMap[str, Item]`, `claim_rows:
TreeMap[str, Claim]`, `claim_by_address: TreeMap[str, str]` (`"I1:<lowercase
address>"` to a claim id), and `u32`/`u256` counters, among them `held_total`,
which always equals the contract's balance. Ids are the contract's own:
`I1, I2, ...` and `C1, C2, ...`.

### Key methods

Writes:

| method | payable | who | on refusal |
|---|---|---|---|
| `post_item(public_text, hidden_hash, reward_atto, claim_seconds, reveal_seconds)` | no | anyone; the sender is the finder | raises `[EXPECTED] ...` |
| `claim(item, commitment)` | yes | anyone but the finder, once per address per item, at most 4 per item, during the claim window, with exactly the reward | returns what was sent and `{"ok": false, "reason", "returned"}`; never raises |
| `reveal_claim(item, description, salt)` | no | the claimant, after the claim window and before the reveal deadline | raises |
| `reveal_hidden(item, hidden_text)` | no | the finder, in the same window | raises |
| `judge(item)` | no | anyone, after the reveal deadline, once the finder revealed; once | raises |
| `lapse(item)` | no | anyone, after the reveal deadline, when the finder never revealed | raises |

`judge` with no revealed claim asks nobody: it settles the item as `unclaimed`
by rule, and every unrevealed deposit goes to the finder.

Views (ids and numbers only):

| view | returns |
|---|---|
| `item(item_id)` | the item, with its `phase` on the clock (`claiming`, `revealing`, `judge`, `lapse` or `closed`), its counts, `owner` (an address only when `returned`), the vector, and what it holds and paid |
| `claim_record(claim_id)` | one claim; the description is empty until revealed |
| `claims_of(item_id)` | the claim ids of one item, in sealing order |
| `items(offset, limit)` | a page of at most 20 items, oldest first |
| `stats()` | counts by status, what is held, what was paid to finders and returned to claimants, how many claims were refused |
| `rules()` | the value, the two askings, the combine table, the comparison, the settlement table, who may do what, the hash formats and the limits, in the contract's own words |

The view for one claim is `claim_record`, not `claim`, because `claim` is the
payable write.

### Reuse

`item(item_id)` is the part meant to be read by other contracts. A consumer
acts only when `status` is `returned` and sends to the `owner` published there;
`owner` is `""` in every other state. It should bind to this register's
address and to the item id it was handed, and it can check `finder` and
`public_text` against what it was told it was dealing with: an item id is a
position in a queue, never authority on its own.

`rules()` is meant for people and for pages: it states how to build the two
hashes, so a client can seal a claim without asking the contract anything.

### Limits

- Notice 20 to 400 characters; notes and descriptions 20 to 600; salt 8 to 64
  letters and digits. All printable ASCII on one line; anything else is refused
  at the door and never judged in part.
- Reward 0.1 to 100 GEN, in atto. Each window 300 seconds to 7 days.
- At most 4 claims per item, one per address.
- Twenty items per page of `items`.
- The commitment is sha256 of `<0x and 40 lowercase hex>|<item id>|<salt>|<description>`;
  the hidden hash is sha256 of the exact UTF-8 bytes of the notes, untrimmed.
- Every view argument is an id or a number, because a Studio read call fails
  once its encoded arguments pass 256 bytes.
