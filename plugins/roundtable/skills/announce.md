---
name: roundtable-coordinate
description: Coordinate with other Sumo agents using roundtable-room and roundtable-announce. Trigger on roundtable, collision, file claim, concurrent edit, broad refactor, or multi-agent coordination requests.
when_to_use: Use when other agents are active, when a file-claim collision blocks work, or before broad multi-file changes that need coordination.
model: any
reasoning: low
---

# roundtable-announce

You are working in a shared repository where other agents may be active simultaneously.

## When to use this skill

Use `roundtable-announce` and `roundtable-room` when:
- You notice the `[roundtable]` prefix in your context indicating other agents are active
- You are about to make significant changes (architectural shifts, refactors touching many files)
- You hit a file-collision denial and want to coordinate with the holding agent
- You finish a block of work and want to signal others that files are now available

## How to use

**Check who's working:**
```
roundtable-room
```
Returns active agents, files they're touching, and recent announcements.

**Announce your intent before broad changes:**
```
roundtable-announce "Refactoring auth module — touching src/auth/*.mjs"
```

**Coordinate on a collision:** When denied a write because another agent holds the file, call
`roundtable-room` to see who holds it and `roundtable-announce` to state what you need.

## What NOT to do

- Do not spam announcements for every small edit — announce when your scope is broad or uncertain
- Do not block indefinitely on a collision — retry after a short wait; the holder's claim expires
  automatically if they stop working
