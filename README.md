# ProofLoop

Agents shouldn't stop because they think they're done. They should stop because they can prove they're done.

ProofLoop is a one-screen prototype for the SF Hacks x GDG AI Hackathon. A community-event signup checker has a weak password rule. You describe the goal in a sentence. The loop stops only when the signup tests actually pass.

Three parts stay separate:

1. **The model interprets intent.** Gemini compiles the sentence into a loop contract. With no API key, a local compiler reads the sentence itself (don't touch the tests, ask before deleting, max attempts).
2. **A deterministic harness controls execution.** Attempts, policies, approval, and stop are code.
3. **An external verifier decides completion.** The username, password, and email checks run the functions in this process.

## Run

```bash
npm install
npm run dev
```

Open [http://127.0.0.1:38471](http://127.0.0.1:38471).

Optional Gemini key, in `.env.local`:

```bash
GEMINI_API_KEY=your-key
# or GOOGLE_API_KEY=your-key
# GEMINI_MODEL=gemini-2.5-flash
```

Without a key the header says **Local compiler**. The demo still runs. Gemini's only job is natural language to contract JSON.

## Demo in under a minute

1. Click **Signup checker preset**.
2. Click **Compile contract** and read the JSON.
3. Click **Run loop**.
4. Attempt 1 edits the password length only. The tests still fail, so the loop continues. An edit to `signup.test.ts` is blocked. The harness then asks to delete `legacy-helper.ts`.
5. Click **Deny** (or **Allow once**). Deny leaves the helper in place.
6. Attempt 2 applies the real password rule. The verifier passes. The harness stops and the proof panel fills in.

**Pause** holds the same attempt. **Reset** restores the buggy checker.

## Sample project

`sample/community-signup/`

- `validator.ts` accepts any password of 4+ characters.
- `signup.test.ts` checks username, password, and email. Password starts failing.
- `legacy-helper.ts` is a stale draft nothing imports.

## Tests

```bash
npm test
```
