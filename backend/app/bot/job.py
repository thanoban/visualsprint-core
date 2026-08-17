"""Cloud Run Job entry point for a single Mode B bot session.

Cloud Run Jobs execute this module with VS_BOT_SESSION_ID set in the
container environment (passed as a containerOverride when the job is
triggered by the worker's dispatch sweep). One job execution = one meeting.
"""

import asyncio
import os
import sys


def main() -> None:
    bot_session_id = os.environ.get("VS_BOT_SESSION_ID") or (
        sys.argv[1] if len(sys.argv) > 1 else None
    )
    if not bot_session_id:
        raise SystemExit(
            "VS_BOT_SESSION_ID env var required (or pass as first positional arg)"
        )

    from app.bot.runner import run_bot_session

    asyncio.run(run_bot_session(bot_session_id))


if __name__ == "__main__":
    main()
