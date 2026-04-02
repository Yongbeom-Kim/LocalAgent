# Design: Repo-Root `COMMANDS.md` Contract

**Date:** 2026-04-03
**Status:** Ready for implementation
**Type:** Documentation contract / command-spec consolidation
**Packages:** `LocalAgent` repo root docs, `@local-agent/lark-listener-daemon`, `@local-agent/task-enrichment-daemon`, `@local-agent/shared`

## 1. Problem

The LocalAgent Lark command contract currently exists in multiple places:

- parser behavior in `packages/daemon/lark-listener/src/message-handler.ts`
- semantic acceptance and rejection in `packages/daemon/task-enrichment/src/enrichment-poller.ts`
- shared routing copy in `packages/shared/src/routing-errors.ts`
- historical behavior docs in `docs/development/design/*`

That creates two issues:

1. External command behavior is hard to audit from one file.
2. Behavior docs can drift from the actual user-facing command surface because no single document is clearly authoritative.

The repo now has a relatively strict Lark command contract, but it is fragmented across implementation and feature-specific design docs rather than captured in one stable external spec.

## 2. Goal

Create a repo-root `COMMANDS.md` that serves as the single source of truth for the **current external Lark command contract**.

The first version should:

- be **Lark-only**
- cover **external commands only**
- describe **current behavior**, not aspirational future behavior
- define exact valid and invalid command shapes normatively
- clearly distinguish when commands are valid in **root messages** versus **thread replies**
- act as both a normative contract and a readable reference guide for humans and agentic coding tools
- supersede scattered behavior-doc explanations for the external command surface

## 3. Non-goals

- No code implementation in this design
- No attempt to document CLI or API request contracts in `COMMANDS.md`
- No attempt to document internal placeholder task types such as `thread_reply`
- No requirement that v1 include machine-readable front matter or embedded schema
- No automated enforcement or generation pipeline in v1
- No attempt to enumerate exact valid task types, executor values, or model values in the contract itself
- No attempt to replace internal architecture docs that explain implementation rationale

## 4. Scope Assessment

This is one coherent documentation-contract feature.

Although the command behavior is implemented across multiple packages, the requested artifact is a single external contract document for one surface area: Lark commands. This should remain one design and one plan, not multiple subprojects.

## 5. User Decisions Captured

- `COMMANDS.md` lives at the **repo root**.
- The document is **Lark-only**.
- The document covers **external commands only**.
- It should distinguish **root** versus **thread** validity.
- Precision wins over friendliness.
- `COMMANDS.md` should be both a normative spec and a reference guide.
- Exact command shape is normative.
- Error wording can stay looser than grammar rules; the spec only needs to require an error for the relevant field or class of failure.
- The preferred structure is a **single contract doc** using a **command catalog** layout.
- The document should reflect **current behavior**.
- `COMMANDS.md` should supersede scattered behavior docs as the stable external contract.
- Drift prevention in v1 relies on review and release discipline rather than automated enforcement.

## 6. Current State

Based on the current code path, the external Lark contract already behaves roughly as follows:

- Root normal task entry uses `/task <type> <executor> <model> <payload>`.
- `/task` partial shapes are rejected locally in `MessageHandler` with a usage hint.
- Plain root messages are forwarded internally as continuation candidates and rejected downstream with the root usage hint.
- In a thread, plain natural-language replies continue the existing conversation implicitly.
- `/task ...` is rejected in a thread.
- `/new` is thread-only semantically.
- `/new <executor> <model>` is thread-only semantically.
- `/end` is thread-only semantically.
- `/gc` is valid only as a root or base message.
- Shared copy helpers already define the canonical `/task` usage string and several thread or root rejection messages.

The gap is not primarily missing behavior. The gap is the lack of one authoritative external document that states this contract cleanly.

## 7. Approaches Considered

### Approach A - Minimal command reference

Create a lightweight reference file with one section per command and little shared framing.

**Pros**

- Fastest to write
- Easy for humans to skim

**Cons**

- Too weak as a single source of truth
- Does not clearly establish how to interpret context-wide rules
- Makes future drift more likely because command-independent constraints are left implicit

### Approach B - Contract-first command catalog (recommended)

Create a repo-root `COMMANDS.md` with:

- a short normative preface
- explicit scope disclaimers
- shared context definitions (`root` vs `thread`)
- one section per external Lark command describing grammar, valid contexts, examples, and invalid forms

**Pros**

- Matches the user-requested document style
- Strong enough to act as a real source of truth
- Readable for humans and still precise for agents
- Keeps exact-shape requirements explicit without over-specifying internal mechanics

**Cons**

- Slightly heavier than a minimal command list
- Requires careful wording to distinguish current behavior from implementation rationale

### Approach C - Contract plus governance appendix

Create the contract catalog and add a stronger maintenance or governance appendix about future derivation into tests or help text.

**Pros**

- Strongest long-term governance
- Useful if automated enforcement is imminent

**Cons**

- Heavier than needed for v1
- Adds policy material the user explicitly deprioritized in favor of release discipline

## 8. Recommendation

Adopt **Approach B**.

It is the smallest design that still makes `COMMANDS.md` a genuine external contract rather than just another reference page. It also matches the chosen format directly: one repo-root document, Lark-only, command-catalog style, and exact on valid or invalid shapes.

## 9. Proposed Design

### 9.1 File location and authority

Create a new repo-root file:

- `COMMANDS.md`

This file becomes the authoritative external contract for LocalAgent's Lark command surface.

Authority rules:

- `COMMANDS.md` defines the external behavior contract.
- Feature design docs may explain **why** command behavior exists or how it is implemented, but they should not become the authoritative source for the external command surface.
- When command behavior changes, `COMMANDS.md` must be updated as part of the same change set.

### 9.2 Scope statement

The document should open with a concise scope section that states:

- the contract is for **Lark interactions only**
- the contract covers **external commands only**
- internal pipeline concepts and API payload shapes are intentionally excluded
- exact command shape is normative
- examples are illustrative, not exhaustive
- the document reflects **current behavior**

### 9.3 Global concepts section

Before command entries, `COMMANDS.md` should define only the minimum shared concepts needed to read the catalog:

- **Root message**: a new message outside an existing bot thread
- **Thread reply**: a reply inside an existing bot thread
- **Valid**: accepted as a command in that context
- **Invalid**: rejected in that context, with an error or help response

This section should stay short and avoid exposing internal concepts such as `thread_reply`, task queue payloads, or enrichment stages.

### 9.4 Command catalog structure

Each command section should use the same template:

- Command name
- Purpose
- Grammar
- Valid contexts
- Invalid forms
- Examples
- Notes

The format should be optimized for scanability in Markdown and simple enough for agentic tools to parse heuristically.

### 9.5 Commands in scope

The catalog should include exactly these external commands in v1:

- `/task`
- `/new`
- `/end`
- `/gc`

No sections should be added for:

- plain root messages
- plain thread replies
- non-text messages
- internal task types
- CLI commands
- API routes

Those behaviors may be mentioned only when necessary inside a command's invalid-form or context notes.

### 9.6 `/task` section requirements

The `/task` entry should define the exact grammar as:

```text
/task <type> <executor> <model> <payload>
```

It should state:

- valid only as a **root message**
- invalid in threads
- payload must begin on the same line as `<model>`
- payload may continue across subsequent lines
- partial forms are invalid

It should include examples of:

- a valid single-line command
- a valid multiline-payload command
- invalid partial forms such as `/task`, `/task <type>`, `/task <type> <executor>`, `/task <type> <executor> <model>`
- an invalid threaded `/task ...`

It should not freeze exact error copy beyond requiring that invalid forms are rejected.

### 9.7 `/new` section requirements

The `/new` entry should define these accepted shapes:

```text
/new
/new <executor> <model>
```

It should state:

- valid only in a **thread**
- invalid as a root message
- `/new` resets to a fresh instance while staying in the current threaded conversation model
- `/new <executor> <model>` is also thread-only
- malformed argument counts are invalid

Examples should include one bare `/new`, one explicit `/new <executor> <model>`, and invalid root or malformed forms.

### 9.8 `/end` section requirements

The `/end` entry should define the exact grammar as:

```text
/end
```

It should state:

- valid only in a **thread**
- invalid as a root message
- any extra arguments or trailing content are invalid

### 9.9 `/gc` section requirements

The `/gc` entry should define the exact grammar as:

```text
/gc
```

It should state:

- valid only as a **root message**
- invalid in a thread
- any extra arguments or trailing content are invalid

### 9.10 `COMMANDS.md` content shape

The new root document should stay compact and operationally precise.

A recommended top-level structure is:

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

Within each command section, the implementation should use a stable subsection order so both humans and agentic tools can scan it predictably:

```md
### /command
Purpose
Grammar
Valid contexts
Invalid forms
Examples
Notes
```

### 9.11 Markdown style and precision

Because the file must serve both humans and agentic tools, the writing style should be:

- terse
- exact
- table-light or table-free unless a table clearly improves readability
- explicit about valid or invalid shapes
- sparse on rationale

A command-catalog layout with short subsections is preferred over a context matrix.

### 9.12 Relationship to existing docs

Existing feature design docs should remain for implementation rationale and internal architecture, but future command-behavior statements should point back to `COMMANDS.md`.

This means the implementation work should also include a small cleanup pass on the most relevant command-behavior design docs so they reference the new root contract instead of implicitly acting as the contract themselves.

### 9.13 Release-discipline drift control

v1 should rely on process rather than automation.

The design should require a short maintenance note in `COMMANDS.md` or adjacent docs stating:

- command-surface changes must update `COMMANDS.md` in the same PR
- reviewers should treat command-contract drift as a release blocker

This is intentionally lighter than code generation or contract tests, but still makes the ownership expectation explicit.

## 10. Open Questions Resolved

All material product-direction questions for this design have been resolved through clarification. No blocking open questions remain for implementation planning.
