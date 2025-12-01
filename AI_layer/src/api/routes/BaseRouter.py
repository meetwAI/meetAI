from __future__ import annotations

from typing import Optional
from fastapi import APIRouter, Depends
from src.core.logging import logger

class Router:
    """Base router class that all routers should inherit from."""
    
    def __init__(
        self,
        prefix: str,
        tags: Optional[list[str]] = None,
        dependencies: Optional[list[Depends]] = None
    ):
        """
        Initialize base router.
        
        Args:
            prefix: URL prefix for all routes (e.g., "/qna")
            tags: OpenAPI tags for documentation grouping
            dependencies: FastAPI dependencies to apply to all routes
        """
        self.router = APIRouter(
            prefix=prefix,
            tags=tags or [],
            dependencies=dependencies or []
        )
        self._setup_routes()
        logger.info(f"Router initialized: {prefix}", extra={"tags": tags})
    
    def _setup_routes(self) -> None:
        """
        Override this method in child classes to define routes.
        This is called automatically during initialization.
        """
        pass
    
    def get_router(self) -> APIRouter:
        """Return the FastAPI router instance."""
        return self.router