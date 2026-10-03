# ProofLoop

Agents shouldn't stop because they think they're done. They should stop because they can prove they're done.

The model proposes a loop contract. The harness owns termination. Nothing is marked done unless `proofAllowsDone` accepts a proof object that satisfies the contract: every named verifier command exited 0, files changed, the policy result, and the attempt count. A passing total of three signup checks is not the completion rule. The compiler is the interface, not the thing that decides the loop is finished.

The sample fixture is a community-event signup checker with a weak password rule. Username, password, and email checks execute in an isolated VM context running the controlled demo fixture.

## Run

```bash
npm install
npm run dev
```

Open [http://127.0.0.1:38471](http://127.0.0.1:38471).

Optional model key, in `.env.local` (gitignored, never commit it):

```bash
GEMINI_API_KEY=your-key
# or GOOGLE_API_KEY=your-key
# GEMINI_MODEL=gemini-3.8-flash
```

Without a key the header says **Local compiler**. The local compiler still parses the sentence (don't touch the tests, ask before deleting, max attempts). The demo loop still runs on a deterministic double, which is not a live model, and it still cannot be marked done without a proof object. With a key, Run loop asks Gemini for each step through `AgentBackend.proposeStep`. The model does not decide when the loop stops.

## Model, license, and dependencies

- **License:** [MIT](LICENSE), Copyright 2026 Bradley Haraguchi.
- **Model:** `gemini-3.8-flash` through the Gemini API (`@google/genai`). It compiles a natural-language goal into the loop contract and does not run the harness. Override it with `GEMINI_MODEL`. If that call fails, the local compiler is the fallback. `gemma-4-31b-it` accepts the same request, but the app route then returned HTTP 503 and HTTP 500, so it is not the configured model.
- **Key dependencies:** Next.js, React, `@google/genai`, and `typescript` (used at runtime to compile the signup fixture before the isolated VM runs it).

## Agent

The harness calls `AgentBackend.proposeStep` and applies the returned writes and deletes through the workspace. `src/lib/signup-double.ts` is the deterministic double used by tests and by the demo when no API key is set. `src/lib/gemini-agent.ts` calls Gemini when `GEMINI_API_KEY` or `GOOGLE_API_KEY` is set. If neither key is set, that backend throws and does not invent a step.

## Demo in under a minute

1. Click **Signup checker preset**.
2. Click **Compile contract** and read the JSON.
3. Click **Run loop**.
4. Attempt 1 edits the password length only. The tests still fail, so the loop continues. An edit to `signup.test.ts` is blocked. The harness then asks to delete `legacy-helper.ts`.
5. Click **Deny** (or **Allow once**). Deny leaves the helper in place.
6. Attempt 2 applies the real password rule. The verifier passes. The harness stops and the proof panel fills in.

**Pause** holds the same attempt. **Reset** restores the buggy checker.

## Verifiers

A contract names the commands that must exit 0:

```json
"verifier": {
  "commands": [
    { "type": "shell", "command": "npm test" },
    { "type": "shell", "command": "npm run build" }
  ]
}
```

The signup preset keeps the built-in fixture, which also passes only on exit code 0:

```json
"verifier": { "commands": [{ "type": "fixture", "id": "signup" }] }
```

Say `npm test` or `npm run build` in the goal and the local compiler puts those shell commands on the contract. Shell commands run on the machine that serves the app, in the repo directory, with a one-minute timeout.

## Workspace

Reads, writes, deletes, diffs, status, and shell commands go through the workspace. A policy engine returns `allow`, `deny`, or `ask` before the action. `deny` leaves the file untouched. `ask` waits for a grant. The signup demo keeps its files in a memory workspace; `POST /api/exec` runs an allowed verifier command through a filesystem workspace rooted at the repo.

## Sample project

`sample/community-signup/`

- `validator.ts` accepts any password of 4+ characters.
- `signup.test.ts` checks username, password, and email. Password starts failing.
- `legacy-helper.ts` is a stale draft nothing imports.

## Tests

```bash
npm test
```
