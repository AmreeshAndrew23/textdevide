from fastapi import APIRouter, Depends, Header
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.schemas import UserRegister, UserLogin, GoogleTokenRequest, GithubCodeRequest, TokenResponse, UserResponse, UserUpdate, ConfigOptionsResponse
from app.services.auth_service import (
    register_user,
    authenticate_user,
    google_login,
    github_login,
    create_access_token,
    get_current_user,
)

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/register", response_model=TokenResponse)
async def register(body: UserRegister, db: AsyncSession = Depends(get_db)):
    user = await register_user(db, body.email, body.password, body.full_name)
    token = create_access_token({"sub": str(user.id)})
    return TokenResponse(access_token=token, user=UserResponse.model_validate(user))


@router.post("/login", response_model=TokenResponse)
async def login(body: UserLogin, db: AsyncSession = Depends(get_db)):
    user = await authenticate_user(db, body.email, body.password)
    token = create_access_token({"sub": str(user.id)})
    return TokenResponse(access_token=token, user=UserResponse.model_validate(user))


@router.post("/google", response_model=TokenResponse)
async def login_google(body: GoogleTokenRequest, db: AsyncSession = Depends(get_db)):
    user = await google_login(db, body.credential)
    token = create_access_token({"sub": str(user.id)})
    return TokenResponse(access_token=token, user=UserResponse.model_validate(user))


@router.post("/github", response_model=TokenResponse)
async def login_github(body: GithubCodeRequest, db: AsyncSession = Depends(get_db)):
    user = await github_login(db, body.code, body.redirect_uri)
    token = create_access_token({"sub": str(user.id)})
    return TokenResponse(access_token=token, user=UserResponse.model_validate(user))


@router.get("/me", response_model=UserResponse)
async def me(authorization: str = Header(...), db: AsyncSession = Depends(get_db)):
    token = authorization.replace("Bearer ", "")
    user = await get_current_user(db, token)
    return UserResponse.model_validate(user)


@router.put("/me", response_model=UserResponse)
async def update_me(body: UserUpdate, authorization: str = Header(...), db: AsyncSession = Depends(get_db)):
    token = authorization.replace("Bearer ", "")
    user = await get_current_user(db, token)
    if body.full_name is not None:
        user.full_name = body.full_name
    if body.github_token is not None:
        user.github_token = body.github_token
    if body.date_format is not None:
        user.date_format = body.date_format
    if body.language is not None:
        user.language = body.language
    await db.commit()
    await db.refresh(user)
    return UserResponse.model_validate(user)


# Allowed values for the Configuration screen dropdowns
DATE_FORMATS = [
    "YYYY-MM-DD",
    "DD/MM/YYYY",
    "MM/DD/YYYY",
    "DD-MMM-YYYY",
    "DD.MM.YYYY",
]

LANGUAGES = [
    {"code": "en", "label": "English"},
    {"code": "es", "label": "Spanish"},
    {"code": "fr", "label": "French"},
    {"code": "de", "label": "German"},
    {"code": "hi", "label": "Hindi"},
    {"code": "ta", "label": "Tamil"},
]


@router.get("/config/options", response_model=ConfigOptionsResponse)
async def config_options():
    """Dropdown options for the Configuration screen (date format + language)."""
    return ConfigOptionsResponse(date_formats=DATE_FORMATS, languages=LANGUAGES)
