"""Production WebSocketConnector backed by the `websockets` library.

This is the concrete swap-point implementation of the WebSocketConnector
Protocol declared in app/capture/rtms_client.py. Tests inject a fake;
production wires this at app startup (app/main.py). Imported lazily to
avoid a hard `websockets` import at module load time — the `websockets`
package ships with uvicorn[standard], so it is always present, but keeping
the import local makes the separation between Protocol and implementation
explicit.
"""

from __future__ import annotations

from app.capture.rtms_client import WebSocketConn


class _WsConn:
    """Thin adapter: maps websockets.ClientConnection to WebSocketConn."""

    def __init__(self, ws) -> None:
        self._ws = ws

    async def send(self, data: str | bytes) -> None:
        await self._ws.send(data)

    async def recv(self) -> str | bytes:
        return await self._ws.recv()

    async def close(self) -> None:
        await self._ws.close()


class WebsocketsConnector:
    """Production WebSocketConnector — connects to any wss:// URL using
    the `websockets` library (bundled with uvicorn[standard])."""

    async def connect(self, url: str) -> WebSocketConn:
        import websockets

        ws = await websockets.connect(url)
        return _WsConn(ws)
