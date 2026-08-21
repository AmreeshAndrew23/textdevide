from collections import defaultdict
from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.prompt_log import PromptLog
from app.models.project import Project
from app.models.user import User
from app.services.auth_service import get_current_user

router = APIRouter(prefix="/admin", tags=["admin"])


async def _require_superuser(authorization: str = Header(...), db: AsyncSession = Depends(get_db)) -> User:
    token = authorization.replace("Bearer ", "")
    user = await get_current_user(db, token)
    if not user.is_superuser:
        raise HTTPException(status_code=403, detail="Superuser access required")
    return user


# $ per 1,000,000 tokens — OpenAI's published rates for the models this app actually calls.
# Update this if pricing changes; it's the only place cost figures come from. Priced at read
# time from the stored `model` name (never a snapshotted price), so historical rows stay
# accurate even if these constants change later. An unrecognized/null model (rows logged
# before this feature shipped) falls back to the gpt-4o-mini rate, this app's default model,
# rather than silently pricing at $0.
PRICING = {
    "gpt-4o-mini": {"input": 0.15, "output": 0.60},
    "gpt-4o": {"input": 2.50, "output": 10.00},
}
_DEFAULT_PRICING = PRICING["gpt-4o-mini"]

# Every PromptLog.kind bucketed into what the user actually asked to see broken out:
# schema generation vs UI generation vs everything else (workbench chat/confirm).
_SCHEMA_KINDS = {"extract_entities", "refine_entities", "schema_assistant"}
_UI_KINDS = {
    "screen_generate_xml", "screen_generate_html", "screen_generate_html_variants",
    "screen_generate_api", "screen_refine_ui", "workbench_screen_xml", "workbench_screen_html",
}


def _bucket(kind: str) -> str:
    if kind in _SCHEMA_KINDS:
        return "schema"
    if kind in _UI_KINDS:
        return "ui"
    return "other"


def _cost(model: str | None, prompt_tokens: int, completion_tokens: int) -> float:
    rates = PRICING.get(model, _DEFAULT_PRICING)
    return (prompt_tokens / 1_000_000) * rates["input"] + (completion_tokens / 1_000_000) * rates["output"]


class BucketUsage(BaseModel):
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    cost_usd: float = 0.0
    call_count: int = 0


class ProjectUsage(BaseModel):
    project_id: int
    project_name: str
    schema_usage: BucketUsage = BucketUsage()
    ui_usage: BucketUsage = BucketUsage()
    other_usage: BucketUsage = BucketUsage()
    total_tokens: int = 0
    total_cost_usd: float = 0.0


class UserUsage(BaseModel):
    user_id: int
    email: str
    full_name: str | None = None
    total_tokens: int = 0
    total_cost_usd: float = 0.0
    projects: list[ProjectUsage] = []


class TokenUsageResponse(BaseModel):
    users: list[UserUsage]
    grand_total_tokens: int = 0
    grand_total_cost_usd: float = 0.0


@router.get("/token-usage", response_model=TokenUsageResponse)
async def get_token_usage(user: User = Depends(_require_superuser), db: AsyncSession = Depends(get_db)):
    """Every AI call ever logged (PromptLog), summed per (user, project, kind, model), then
    bucketed into schema/ui/other and priced from PRICING above — this is the raw data behind
    "how much did generating this project actually cost", for every user, so usage can be
    billed. Rows logged before token tracking shipped have null token columns and simply don't
    contribute (COALESCE to 0 below), rather than skewing totals or crashing the aggregation."""
    stmt = (
        select(
            User.id, User.email, User.full_name,
            Project.id, Project.name,
            PromptLog.kind, PromptLog.model,
            func.coalesce(func.sum(PromptLog.prompt_tokens), 0).label("prompt_tokens"),
            func.coalesce(func.sum(PromptLog.completion_tokens), 0).label("completion_tokens"),
            func.coalesce(func.sum(PromptLog.total_tokens), 0).label("total_tokens"),
            func.count(PromptLog.id).label("call_count"),
        )
        .join(Project, Project.id == PromptLog.project_id)
        .join(User, User.id == PromptLog.user_id)
        .group_by(User.id, User.email, User.full_name, Project.id, Project.name, PromptLog.kind, PromptLog.model)
    )
    rows = (await db.execute(stmt)).all()

    # user_id -> {"email", "full_name", "projects": {project_id -> {"name", "buckets": {bucket -> BucketUsage-ish dict}}}}
    users: dict[int, dict] = {}
    for (user_id, email, full_name, project_id, project_name, kind, model,
         prompt_tokens, completion_tokens, total_tokens, call_count) in rows:
        u = users.setdefault(user_id, {"email": email, "full_name": full_name, "projects": {}})
        p = u["projects"].setdefault(project_id, {"name": project_name, "buckets": defaultdict(lambda: {
            "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0, "cost_usd": 0.0, "call_count": 0,
        })})
        b = p["buckets"][_bucket(kind)]
        b["prompt_tokens"] += prompt_tokens
        b["completion_tokens"] += completion_tokens
        b["total_tokens"] += total_tokens
        b["call_count"] += call_count
        b["cost_usd"] += _cost(model, prompt_tokens, completion_tokens)

    result_users = []
    grand_total_tokens = 0
    grand_total_cost = 0.0
    for user_id, u in users.items():
        projects = []
        user_total_tokens = 0
        user_total_cost = 0.0
        for project_id, p in u["projects"].items():
            schema_b = BucketUsage(**p["buckets"]["schema"]) if "schema" in p["buckets"] else BucketUsage()
            ui_b = BucketUsage(**p["buckets"]["ui"]) if "ui" in p["buckets"] else BucketUsage()
            other_b = BucketUsage(**p["buckets"]["other"]) if "other" in p["buckets"] else BucketUsage()
            proj_tokens = schema_b.total_tokens + ui_b.total_tokens + other_b.total_tokens
            proj_cost = schema_b.cost_usd + ui_b.cost_usd + other_b.cost_usd
            projects.append(ProjectUsage(
                project_id=project_id, project_name=p["name"],
                schema_usage=schema_b, ui_usage=ui_b, other_usage=other_b,
                total_tokens=proj_tokens, total_cost_usd=round(proj_cost, 4),
            ))
            user_total_tokens += proj_tokens
            user_total_cost += proj_cost
        projects.sort(key=lambda p: p.total_tokens, reverse=True)
        result_users.append(UserUsage(
            user_id=user_id, email=u["email"], full_name=u["full_name"],
            total_tokens=user_total_tokens, total_cost_usd=round(user_total_cost, 4),
            projects=projects,
        ))
        grand_total_tokens += user_total_tokens
        grand_total_cost += user_total_cost

    result_users.sort(key=lambda u: u.total_tokens, reverse=True)
    return TokenUsageResponse(
        users=result_users,
        grand_total_tokens=grand_total_tokens,
        grand_total_cost_usd=round(grand_total_cost, 4),
    )
