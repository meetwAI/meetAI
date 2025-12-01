from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager

from configs.settings import settings
from src.core.logging import logger
from src.api.routes.qna import QnARouter
from src.api.routes.streaming import StreamingRouter

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown events."""
    logger.info("🚀 Application starting up...")
    # TODO: Initialize services, DB connections, etc.
    yield
    logger.info("👋 Application shutting down...")
    # TODO: Cleanup resources

# Create FastAPI app
app = FastAPI(
    title=settings.PROJECT_NAME,
    version=settings.PROJECT_VERSION,
    lifespan=lifespan,
    docs_url="/docs",
    redoc_url="/redoc"
)

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # TODO: Configure properly for production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Register routers
qna_router = QnARouter()
streaming_router = StreamingRouter()

app.include_router(qna_router.get_router())
app.include_router(streaming_router.get_router())

# Root endpoint
@app.get("/", tags=["Root"])
async def root():
    """Root endpoint with basic info."""
    return {
        "name": settings.PROJECT_NAME,
        "version": settings.PROJECT_VERSION,
        "environment": settings.ENV,
        "docs": "/docs"
    }

# Run with: uvicorn main:app --reload 