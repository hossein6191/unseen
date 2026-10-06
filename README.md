# Unseen

Lost and found where ownership is proved by describing what the public notice
does not show, sealed so nobody can copy it.

A finder posts an item in two parts. The **public notice** is what anyone may
read: where and when it was found and how it looks from the outside. The
**private notes** are what only the owner would know, such as what is inside it.
The finder posts only the sha256 of the notes, so they stay off chain while
claims are being made.

Anyone who says the item is theirs **seals** a claim: a commitment and a deposit
of exactly the reward. The commitment is the sha256 of the claimant's own
lowercase address, the item id, a salt and the description, so nothing a
claimant writes is public while claims are open, and a commitment copied from
somebody else can never be opened by the copier. When the claim window closes,
claimants reveal their descriptions and the finder reveals the notes, each
checked against the hash that was sealed. Then anyone may call `judge`.

## How consensus is used

`judge` runs one consensus block. For every revealed claim it asks the same
question twice, in two framings and two presentation orders:

| asking | blocks, in order | question |
|---|---|---|
| order 1 | NOTICE, NOTES, CLAIM | Does this claim describe the same item AND name at least one specific detail from the finder's private notes that the public notice does not show? |
| order 2 | NOTICE, CLAIM, NOTES | Is this claim inconsistent with the finder's private notes, or does it name no detail beyond the public notice? |

The contract combines the two answers for each claim into one word:

| order 1 | order 2 | verdict |
|---|---|---|
| yes | no | `match` |
| no | yes | `no` |
| anything else, including an answer it cannot read | | `unclear` |

The stored value is the vector of those words, in the order the claims were
sealed: `C1:match,C2:no`. Every validator reruns every asking itself and
compares the whole vector by exact string equality; a validator never agrees
with a leader that raised, and a validator whose own rerun fails disagrees.
There is no tolerance for a bias to hide in: the inverse question needs the
opposite answer, so a model that says yes to everything, or no to everything,
lands as `unclear`, and an `unclear` claim gets its deposit back.

The prompt declares all three blocks untrusted before showing them. Every text
is fenced (`<` and `>` replaced, never deleted) and sits between two delimiter
lines tagged with the start of its own sha256, so a text cannot write the line
that closes it.

## Who may do what

| call | who | when |
|---|---|---|
| `post_item(public_text, hidden_hash, reward_atto, claim_seconds, reveal_seconds)` | anyone; the sender is the finder | any time; takes no value |
| `claim(item, commitment)`, payable | anyone but the finder, once per address per item, at most 4 per item | during the claim window, with exactly the reward |
| `reveal_claim(item, description, salt)` | the claimant | after the claim window, before the reveal deadline |
| `reveal_hidden(item, hidden_text)` | the finder | in the same window |
| `judge(item)` | anyone | after the reveal deadline, once the finder has revealed; once |
| `lapse(item)` | anyone | after the reveal deadline, when the finder never revealed |

Every write names its caller, and the three that refuse nobody by sender
(`post_item`, `judge`, `lapse`) are listed in the test suite with the reason.
A refused `claim` returns what was sent in the same transaction and answers
`{"ok": false, "reason": ..., "returned": ...}`; the other writes take no value
and refuse by raising.

## The money

| moment | what moves |
|---|---|
| `post_item` | nothing; the reward is paid out of the owner's deposit |
| `claim` | the claimant deposits exactly the reward; the contract holds it |
| a refused `claim` | everything sent goes back to the sender in the same transaction |
| `judge`, exactly one `match` (status `returned`) | the owner's deposit goes to the finder as the reward; every `no` and every unrevealed deposit goes to the finder; every `unclear` deposit goes back |
| `judge`, two or more `match` (status `contested`) | every `match` and `unclear` deposit goes back; `no` and unrevealed go to the finder |
| `judge`, no `match` (status `unclaimed`) | `unclear` deposits go back; `no` and unrevealed go to the finder |
| `lapse` (status `lapsed`) | every deposit goes back, unrevealed ones too: the finder failed first |

A guess that names nothing hidden costs its deposit, which is the whole price of
guessing. The contract's balance is always the sum of the deposits it still
holds (`stats().held`); the offline suite checks that after every step of forty
seeded random journeys, and every one ends with nothing held.

## Who calls it

- **A finder**: a ferry company's lost property desk, a venue, a library, a
  neighbour. They post the notice, keep the notes, and are paid the reward
  when the owner proves the item is theirs.
- **An owner**, who never has to trust the finder with a description until the
  claims are sealed, and never has to publish one an impostor could copy.
- **A consumer contract**, such as a locker that releases its code or a courier
  that books a delivery, reads `item(id)` and acts only when `status` is
  `returned`, sending to the `owner` address published there.

## Why this has to be on GenLayer

The decision is a reading: does this description name something only the
owner would know? A deterministic contract cannot make it; a single oracle
could be asked again until it said yes. Here every validator reads the same
sealed texts, the stored value is a closed vector a disagreement shows up in,
and the money follows it in the same transaction.

## The limits, stated plainly

- **The finder is trusted to hold the item and to write honest notes.** The
  notes are sealed before any claim, so they cannot be tailored to one claimant
  afterwards, but a finder who shares them with a friend before the claim
  window closes can make that friend a match. If the real owner also matches,
  the item is `contested` and both are returned their deposits; the contract
  cannot tell which of two people who know the notes is the owner.
- **The notes are hashed without a salt.** Notes written as a few sentences
  are impractical to guess from their hash; notes of three words may not be.
  The contract only asks for twenty characters.
- **Four claims per item.** Somebody can take the slots, but each slot costs a
  deposit of the full reward, which goes to the finder unless the claim is read
  `unclear`, is a `match` on a contested item, or the finder never reveals. The
  finder can post the item again.
- **`unclear` costs nothing.** A claim that splits the two framings is
  returned its deposit. That is the price of never paying on a disagreement.
- **A round that does not reach agreement stores nothing** and `judge` can be
  called again; a round that does reach agreement is final, `unclear` included.
- **Texts are printable ASCII on one line.** The notice is 20 to 400
  characters, the notes and each description 20 to 600; nothing longer is ever
  judged in part.
- The contract records who proved ownership. It does not move the item.

## What is in this repository

```
contracts/unseen.py          the contract
tests/test_pure.py           the offline suite, including the consensus round with scripted models
tests/MUTATIONS.md           every defence removed in turn, and the test that caught it
tests/on_chain/smoke.mjs     a throwaway-account run against Studio
tools/mutate.py              the generator that writes MUTATIONS.md and refuses to if anything survives
CONTRACTS.md                 purpose, consensus, state, methods, reuse and limits
DECISIONS.md                 why each rule is the way it is, and what is verified and what is not
```

## Running it

```
pip install -r requirements-dev.txt
pytest tests/ -q                          # 102 tests, no network, no Studio
genvm-lint check contracts/unseen.py      # read the first line and the exit code
python tools/mutate.py                    # rewrites tests/MUTATIONS.md; exits 1 if a mutant survives
```

On this repository as it stands: `pytest tests/ -q` gives **102 passed** in
well under a second; `genvm-lint check` (genvm-linter 0.11.0) prints
`Lint passed (3 checks)` and reports 12 methods, 6 view and 6 write; and
`python tools/mutate.py` removes or inverts **115 defences** one at a time and
**none survives**.

The on-chain run uses four throwaway keys it generates itself (finder, owner,
impostor, stranger) and funds them from the Studio faucet. It never touches a
wallet of anybody's own. It saves every step to a state file, so a run that is
cut off continues where it stopped:

```
npm ci
node tests/on_chain/smoke.mjs                  # roughly twenty minutes; ten of them are the two windows
RESUME=1 node tests/on_chain/smoke.mjs         # continue from the saved state
STATE=./run.json RESUME=1 node tests/on_chain/smoke.mjs
```

It tells one story: a dark green backpack found on a morning ferry, whose owner
names the carabiner keys and the bird sketchbook and whose impostor names a
laptop and a leather wallet, and a grey scarf whose finder never reveals the
notes. It prints a PASS or FAIL line for every check, the balances before and
after every step that moves money, `N passed, M failed`, and the contract
address. It has not been run against Studio yet, so its length is an estimate
and none of its checks is claimed here; see Evidence.

## Network

GenLayer Studio, chain 61999, RPC `https://studio.genlayer.com/api`, explorer
`https://explorer-studio.genlayer.com`. The contract pins the runner
`py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6` in its first
line.

## Evidence

Run on 6 October 2026 on GenLayer Studio (chain 61999) by `tests/on_chain/smoke.mjs`, from four
generated accounts, one per role: **F** the finder, **O** the backpack's owner, **I** an impostor, and
**S** a stranger who lost a scarf. 16 transactions in 16 steps, none sent twice; **29 checks passed,
0 failed**. The whole log is `tests/on_chain/smoke-run.log`.

Register [`0x36188D3A549300fd393471a4962F0E3336672d41`](https://explorer-studio.genlayer.com/address/0x36188D3A549300fd393471a4962F0E3336672d41).
`gen_getContractCode` on it returns `contracts/unseen.py` byte for byte (44,368 bytes, sha256
`ef0c2ea69af1a3e23314fc5f54d24a61fb295b2edd19cef93771c1a587d0b929`).

| call | by | transaction | result |
|---|---|---|---|
| deploy `contracts/unseen.py` | F | [0x8da7ed04…](https://explorer-studio.genlayer.com/tx/0x8da7ed04c29f53a94d5858f33b0b376a27a2b63205f11a1c69ea3f4cebeee393) | register `0x36188D3A…2d41`; `gen_getContractCode` returns the repository file byte for byte (sha256 `ef0c2ea6…`) |
| post I1, a dark green backpack found on a morning ferry, reward 1 GEN: the public notice and only the sha256 of the private notes | F | [0xdacf213b…](https://explorer-studio.genlayer.com/tx/0xdacf213bb12f9aa0339bee59a6b20271ccb4d7e0dcf32324db2660a979a9f90b) | I1 open |
| the owner seals a claim on I1 with a deposit of 1 GEN | O | [0xdbe7d8cc…](https://explorer-studio.genlayer.com/tx/0xdbe7d8cc13e4818e791ac170b727bf6abb8cf89e6299bb771dce2ed6e74daef6) | C2: only the commitment is on chain |
| the impostor seals a claim on I1 the same way | I | [0x32a41f56…](https://explorer-studio.genlayer.com/tx/0x32a41f569d15ddb744a506ef6030a2027a9a82780a7f2ed55553afc0b84fe843) | C1 (the two claims raced and the impostor's landed first) |
| post I2, a grey wool scarf, reward 0.5 GEN | F | [0xd2a3ba94…](https://explorer-studio.genlayer.com/tx/0xd2a3ba94fa7d86bd73b25c0dd78314ae01e9484254b601aed8e26330ac706fd8) | I2 open |
| claim I2 with half the reward | S | [0x1ed18fdf…](https://explorer-studio.genlayer.com/tx/0x1ed18fdf9d65858f303de88fe825b2c2db6b5670db3c7ce3599ee0ce89ed418b) | refused, `ok: false`; the half came back in the same transaction |
| claim I2 with exactly the reward | S | [0xddc195ca…](https://explorer-studio.genlayer.com/tx/0xddc195ca5b14b999d2f6c5a59b79b61bd4d2caf11dddd931583319b5bfe45d6b) | C3 |
| the finder reveals I1's private notes | F | [0x7f584a77…](https://explorer-studio.genlayer.com/tx/0x7f584a7763c4cc7fce7ba1d9e031b2d1a672d8815f2d46d8335826dd3ce71b14) | they hash to what was posted |
| the owner reveals the claim naming the keys on the red carabiner and the bird sketchbook | O | [0xbd83d928…](https://explorer-studio.genlayer.com/tx/0xbd83d928c05bcced57a8625555fe17dee5bb8c3bacb64efe130cac05a49774e2) | revealed |
| the impostor tries to reveal a description naming the carabiner instead of the one sealed | I | [0x15b23560…](https://explorer-studio.genlayer.com/tx/0x15b235602fb0022e561174aafba22269db681278d4da582db72de06c6fcdc08e) | refused: it does not hash to the commitment |
| judge I1 before the reveal deadline | S | [0x1bacc53a…](https://explorer-studio.genlayer.com/tx/0x1bacc53a1eee9e179c798e4c013ff463668a02223f0e8d89809909afd964b80e) | refused: the window is still open |
| the impostor reveals the claim actually sealed: a laptop and a black leather wallet | I | [0x20846da0…](https://explorer-studio.genlayer.com/tx/0x20846da0bbaf55d0ae30de29d7608cb06e86fa77dee46153973f52493144488d) | revealed |
| a stranger reveals the finder's notes | S | [0xce8f0419…](https://explorer-studio.genlayer.com/tx/0xce8f0419802a8ac50a519357d9dbe27bd74ffd223b10cfe123b17ac1b103d278) | refused: only the finder may |
| a stranger judges I1 after the deadline | S | [0x9e67da5b…](https://explorer-studio.genlayer.com/tx/0x9e67da5bd4846d06995e78eaa885106b032b44440f8ab1a4fc35eeda0e265075) | one round, 3 agree and 2 idle: **`C1:no,C2:match`**. I1 **returned**, the owner recorded, and the finder paid both deposits, 2 GEN, in the same transaction |
| judge I2, whose finder never revealed | O | [0x62b43c72…](https://explorer-studio.genlayer.com/tx/0x62b43c721f5ed7ff7ed57be866449d9e7e935e05a483bf0ae130571fa404c59d) | refused, and the refusal names `lapse` |
| lapse I2 | O | [0xe0845a43…](https://explorer-studio.genlayer.com/tx/0xe0845a43f3d18887b6cc8dc1089f4d467acd8a47e9bff31cf827829d37e2a6e5) | **lapsed**: the stranger's 0.5 GEN came back |

At the end `stats()` read two items, three claims, one returned, one lapsed, one refused claim and
nothing held; the contract's own balance was zero, and every account ended where the settlement table
says: the finder up two rewards, the owner and the impostor down one each, the stranger whole.

Two things about the run itself, said plainly. The first check pass assumed the owner's claim would be
`C1`; the two claims were sent together and the impostor's landed first, so nine checks keyed by claim
id failed while every answer of the contract was the right one. The script now reads the ids from the
contract's own receipts, and the same sixteen transactions, re-read with nothing sent again, pass 29
of 29. And a first deployment (`0x2344BFc4D2135bc6f474ACEAF618a17DE9758246`) was left behind when a slow
Studio, up to seven minutes per transaction that day, closed its 300-second claim window before the
claims arrived; the run now uses a 30-minute claim window and a 25-minute reveal window.

## Licence

MIT. See `LICENSE`.
