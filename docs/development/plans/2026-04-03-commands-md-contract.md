# `COMMANDS.md` Contract Implementation Plan

**Goal:** Add a repo-root `COMMANDS.md` that becomes the single source of truth for the current external Lark command contract, and align the most relevant existing docs to reference it instead of acting as parallel behavior specs.

**Architecture:** Implement this as a documentation-first change. Create one concise root-level contract file that covers only external Lark commands and their valid contexts, then update the strongest nearby design docs so they defer to `COMMANDS.md` for external command behavior while preserving internal rationale. Keep scope tight: no code-path changes, no schema generation, no automation.

**Tech Stack:** Markdown, repo documentation conventions

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `COMMANDS.md` | Create | Canonical external Lark command contract at repo root |
| `docs/development/design/2026-04-02-task-explicit-routing-contract-design.md` | Modify | Point root `/task` behavior to `COMMANDS.md` as the external contract |
| `docs/development/design/2026-04-02-lark-thread-natural-language-continuation-design.md` | Modify | Point thread command behavior to `COMMANDS.md` as the external contract |
| `docs/development/design/2026-04-03-commands-md-contract-design.md` | Verify | Remains the rationale and scope record for this doc-only feature |

---

## Preflight: Confirm Current Behavior (No Code Changes)

**Why:** `COMMANDS.md` must describe *current* external behavior. The design doc summarizes current state, but this plan should include a quick source-of-truth check against the implementing code paths to avoid documenting the wrong contract.

**Files (read-only):**
- Inspect: `packages/daemon/lark-listener/src/message-handler.ts`
- Inspect: `packages/daemon/task-enrichment/src/enrichment-poller.ts`
- Inspect: `packages/shared/src/routing-errors.ts`

- [ ] **Step 1: Confirm the accepted/rejected shapes per command and context**

Manually verify (by reading the code paths above) that:

- Root `/task <type> <executor> <model> <payload>` is accepted and partial `/task` shapes are rejected with a usage hint.
- Plain root messages (non-command) are forwarded but ultimately rejected downstream with a root `/task` usage hint.
- In a thread, plain natural-language replies are accepted as continuation.
- In a thread, `/task ...` is rejected.
- In a thread, `/new` and `/new <executor> <model>` are accepted.
- In a thread, `/end` is accepted.
- In root/top-level, `/gc` is accepted.

If any of the above is not true in code, update the plan steps for `COMMANDS.md` content accordingly (the plan is the artifact being reviewed; do not change code).

- [ ] **Step 2: Decide the exact terminology for non-thread messages**

The design spec uses “root message” and also mentions “root or base message” for `/gc`. In `COMMANDS.md`, standardize on one term and define it precisely in `Shared Terms` (recommended: “Root (top-level) message: not in a bot thread”).

### Task 1: Create the Canonical Repo-Root Contract

**Files:**
- Create: `COMMANDS.md`

- [ ] **Step 1: Write the initial contract skeleton**

Add the top-level sections exactly as planned:

```md
# COMMANDS.md

## Scope
## Shared Terms
## Commands
### /task
### /new
### /end
### /gc
## Maintenance
```

Success criteria:

- The file is at repo root (`COMMANDS.md`).
- It is Lark-only and external-commands-only.
- Each command section is explicitly normative about valid contexts and invalid forms.
- The doc does not enumerate allowed executor/model/type values.

- [ ] **Step 2: Fill in the scope section with the contract boundaries**

Document these points explicitly:

```md
- This document defines the external Lark command contract.
- This document is Lark-only.
- This document covers external commands only.
- Internal task types, queue payloads, API shapes, and CLI behavior are out of scope.
- Exact command shape is normative.
- Examples are illustrative, not exhaustive.
- This document describes current behavior.
```

- [ ] **Step 3: Add the shared-terms section**

Keep it short and operational:

```md
- Root message: a new message outside an existing bot thread.
- Thread reply: a reply inside an existing bot thread.
- Valid: accepted as a command in that context.
- Invalid: rejected in that context.
```

- [ ] **Step 4: Author the `/task` command section**

Use the standard per-command subsection order:

```md
Purpose:
Grammar:
Valid contexts:
Invalid forms:
Examples:
Notes:
```

Include:

```md
Grammar:
/task <type> <executor> <model> <payload>

Valid contexts:
- Root message only

Invalid forms:
- Any use in a thread
- /task
- /task <type>
- /task <type> <executor>
- /task <type> <executor> <model>
- /task <type> <executor> <model> followed by a newline before payload
```

Also include:

- one valid single-line example
- one valid multiline example where payload starts on the first line and continues later
- a short note that payload must begin on the same line as `<model>`

- [ ] **Step 5: Author the `/new` command section**

Use the same subsection order as `/task`.

Include:

```md
Grammar:
/new
/new <executor> <model>

Valid contexts:
- Thread reply only

Invalid forms:
- Any root use
- Any malformed argument count
```

Also include:

- one bare `/new` example
- one `/new <executor> <model>` example

- [ ] **Step 6: Author the `/end` command section**

Use the same subsection order as `/task`.

Include:

```md
Grammar:
/end

Valid contexts:
- Thread reply only

Invalid forms:
- Any root use
- Any trailing arguments or extra content
```

- [ ] **Step 7: Author the `/gc` command section**

Use the same subsection order as `/task`.

Include:

```md
Grammar:
/gc

Valid contexts:
- Root (top-level) message only

Invalid forms:
- Any thread use
- Any trailing arguments or extra content
```

- [ ] **Step 8: Add the maintenance section**

Add a short maintenance note:

```md
- Command-surface changes must update this file in the same PR.
- Reviewers should treat command-contract drift as a release blocker.
```

- [ ] **Step 9: Review the final contract for scope discipline**

Check manually that `COMMANDS.md` does **not** add:

- CLI behavior
- API request shapes
- internal task types like `thread_reply`
- enumerated valid executor or model lists
- implementation rationale that belongs in design docs

- [ ] **Step 10: Verify the file renders cleanly and is concise**

Run: `sed -n '1,260p' COMMANDS.md`
Expected: the file contains only the planned sections, the four commands, and no out-of-scope internal mechanics.

Additional verification:

- Run: `rg -n "^### /(task|new|end|gc)$" COMMANDS.md`
Expected: exactly four command headers, no extras.
- Manually scan for accidental enumerations like “valid executors are ...” or “valid models are ...”.

### Task 2: Repoint Existing Behavior Docs to the Canonical Contract

**Files:**
- Modify: `docs/development/design/2026-04-02-task-explicit-routing-contract-design.md`
- Modify: `docs/development/design/2026-04-02-lark-thread-natural-language-continuation-design.md`

- [ ] **Step 1: Add a short contract note to the root `/task` design doc**

Near the top of `docs/development/design/2026-04-02-task-explicit-routing-contract-design.md`, add a note like:

```md
> External contract note: repo-root `COMMANDS.md` is the authoritative external Lark command contract. This design doc explains rationale and implementation boundaries for the root `/task` behavior.
```

- [ ] **Step 2: Add a short contract note to the thread-continuation design doc**

Near the top of `docs/development/design/2026-04-02-lark-thread-natural-language-continuation-design.md`, add a note like:

```md
> External contract note: repo-root `COMMANDS.md` is the authoritative external Lark command contract. This design doc explains rationale and implementation boundaries for thread reply behavior.
```

- [ ] **Step 3: Remove any accidental implication that those docs are the external source of truth**

Read both docs after the note insertion and check for wording that still reads like the final user-facing contract rather than design rationale. If a line creates direct conflict, trim or reword it minimally rather than rewriting the doc.

- [ ] **Step 4: Verify the edits stay minimal and non-destructive**

Run:

```bash
sed -n '1,40p' docs/development/design/2026-04-02-task-explicit-routing-contract-design.md
sed -n '1,40p' docs/development/design/2026-04-02-lark-thread-natural-language-continuation-design.md
```

Expected: each file now points to `COMMANDS.md` for external behavior while preserving its internal design purpose.

Success criteria:

- Each modified design doc clearly defers to `COMMANDS.md` for external command behavior.
- No normative command-shape statements remain that conflict with `COMMANDS.md`.
- The edits are limited to small notes/rewording; no large rewrite.

### Task 3: Final Documentation Verification

**Files:**
- Verify: `COMMANDS.md`
- Verify: `docs/development/design/2026-04-02-task-explicit-routing-contract-design.md`
- Verify: `docs/development/design/2026-04-02-lark-thread-natural-language-continuation-design.md`

- [ ] **Step 1: Run a targeted grep for the new contract anchor**

Run:

```bash
rg -n "COMMANDS\.md|authoritative external Lark command contract" COMMANDS.md docs/development/design/2026-04-02-task-explicit-routing-contract-design.md docs/development/design/2026-04-02-lark-thread-natural-language-continuation-design.md
```

Expected: the root contract is mentioned in all three files.

- [ ] **Step 2: Manually verify command coverage**

Check that `COMMANDS.md` contains sections for exactly:

- `/task`
- `/new`
- `/end`
- `/gc`

And does not add separate command entries for plain replies or non-text messages.

- [ ] **Step 3: Manually verify context coverage**

For each command, confirm the document explicitly states whether it is valid in:

- root messages
- thread replies

Expected: no command entry leaves context ambiguous.

- [ ] **Step 4: Inspect the git diff for documentation-only scope**

Run: `git diff -- COMMANDS.md docs/development/design/2026-04-02-task-explicit-routing-contract-design.md docs/development/design/2026-04-02-lark-thread-natural-language-continuation-design.md`

Expected: only Markdown documentation changes appear.

- [ ] **Step 5: Commit the contract-doc change set**

```bash
git add COMMANDS.md docs/development/design/2026-04-02-task-explicit-routing-contract-design.md docs/development/design/2026-04-02-lark-thread-natural-language-continuation-design.md
git commit -m "docs: add canonical lark command contract"
```

Note: If the execution environment expects plans to stop before committing, treat the commit as optional and leave the repo uncommitted after verifying diffs.
