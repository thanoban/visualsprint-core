---
name: sweep-fix
description: Fix an entire class of issue across the codebase in one pass instead of one file at a time. Use whenever a bug, inconsistency, or pattern you just fixed in one place is likely to exist elsewhere too -- a hardcoded value that should be a token, a deprecated API call, a missing null check, a naming drift, a security pattern. Also use proactively before saying a fix is "done" when the fix was for a pattern (not a one-off typo).
---

# Sweep-fix

The failure mode this exists to prevent: fixing the same class of bug turn after turn
because each fix only addressed the one file/line the user happened to point at, while
siblings of the same problem sit unfixed elsewhere in the codebase -- discovered later,
one at a time, each requiring a fresh round trip.

Concrete example from this repo's history: `--accent` was repointed from teal to blue
app-wide, but several places (report page confidence badges, people page lifecycle
state, actions page status colors, upload page pipeline/bot status, connections page
banners) were using `--accent` to mean "success/verified", not "brand color" -- each
was found and fixed **separately**, several tool round-trips apart, instead of being
swept in one pass right after the first one was spotted.

## When to use

Trigger this whenever:
- You just fixed something and the fix's *shape* (not just its specific instance)
  could plausibly recur -- a hardcoded color/string that should reference a shared
  token, a semantic mix-up (using token X for meaning Y elsewhere), a deprecated
  pattern, an unhandled edge case, a missing check that exists in one place but not
  its siblings.
- The user says some version of "this keeps happening", "fix all of them", "find every
  place", or reports the same bug a second time in a different file.
- Before declaring a pattern-level fix complete -- a sweep costs one search, silence
  costs another round trip per missed instance.

Do NOT use for genuine one-offs (a single typo, a bug that only exists in one place by
construction, e.g. a config value used exactly once).

## Instructions

1. **Name the pattern precisely**, not just the symptom. Not "this color is wrong" but
   "any use of `--accent` where the surrounding meaning is success/verified/positive
   rather than brand/interactive". A vague pattern produces a vague, incomplete grep.

2. **Search exhaustively for every instance**, not just the one the user flagged.
   Prefer `Grep` across the whole relevant tree (not just the file open in context) --
   for a token/string pattern, grep the literal; for a structural pattern (a missing
   check, a deprecated call shape), grep the surrounding shape and read each hit.
   Do this BEFORE writing any fix, so the fix set is known up front instead of
   discovered incrementally.

3. **Classify every hit** into: needs the same fix / already correct (a look-alike that
   isn't actually the same problem -- don't force it) / genuinely ambiguous (surface
   this one to the user instead of guessing). Write the classification down (a short
   list in your response) before editing -- this is what makes the sweep verifiable
   instead of a hope.

4. **Fix every "needs the same fix" hit in this same turn**, not across several turns.
   Batch the edits. If the count is large (>15-20 call sites), say so and confirm scope
   with the user rather than silently doing a partial sweep.

5. **Verify once, at the end, across the whole batch** -- typecheck/lint/build/tests for
   the whole change set, not per-file. This is also cheaper in tokens than N separate
   verify passes.

6. **Report the sweep, not just the fix**: how many instances were found, how many
   fixed, how many were look-alikes left alone and why, so the user can trust the
   pattern is actually closed rather than wondering what else is still out there.
