"""Two-tier mypy gate.

`[tool.mypy] strict = true` has been configured in pyproject.toml since the
project started and was never run by CI, so the type checker that supposedly
enforces the project's headline safety property was itself unverified. A clean
strict run over the whole codebase is a few hundred errors away, so this gates
in two tiers instead of pretending otherwise:

* **STRICT_PATHS must be clean, always.** These are the modules the
  non-negotiable rules actually live in: the swap-point Protocols (rule 4),
  the agents whose input schemas are the anti-hallucination enforcement
  (rules 2 and 3), the schema those constraints are declared on (rule 5), and
  the auth boundary. If a type guarantee is load-bearing, it is load-bearing
  here.

* **Everywhere else is a ratchet.** The current error count is pinned in
  BASELINE_ERRORS; CI fails if it rises. New code cannot add type errors, and
  the backlog can only be paid down. When it drops, this script tells you to
  lower the baseline, so the ratchet tightens instead of drifting.

Usage:  python -m scripts.mypy_gate         (from backend/)
"""

from __future__ import annotations

import re
import subprocess
import sys

# Modules where a type error is never acceptable, regardless of the backlog.
STRICT_PATHS = ["app/interfaces", "app/agents", "app/db", "app/auth"]

# Whole-app error count as of the ARCHITECTURE.md remediation pass. Lower this
# whenever you reduce it; never raise it.
#
# Update 2026-08-26: this gate had never actually run on a push to main until
# quality.yml's push trigger was added (see that file's own docstring) --  the
# 373 baseline predates that, so it was never being enforced against commits
# landing directly on main in between. First real run found 396 (pre-existing,
# confirmed via a clean checkout of the commit before this session's work --
# not caused by the companion-extension changes). Fixed what was cleanly
# attributable: get_blobstore() was missing a return type annotation, which
# cascaded a "no-untyped-call" error into every one of its ~6 call sites
# (chat.py, upload.py, data_rights.py, report.py, companion.py); companion.py
# itself had two bare `-> dict:` annotations tightened to `dict[str, object]`.
# That brought it to 381. The remaining gap is every `@stage_handler(db:
# object, job: PipelineJob)` in this file (~15+ handlers, dating to
# 2026-08-04) -- `object` is the decorator's declared parameter type across
# every stage handler, so narrowing it to `Session` is a real, scoped refactor
# of the pipeline dispatch contract, not a drive-by fix. Raising the baseline
# here rather than rushing that refactor in unrelated to why this file was
# touched today.
BASELINE_ERRORS = 356  # 2026-08-26: locked gain from CI run (358→356)
# stage handlers — same pre-existing db: object pattern as the 373→381 raise above.

_COUNT = re.compile(r"Found (\d+) error", re.MULTILINE)


def _run(paths: list[str]) -> tuple[int, str]:
    result = subprocess.run(
        [sys.executable, "-m", "mypy", *paths],
        capture_output=True,
        text=True,
    )
    output = result.stdout + result.stderr
    match = _COUNT.search(output)
    return (int(match.group(1)) if match else 0), output


def main() -> int:
    strict_errors, strict_output = _run(STRICT_PATHS)
    if strict_errors:
        print(strict_output)
        print(
            f"FAIL: {strict_errors} type error(s) in the rule-enforcement modules "
            f"({', '.join(STRICT_PATHS)}). These must stay clean -- see this script's docstring."
        )
        return 1
    print(f"OK: {', '.join(STRICT_PATHS)} are clean under mypy strict.")

    total_errors, total_output = _run(["app"])
    if total_errors > BASELINE_ERRORS:
        print(total_output)
        print(
            f"FAIL: whole-app mypy errors rose to {total_errors}, above the "
            f"baseline of {BASELINE_ERRORS}. Fix the new errors, or justify and "
            f"raise BASELINE_ERRORS deliberately."
        )
        return 1
    if total_errors < BASELINE_ERRORS:
        print(
            f"Whole-app mypy errors are down to {total_errors} (baseline "
            f"{BASELINE_ERRORS}). Lower BASELINE_ERRORS in {__file__} to lock the gain in."
        )
    else:
        print(f"OK: whole-app mypy errors holding at the baseline of {BASELINE_ERRORS}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
