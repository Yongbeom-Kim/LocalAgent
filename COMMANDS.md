# COMMANDS.md

## Scope

This document defines the **external Lark command contract** for this repo.

- Lark-only: this contract applies only to messages sent to the bot in Lark.
- External-commands-only: this document covers only the user-visible commands listed below.
- Exact command shape is normative: accepted grammar, contexts, and invalid forms are defined here.
- This document describes current behavior.
- Examples are illustrative, not exhaustive.

Out of scope (by design):

- CLI behavior
- API request/response shapes
- internal task types or internal queue/job payloads
- enumerating valid task types, executors, or model values

## Shared Terms

- **Root message**: a top-level message (not a reply inside an existing bot thread).
- **Thread reply**: a message posted as a reply inside an existing bot thread.

Default non-command behavior:

- A **root message** that is not a recognized command is rejected with a `/task` usage hint.
- A **thread reply** that is not a recognized command is treated as natural-language continuation.

Failure classes (high-level):

- **Shape invalid**: the message starts with a command but does not match that command's grammar.
- **Context invalid**: the command's shape is valid, but it is used in the wrong context (root vs thread).
- **Routing invalid**: the command's shape and context are valid, but values are rejected during routing (for example unknown task type/executor/model, or missing required payload).

Error messages are not part of this contract; only the acceptance/rejection behavior and invalidity class are.

## Commands

### /task

**Purpose**

Start a new task from a root message.

**Grammar**

```text
/task <type> <executor> <model> <payload>
```

**Valid Contexts**

- Root message only.

**Invalid Forms**

- Any use in a thread reply. (Context invalid.)
- `/task` (missing arguments). (Shape invalid.)
- `/task <type>` (missing arguments). (Shape invalid.)
- `/task <type> <executor>` (missing arguments). (Shape invalid.)
- `/task <type> <executor> <model>` (missing `<payload>`). (Shape invalid.)
- Payload that starts on the next line:

```text
/task <type> <executor> <model>
<payload>
```

(Shape invalid.)

**Examples**

Valid single-line:

```text
/task <type> <executor> <model> <payload>
```

Valid multi-line payload (payload begins on the first line and may continue on later lines):

```text
/task <type> <executor> <model> first line of payload
second line of payload
third line of payload
```

**Notes**

- `<payload>` must begin on the same line as `<model>`.
- Multi-line payloads are supported only after the payload has started on the first line.
- Externally observable edge case (confirmed in code): parsing is driven by the first line. If the first line does not contain all three fields plus at least one payload character, the command is rejected as shape invalid.

### /new

**Purpose**

Start a new session instance within an existing thread.

**Grammar**

```text
/new
/new <executor> <model>
```

**Valid Contexts**

- Thread reply only.

**Invalid Forms**

- Any use as a root message. (Context invalid.)
- Any malformed argument count (for example exactly one argument, or more than two). (Shape invalid.)

**Examples**

Valid (use inherited defaults for this thread):

```text
/new
```

Valid (explicitly choose executor and model for the new instance):

```text
/new <executor> <model>
```

**Notes**

- If `/new` is accepted, it remains within the same thread; it does not create a new root message.

### /end

**Purpose**

End or clean up the current thread session.

**Grammar**

```text
/end
```

**Valid Contexts**

- Thread reply only.

**Invalid Forms**

- Any use as a root message. (Context invalid.)
- Any trailing arguments or extra content (including newlines). (Shape invalid.)

**Examples**

Valid:

```text
/end
```

Invalid (extra content):

```text
/end please
```

**Notes**

- `/end` is rejected unless it can be associated with an existing thread session.

### /gc

**Purpose**

Trigger a GC run.

**Grammar**

```text
/gc
```

**Valid Contexts**

- Root message only.

**Invalid Forms**

- Any use in a thread reply. (Context invalid.)
- Any trailing arguments or extra content (including newlines). (Shape invalid.)

**Examples**

Valid:

```text
/gc
```

Invalid (extra content):

```text
/gc now
```

**Notes**

- `/gc` is rejected if sent inside a thread.

## Maintenance

- Any change to the externally visible Lark command surface must update `COMMANDS.md` in the same PR.
- If other docs disagree with this file, `COMMANDS.md` wins for the external contract.
