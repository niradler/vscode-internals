# Git / SCM

Two paths: lightweight built-in endpoints, and full `vscode.git` API via `/extensions/invoke`.

Uses the `vsc` wrapper from `SKILL.md`.

## Quick reads (built-in)

```bash
# Probe whether the git extension is available
vsc $BASE/scm/inputBox | jq '.available'

# All repos VSCode knows about
vsc $BASE/scm/git/repositories | jq '.repositories[] | {
  root: .rootUri.fsPath, head: .headBranch, changes: .workingTreeChanges, indexChanges
}'

# Detailed working-tree / index / merge status for the first repo
vsc -d '{}' $BASE/scm/git/status

# Status for a specific repo
vsc -d '{"rootUri":"file:///g:/Projects/foo"}' $BASE/scm/git/status
```

Returns include: `working`, `index`, `merge`, `untracked`, `head`, `remotes`. Field names follow the built-in git extension.

## Full API (`vscode.git` via `/extensions/invoke`)

For everything not covered by the built-in endpoints — diff, log, blame, commit, push, branches.

```bash
# Get the API handle (returns the Git API v1 object — non-serializable, but we get a stub)
vsc -d '{"id":"vscode.git","path":"getAPI","args":[1]}' $BASE/extensions/invoke | jq '.result | keys'

# Repositories with head + remotes
vsc -d '{"id":"vscode.git","path":"getAPI","args":[1]}' $BASE/extensions/invoke | \
  jq '.result.repositories[] | {root: .rootUri.fsPath, head: .state.HEAD.name, remotes: [.state.remotes[].name]}'
```

`Repository` methods you can reach by dot-walking `result.repositories[N]`:

| Method | Use |
|---|---|
| `status()` | Refresh git state |
| `diff(cached?)` / `diffWithHEAD(path)` / `diffBetween(ref1, ref2, path?)` | Get diffs |
| `show(ref, path)` | File contents at a ref |
| `getCommit(ref)` / `log(options)` | Commit metadata |
| `add(uris)` / `revert(uris)` | Stage / unstage |
| `commit(message, options?)` | Commit |
| `push(remote?, branch?, force?)` / `pull(unshallow?)` / `fetch(remote?, ref?, depth?)` | Sync |
| `createBranch(name, checkout?, ref?)` / `deleteBranch(name, force?)` / `checkout(treeish)` | Branches |
| `getBranches(...)` | Enumerate |
| `tag(name, ref?)` / `getRefs(...)` | Tags / refs |
| `blame(path)` | Blame |

Note: `Repository` instances aren't directly addressable via `/extensions/invoke` because they're class instances — but commands work everywhere.

## Easier: palette commands for git ops

Anything in the **Git** palette section works via `/commands/execute`. Discover with:

```bash
vsc "$BASE/commands/list?filter=git." | jq '.commands[]'
```

Common ones:

```bash
vsc -d '{"command":"git.commit"}'              $BASE/commands/execute
vsc -d '{"command":"git.commitStaged"}'        $BASE/commands/execute
vsc -d '{"command":"git.push"}'                $BASE/commands/execute
vsc -d '{"command":"git.pull"}'                $BASE/commands/execute
vsc -d '{"command":"git.checkout"}'            $BASE/commands/execute  # opens picker
vsc -d '{"command":"git.openChange","args":["file:///g:/p/x.ts"]}' $BASE/commands/execute  # diff against HEAD
vsc -d '{"command":"git.openFile","args":["file:///g:/p/x.ts"]}'   $BASE/commands/execute
vsc -d '{"command":"git.stage","args":["file:///g:/p/x.ts"]}'      $BASE/commands/execute
vsc -d '{"command":"git.unstage","args":["file:///g:/p/x.ts"]}'    $BASE/commands/execute
vsc -d '{"command":"git.clean","args":["file:///g:/p/x.ts"]}'      $BASE/commands/execute  # discard
```

Many commands open VSCode UI (commit input box, branch picker) — the call returns once the UI surfaces, not once the user finishes. To get a deterministic result, combine with `showInputBox` / `showQuickPick` and the underlying repo methods.

## Subscribe to git events

```bash
# Repository state changes (commits, status updates) require listening on the git API itself.
# For UI-level coarse events, watch:
vsc -N "$BASE/events?subscribe=onDidChangeConfiguration,onDidSaveTextDocument"
# (saves often trigger git status refresh)
```

The git extension exposes `repository.state.onDidChange` over its API but it's not currently bridged to SSE — invoke `/scm/git/status` after relevant events instead.

## Shell-out fallback

For complex git ops (interactive rebase, cherry-picks, history rewriting), don't fight the API — open a terminal:

```bash
vsc -d '{"name":"git","cwd":"g:/Projects/foo","show":true}'             $BASE/window/createTerminal
vsc -d '{"name":"git","text":"git rebase -i origin/main","addNewLine":true}' $BASE/window/terminalSendText
```

## Composition

**Self-review uncommitted changes:**

```text
GET /scm/git/repositories
→ for each working-tree URI:
  POST /workspace/getDocumentText { uri }            # current contents
  POST /commands/execute { command:"git.openChange", args:[uri] }
  POST /lm/sendRequestStream … "Review this change"
  POST /window/outputChannel/append { name:"PR Review" }
POST /window/showInformationMessage { items:["Stage all","Amend","Discard"] }
```

**Branch picker + checkout:**

```text
POST /commands/execute git.checkout
# OR build it yourself:
POST /extensions/invoke vscode.git.getAPI[1] → repositories[0]
POST /window/showQuickPick { items: branches }
POST /commands/execute git.checkout args:[picked]
```

## Gotchas

- `/scm/git/*` are convenience wrappers around the built-in git extension. They return `{available:false}` if the user has disabled the git extension.
- The Git API v1 (`getAPI(1)`) is stable; newer versions (`getAPI(2)`, etc.) may appear — check what's exported on the user's machine.
- Repository state can be stale immediately after an external file change. Call `repository.status()` before reading working-tree-changes if precision matters.
- Many `git.*` palette commands operate on the *active SCM repository* — in multi-root workspaces, the active one is what's shown in the SCM view. Pass `uri` args explicitly when possible.
