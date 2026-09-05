# Assistant packs (drop-in)

An **assistant pack** is a single JSON file you drop into a folder. On the next launch
its assistants appear in Wayland as ordinary, editable presets, and its teams appear in
the Teams library as launchers. There is nothing to click, install, or import.

## Where to put it

```
<userData>/config/assistant-packs/
```

- macOS — `~/Library/Application Support/Wayland/config/assistant-packs/`
- Linux — `~/.config/Wayland/config/assistant-packs/`
- Windows — `%APPDATA%\Wayland\config\assistant-packs\`

The directory is created on first launch, so if it is not there yet, start Wayland once.
Only files ending in `.pack.json` are read; prompt bodies live next to them in the same
directory.

## Schema

```json
{
  "pack": "warrior",
  "version": 1,
  "generatedAt": "2026-09-05T00:00:00.000Z",
  "assistants": [
    {
      "id": "warrior-scout",
      "name": "Scout",
      "description": "Finds the thing before anyone asks for it.",
      "avatar": "🔭",
      "presetAgentType": "claude",
      "promptFile": "warrior-scout.en-US.md",
      "prompts": ["Scout the repo and tell me what changed."],
      "enabledSkills": ["deepsearch"],
      "tier": "jarvis-cheap",
      "autonomyRung": 2,
      "workspace": "/abs/path/or/empty"
    }
  ],
  "teams": [
    {
      "id": "warrior-desk",
      "name": "The Desk",
      "workspace": "/abs/path",
      "workspaceMode": "shared",
      "leader": "warrior-scout",
      "members": ["warrior-scout", "warrior-editor"],
      "tasks": [
        { "subject": "Survey", "description": "Collect the raw material.", "owner": "warrior-scout" },
        { "subject": "Cut", "owner": "warrior-editor", "blockedBy": ["Survey"] }
      ]
    }
  ]
}
```

### Header

| Field         | Required | Notes                                                                   |
| ------------- | -------- | ----------------------------------------------------------------------- |
| `pack`        | yes      | Slug (`[A-Za-z0-9][A-Za-z0-9_-]*`). Becomes the assistant **category**. |
| `version`     | yes      | Positive integer. Governs re-application — see _Updating a pack_ below. |
| `generatedAt` | no       | Informational only.                                                     |

### Assistants

| Field             | Required | Notes                                                                                               |
| ----------------- | -------- | --------------------------------------------------------------------------------------------------- |
| `id`              | yes      | Slug. Stored as `pack-<pack>-<slug>`; `warrior-scout` and `pack-warrior-scout` are the same record. |
| `name`            | yes      | Shown in the library.                                                                               |
| `description`     | no       |                                                                                                     |
| `avatar`          | no       | Emoji, a `lucide:Name` reference, or a `data:` URI.                                                 |
| `presetAgentType` | no       | e.g. `claude`. Resolved through the same defaulting as the built-in catalog.                        |
| `promptFile`      | no       | Plain file name, relative to the packs directory. Its content becomes the system prompt.            |
| `prompts`         | no       | Quick-prompt chips.                                                                                 |
| `enabledSkills`   | no       | Skill names to enable for this assistant.                                                           |
| `tier`            | no       | `jarvis-heavy` \| `jarvis-default` \| `jarvis-cheap`. Recorded and shown read-only.                 |
| `autonomyRung`    | no       | 1–4. Seeds the JARVIS ladder **only when no rung is stored yet** for that assistant.                |
| `workspace`       | no       | Absolute path. Recorded and shown read-only.                                                        |

`tier` and `workspace` are provenance, not behaviour: they are stored on the record as
`packMeta` and displayed read-only in the assistant editor. Nothing in the app enforces
them today.

If an assistant declares a `promptFile` that cannot be read, that assistant is **skipped**
(with a warning) rather than created without a prompt. A `promptFile` containing a path
separator is ignored.

### Teams

| Field           | Required | Notes                                                               |
| --------------- | -------- | ------------------------------------------------------------------- |
| `id`, `name`    | yes      | Same id rules as assistants.                                        |
| `leader`        | no       | An assistant id; placed first in the roster.                        |
| `members`       | no       | Assistant ids.                                                      |
| `workspace`     | no       | Absolute path (recorded as `packMeta`).                             |
| `workspaceMode` | no       | `shared` or `isolated`.                                             |
| `tasks`         | no       | Ordered pipeline: `subject`, `description`, `owner`, `blockedBy[]`. |

A team becomes a `kind: 'team'` launcher record — the same shape the built-in team
launchers use — with `teammates` set to leader-first member ids.

> **Tasks are a kickoff, not database rows.** Wayland's `team_tasks` table is keyed by a
> live `teams` row, which only exists once a launcher is actually launched, so a catalog
> record has nothing to pre-seed. The pipeline is therefore rendered into the launcher's
> kickoff prefill — an ordered, owner-tagged, dependency-annotated instruction the leader
> reads on its first turn. This is exactly how the built-in team launchers (e.g.
> `quiet-money-council`) express their pipelines.

## Updating a pack

Application is gated on `version`, recorded per pack under the `assistantPacks.applied`
config key:

| Situation                   | What happens                                                                                                    |
| --------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Pack has never been applied | Every row not already present is inserted.                                                                      |
| `version` ≤ the applied one | **Nothing at all.** Your edits survive; an assistant you deleted stays deleted.                                 |
| `version` > the applied one | New ids are inserted and existing pack rows are refreshed from the file. Your on/off toggle is still preserved. |

The corollary: **adding an assistant to an existing pack requires bumping `version`.**
A same-version re-run is a total no-op, which is what makes "I deleted that one" stick.

Prompt files are (re)written only for rows the run actually inserted or refreshed, so a
prompt you edited in the UI is not clobbered on a same-version boot.

## Verifying it loaded

Each pack logs one line at startup:

```
[assistantPacks] warrior v1: 12 assistants, 1 team (3 new, 9 unchanged)
```

Problems are logged as warnings on the same prefix — a malformed pack is skipped and the
remaining packs still load.

## Sample

A working sample pack (two assistants, one team, prompt bodies) lives at
`tests/fixtures/assistant-packs/`. Copy `sample.pack.json` plus the two `.md` files into
the drop-in directory and restart to see it appear.
