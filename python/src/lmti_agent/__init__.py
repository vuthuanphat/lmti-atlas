"""Scoped project understanding for external Agents via replaceable source adapters."""
from lmti_project import Grant
from .client import AgentError, Client
from .source import NativeProjectSource

__all__ = ["AgentError", "Client", "Grant", "NativeProjectSource"]

