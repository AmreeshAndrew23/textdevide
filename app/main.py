from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.database import init_db
from app.mongo import init_mongo, close_mongo
from app.routes.auth import router as auth_router
from app.routes.projects import router as projects_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    await init_mongo()
    yield
    await close_mongo()


app = FastAPI(title="Text Dev IDE", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:5174"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_router, prefix="/api")
app.include_router(projects_router, prefix="/api")


@app.get("/api/health")
async def health():
    return {"status": "ok"}
