"""Compatibility entry point for hosts that run ``uvicorn app:app``."""

from server import app

__all__ = ["app"]
