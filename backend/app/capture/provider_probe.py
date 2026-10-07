"""Read-only Vexa contract probe. Never joins a meeting or downloads media.

Run: python -m app.capture.provider_probe
Requires VS_VEXA_BASE_URL and VS_VEXA_API_KEY in the process environment.
"""

import asyncio
import json
import os
from urllib.parse import urlsplit

import httpx


async def probe(base_url: str, api_key: str) -> dict[str, object]:
    parsed = urlsplit(base_url)
    loopback = parsed.hostname in {"localhost", "127.0.0.1", "::1"}
    if (not parsed.hostname or parsed.username or parsed.password or parsed.query
            or parsed.fragment or parsed.path not in ("", "/")
            or (parsed.scheme != "https" and not (parsed.scheme == "http" and loopback))):
        return {"ok": False, "error": "use_https_or_loopback_base_url"}
    if not api_key.strip():
        return {"ok": False, "error": "missing_api_key"}
    try:
        async with httpx.AsyncClient(base_url=base_url, headers={"X-API-Key": api_key},
                                     timeout=15, follow_redirects=False) as client:
            response = await client.get("/bots/status")
        if response.status_code != 200:
            return {"ok": False, "error": f"provider_http_{response.status_code}"}
        body = response.json()
        if not isinstance(body, dict) or not any(k in body for k in ("running_bots", "running")):
            return {"ok": False, "error": "unexpected_status_contract"}
        # No meeting URLs, participant data, provider bodies or credentials in console output.
        return {"ok": True, "api_reachable": True, "live_capture_verified": False}
    except (httpx.RequestError, ValueError):
        return {"ok": False, "error": "provider_unreachable_or_invalid_response"}


def main() -> None:
    result = asyncio.run(probe(os.environ.get("VS_VEXA_BASE_URL", ""),
                               os.environ.get("VS_VEXA_API_KEY", "")))
    print(json.dumps(result))
    raise SystemExit(0 if result["ok"] else 1)


if __name__ == "__main__":
    main()
