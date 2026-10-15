# Fade

Talk to it, keep thinking while it builds, and let Fade check its own work.

![Fade: checked means Fade ran it](docs/assets/demo.gif)

```sh
npx @muzaffermahi/fade --demo
npx @muzaffermahi/fade login
npx @muzaffermahi/fade
```

Needs Node 22.19+ and Git. The demo uses a temporary project, with no key or model calls.

- **Just talk to it.** One conversation; no modes or hotkeys to learn.
- **You never wait.** Keep talking while it builds.
- **Checked means Fade ran it.** Fade re-runs each check on the saved commit.
- **It only asks you about taste.** Testable results settle themselves or land quietly.

Try “add a version file”, then “make the help text friendlier”, “the second one”, “yes”, “undo that”.
Say **yes / undo that / show me / stop**. Correct a misunderstanding in words.
**Enter** sends, **Esc** stops the reply or closes a view, **Ctrl+C twice** quits.

## More

Real-tested model pairs (connect the corresponding provider first):

```sh
# Strong: Kimi for the voice and the work
fade --companion opencode-go/kimi-k3 --builder opencode-go/kimi-k3
# Budget: Kimi for the voice, Flash for the work
fade --companion opencode-go/kimi-k3 --builder opencode-go/deepseek-v4-flash
```

Flash-class voices follow conversation instructions inconsistently; use a stronger Fade voice even
when the Builder runs cheap. These pairs are examples from testing, not a guarantee of model behavior.
`/model` changes either model and saves the choice locally. Bring your own Pi-compatible provider.

Fade commits on your current branch as `fade: …`, including concurrent/uncommitted changes. It tells
you this on launch. Say “undo that” for an intelligent revert. Interrupted work is saved and paused;
say “continue” to resume. Use a disposable project for your first trial.

`PLAN.md` holds ordered work and Later ideas; hand edits are watched. Internal states remain
`draft`, `ready`, `building`, and `review`. You do not need to learn them to use Fade.
Show retains actual check output, changed files, and diff after acceptance and restart.

`fade_check` handles Python syntax and unittest/pytest, JavaScript syntax, and local TypeScript types.
It prefers `.venv`. Syntax-only success, zero tests, missing runtimes or dependencies are reported as
verification gaps. No language servers, runtimes or test frameworks are installed automatically.
Other languages use your project's own commands through the Builder's shell.

Both sessions have web search/fetch via pi-web-access. **Search queries go to the configured search
provider.** Availability depends on provider/network; settings stay in `~/.pi/agent/web-search.json`.
The Builder retains native MCP, codemode and tool_search. Unrelated Pi extensions stay in Pi;
Fade loads its bundled extensions while skills/templates still pass through. Configure MCP servers in
`~/.pi/agent/mcp.json` or trusted project `.pi/mcp.json`. Fade's voice has read-only project tools.

Skills/templates pass through to Pi. Use Pi in another terminal for its login/settings screens.
Commands: `/model`, `/login`, `/new`, `/show`, `/help`, `/quit`; PgUp/PgDn scroll.

## Development / release candidate

Version 0.5.0 is prepared locally; publishing is a separate owner action. Before publication,
run `npm ci`, `npm run build`, `npm pack`, then `npx ./muzaffermahi-fade-0.5.0.tgz --demo`.
Checks: `npm test`, `npm run check`, `npm run snapshot`.
Live checks: `node --import tsx scripts/live-smoke.ts all [voice-model] [builder-model]`.
See [final-pass results](docs/final-pass-results.md) for platform and human-study limits.
Built on Pi. MIT licensed.
