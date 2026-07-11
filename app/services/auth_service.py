import httpx
from datetime import datetime, timedelta, timezone
from jose import JWTError, jwt
from passlib.context import CryptContext
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from fastapi import HTTPException, status

from app.config import SECRET_KEY, ALGORITHM, ACCESS_TOKEN_EXPIRE_MINUTES, GOOGLE_CLIENT_ID, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET
from app.models.user import User

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)


def create_access_token(data: dict) -> str:
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)


def decode_access_token(token: str) -> dict:
    try:
        return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except JWTError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")


async def register_user(db: AsyncSession, email: str, password: str, full_name: str | None = None) -> User:
    result = await db.execute(select(User).where(User.email == email))
    if result.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="Email already registered")

    user = User(
        email=email,
        hashed_password=hash_password(password),
        full_name=full_name,
        auth_provider="email",
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user


async def authenticate_user(db: AsyncSession, email: str, password: str) -> User:
    result = await db.execute(select(User).where(User.email == email))
    user = result.scalar_one_or_none()
    if not user or not user.hashed_password or not verify_password(password, user.hashed_password):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    return user


async def _get_google_public_keys() -> dict:
    async with httpx.AsyncClient() as client:
        resp = await client.get("https://www.googleapis.com/oauth2/v3/certs")
        resp.raise_for_status()
        return resp.json()


async def _exchange_github_code(code: str, redirect_uri: str | None = None) -> str:
    if not GITHUB_CLIENT_ID or not GITHUB_CLIENT_SECRET:
        raise HTTPException(status_code=500, detail="GitHub OAuth is not configured")

    payload = {
        "client_id": GITHUB_CLIENT_ID,
        "client_secret": GITHUB_CLIENT_SECRET,
        "code": code,
    }
    if redirect_uri:
        payload["redirect_uri"] = redirect_uri

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            "https://github.com/login/oauth/access_token",
            headers={"Accept": "application/json"},
            data=payload,
            timeout=20,
        )
        resp.raise_for_status()
        data = resp.json()

    token = data.get("access_token")
    if not token:
        raise HTTPException(status_code=401, detail="Invalid GitHub code or token exchange failed")
    return token


async def github_login(db: AsyncSession, code: str, redirect_uri: str | None = None) -> User:
    token = await _exchange_github_code(code, redirect_uri)

    async with httpx.AsyncClient() as client:
        user_resp = await client.get(
            "https://api.github.com/user",
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github+json",
            },
            timeout=20,
        )
        user_resp.raise_for_status()
        github_user = user_resp.json()

        email = github_user.get("email")
        if not email:
            emails_resp = await client.get(
                "https://api.github.com/user/emails",
                headers={
                    "Authorization": f"Bearer {token}",
                    "Accept": "application/vnd.github+json",
                },
                timeout=20,
            )
            emails_resp.raise_for_status()
            emails = emails_resp.json()
            email = next(
                (item.get("email") for item in emails if item.get("primary") and item.get("verified")),
                None,
            ) or next((item.get("email") for item in emails if item.get("verified")), None)

        if not email:
            raise HTTPException(status_code=400, detail="GitHub account email is unavailable")

        result = await db.execute(select(User).where(User.email == email))
        user = result.scalar_one_or_none()

        if not user:
            user = User(
                email=email,
                full_name=github_user.get("name") or github_user.get("login"),
                picture=github_user.get("avatar_url"),
                auth_provider="github",
                github_token=token,
            )
            db.add(user)
            await db.commit()
            await db.refresh(user)
            return user

        user.github_token = token
        if not user.auth_provider or user.auth_provider == "email":
            user.auth_provider = "github"
        await db.commit()
        await db.refresh(user)
        return user


async def google_login(db: AsyncSession, credential: str) -> User:
    try:
        jwks = await _get_google_public_keys()
        header = jwt.get_unverified_header(credential)
        kid = header.get("kid")
        key = next((k for k in jwks["keys"] if k["kid"] == kid), None)
        if not key:
            raise ValueError("Google signing key not found")
        idinfo = jwt.decode(
            credential,
            key,
            algorithms=["RS256"],
            audience=GOOGLE_CLIENT_ID,
            issuer=["https://accounts.google.com", "accounts.google.com"],
        )
    except Exception as e:
        raise HTTPException(status_code=401, detail=f"Invalid Google token: {e}")

    email = idinfo["email"]
    result = await db.execute(select(User).where(User.email == email))
    user = result.scalar_one_or_none()

    if not user:
        user = User(
            email=email,
            full_name=idinfo.get("name"),
            picture=idinfo.get("picture"),
            auth_provider="google",
        )
        db.add(user)
        await db.commit()
        await db.refresh(user)

    return user


async def get_current_user(db: AsyncSession, token: str) -> User:
    payload = decode_access_token(token)
    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid token")
    result = await db.execute(select(User).where(User.id == int(user_id)))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return user
