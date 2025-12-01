from __future__ import annotations

from fastapi import HTTPException, status
from pydantic import BaseModel, Field
from src.api.routes.BaseRouter import Router
from src.core.logging import logger


class QnARouter(Router):
    """Router for Question & Answer endpoints."""
    
    def __init__(self):
        # Initialize parent with route configuration
        super().__init__(
            prefix="/qna",
            tags=["Question & Answer"]
        )
    
    def _setup_routes(self) -> None:
        """Define all QnA-related routes."""

        @self.router.get(
            "/health",
            status_code=status.HTTP_200_OK,
            summary="Health check",
            description="Check if QnA service is operational"
        )
        async def health_check():
            """Simple health check endpoint."""
            return {"status": "healthy", "service": "qna"}