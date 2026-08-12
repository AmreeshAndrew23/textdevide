import os
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.database import init_db
from app.routes.auth import router as auth_router
from app.routes.projects import router as projects_router
from app.routes.generate import router as generate_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    yield


app = FastAPI(title="Text Dev IDE", version="1.0.0", lifespan=lifespan)

ALLOWED_ORIGINS = os.getenv("ALLOWED_ORIGINS", "http://localhost:5173,http://localhost:5174").split(",")

# allow_credentials=True is incompatible with allow_origins=["*"] (CORS spec).
# This app uses Authorization header tokens (not cookies) so credentials=False
# is safe with wildcard; for specific origins credentials=True is fine.
_wildcard = ALLOWED_ORIGINS == ["*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=not _wildcard,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_router, prefix="/api")
app.include_router(projects_router, prefix="/api")
app.include_router(generate_router, prefix="/api")


@app.get("/api/health")
async def health():
    return {"status": "ok"}
