"""
StructurAI Dynamics — Backend API (FastAPI)
Phase 0: Minimal skeleton with health check and CORS
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(
    title="StructurAI Dynamics API",
    description="Backend API for AI-powered structural analysis",
    version="0.1.0",
)

# CORS — allow frontend dev server
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health_check():
    return {
        "status": "ok",
        "service": "structurai-api",
        "version": "0.1.0",
    }


@app.get("/api/v1/projects")
async def list_projects():
    """Placeholder — will be connected to PostgreSQL in Phase 1."""
    return {
        "projects": [],
        "message": "Database not yet connected (Phase 0 PoC)",
    }
