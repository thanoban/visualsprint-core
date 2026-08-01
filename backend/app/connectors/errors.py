"""Shared exception types for connector execution failures."""


class ConnectorError(Exception):
    """Raised when an external API call fails or returns an error shape.

    Never caught-and-swallowed by connector code — a failed execute() must be
    visible to the caller, not silently reported as success.
    """


class ConnectorNotConfiguredError(ConnectorError):
    """Raised when a required credential/provider for the requested target
    provider was not supplied to the connector's constructor."""
