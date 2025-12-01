from __future__ import annotations

"""
Unified application logger with beautiful, structured output.

Features:
- Colorized output in development
- JSON logs in production (perfect for Datadog, ELK, Grafana Loki, etc.)
- Automatic detection of environment (dev/prod)
- Includes trace_id, step name, node name when available
- Zero-config in most cases — just do `from src.core.logging import logger`

Usage:
    >>> from src.core.logging import logger
    >>> logger.info("Starting workflow", extra={"user_query": "What is AI?"})
    >>> logger.bind(step="WEB_SEARCH").success("Found 12 results")
"""


import sys
from loguru import logger as loguru_logger
from configs.settings import settings

# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #

# Remove default handler
loguru_logger.remove()

# Detect environment
IS_PROD = settings.ENV in {"production", "prod", "staging"}
IS_DOCKER = "DOCKER" in __import__("os").environ

# Common format parts
BASE_FORMAT = (
    "<green>{time:YYYY-MM-DD HH:mm:ss.SSS}</green> | "
    "<level>{level: <8}</level> | "
    "<cyan>{name}</cyan>:<cyan>{function}</cyan>:<cyan>{line}</cyan> | "
    "<level>{message}</level>"
)

# FIXED: Use get() with default values to avoid KeyError
JSON_FORMAT = (
    "{"
    '"time":"{time:YYYY-MM-DDTHH:mm:ss.SSSZ}",'
    '"level":"{level}",'
    '"message":"{message}",'
    '"module":"{module}",'
    '"function":"{function}",'
    '"line":{line}'
    "{extra}"  # This will include all extra fields as JSON
    "}"
)


# --------------------------------------------------------------------------- #
# Patch records to provide default values for optional fields
# --------------------------------------------------------------------------- #
def patcher(record):
    """Add default values for optional extra fields."""
    record["extra"].setdefault("step", None)
    record["extra"].setdefault("trace_id", None)
    record["extra"].setdefault("node", None)
    return record


# --------------------------------------------------------------------------- #
# Dev: pretty colors
# --------------------------------------------------------------------------- #
if not IS_PROD:
    loguru_logger = loguru_logger.patch(patcher)
    loguru_logger.add(
        sys.stdout,
        format=BASE_FORMAT,
        level=settings.LOG_LEVEL.upper(),
        colorize=True,
        backtrace=True,
        diagnose=True,
    )

# --------------------------------------------------------------------------- #
# Prod: structured JSON (Datadog, GCP, AWS, Loki, etc.)
# --------------------------------------------------------------------------- #
else:
    loguru_logger = loguru_logger.patch(patcher)
    loguru_logger.add(
        sys.stdout,
        format=JSON_FORMAT,
        level=settings.LOG_LEVEL.upper(),
        serialize=True,  # ← outputs valid JSON lines
        enqueue=True,    # ← safe for async
        backtrace=True,
        diagnose=False,  # ← hide in prod
    )

# --------------------------------------------------------------------------- #
# Optional: file logging (great for local debugging)
# --------------------------------------------------------------------------- #
loguru_logger = loguru_logger.patch(patcher)
loguru_logger.add(
    "logs/app.log",
    rotation="7 days",
    retention="30 days",
    compression="zip",
    level="DEBUG",
    enqueue=True,
    backtrace=True,
    diagnose=True,
)

# --------------------------------------------------------------------------- #
# Convenience methods (you'll use these everywhere)
# --------------------------------------------------------------------------- #
class Logger:
    """Wrapper to add nice success()/step()/trace() methods."""

    def __init__(self, logger):
        self._logger = logger

    def step(self, step_name: str):
        """Bind current orchestrator step/node."""
        return self._logger.bind(step=step_name)

    def trace(self, trace_id: str):
        """Bind a request/trace ID (e.g. from FastAPI header)."""
        return self._logger.bind(trace_id=trace_id or "none")

    def node(self, node_name: str):
        """Current LangGraph node."""
        return self._logger.bind(node=node_name)

    # Proxy all other methods
    def __getattr__(self, name):
        return getattr(self._logger, name)

# Global logger instance — import this everywhere
logger = Logger(loguru_logger)