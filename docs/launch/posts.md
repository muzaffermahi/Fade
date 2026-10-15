# Launch drafts (you publish)

## r/LocalLLaMA
**Title:** I got my flow back with coding agents: local model as the thinking partner, any model as the builder

Waiting on agents wrecks my focus, so I built Fade. One Builder builds the current step; a Companion (can be a local
model, it only reads and talks) helps me shape the next one. The screen shows one NEXT thing, a runway meter says how
long I can think before the Builder starves, and nothing moves while I'm typing. Works with any Pi-supported model.
Honest limits: Builders need strong tool calling; small local models are better as the Companion. [GIF] [link]

## X thread
1. "Claude is the one flowing, not me." Everyone using coding agents feels this. I built Fade to fix it. [GIF]
2. One thread, one next thing. The Builder drives; you navigate.
3. The runway meter: how long you can think before the machine runs out of work.
4. It never interrupts mid-thought. Things land at your breakpoints.
5. Your session recap is a card you can screenshot. [recap] npx @muzaffermahi/fade --demo

## Show HN
**Show HN: Fade, navigate while your coding agent drives**
Plan the next step while the current one builds. One goal, one NEXT line, a runway meter, feedback-first review.
Any model, local included. `npx @muzaffermahi/fade --demo` needs no key.

## Essay outline: "Claude is the one flowing, not me"
Prompt-wait-evaluate kills flow; attention residue; interruptions cost less at breakpoints; reviewing a diff you
didn't specify; the navigator role; one thread; Fade as the proof.
