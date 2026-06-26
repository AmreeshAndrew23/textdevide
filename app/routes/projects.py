import json
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, Header, HTTPException
from fastapi.responses import Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.mongo import get_projects_collection
from app.models.project import Project
from app.models.schemas import (
    ProjectCreate, ProjectUpdate, ProjectResponse, ProjectListResponse,
    ExtractRequest, RefineRequest, GenerateValidationRequest, GenerateUIRequest,
)
from app.services.auth_service import get_current_user
from app.services.ai_service import (
    extract_entities, refine_entities, generate_sql,
    generate_validation_code, generate_ui_code,
)

router = APIRouter(prefix="/projects", tags=["projects"])


async def _get_user(authorization: str = Header(...), db: AsyncSession = Depends(get_db)):
    token = authorization.replace("Bearer ", "")
    return await get_current_user(db, token)


async def _get_project(project_id: int, user, db: AsyncSession) -> Project:
    result = await db.execute(
        select(Project).where(Project.id == project_id, Project.user_id == user.id)
    )
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


@router.get("", response_model=list[ProjectListResponse])
async def list_projects(user=Depends(_get_user), db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(Project).where(Project.user_id == user.id).order_by(Project.updated_at.desc())
    )
    return [ProjectListResponse.model_validate(p) for p in result.scalars().all()]


@router.post("", response_model=ProjectResponse, status_code=201)
async def create_project(body: ProjectCreate, user=Depends(_get_user), db: AsyncSession = Depends(get_db)):
    project = Project(
        name=body.name,
        description=body.description,
        features=body.features,
        language=body.language,
        user_id=user.id,
    )
    db.add(project)
    await db.commit()
    await db.refresh(project)
    return ProjectResponse.model_validate(project)


@router.get("/{project_id}", response_model=ProjectResponse)
async def get_project(project_id: int, user=Depends(_get_user), db: AsyncSession = Depends(get_db)):
    project = await _get_project(project_id, user, db)
    return ProjectResponse.model_validate(project)


@router.put("/{project_id}", response_model=ProjectResponse)
async def update_project(project_id: int, body: ProjectUpdate, user=Depends(_get_user), db: AsyncSession = Depends(get_db)):
    project = await _get_project(project_id, user, db)
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(project, field, value)
    await db.commit()
    await db.refresh(project)
    return ProjectResponse.model_validate(project)


@router.delete("/{project_id}", status_code=204)
async def delete_project(project_id: int, user=Depends(_get_user), db: AsyncSession = Depends(get_db)):
    project = await _get_project(project_id, user, db)
    await db.delete(project)
    await db.commit()


@router.post("/{project_id}/extract", response_model=ProjectResponse)
async def extract_project_entities(project_id: int, body: ExtractRequest, user=Depends(_get_user), db: AsyncSession = Depends(get_db)):
    project = await _get_project(project_id, user, db)
    try:
        entities = await extract_entities(body.description, body.features)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"AI extraction failed: {e}")

    project.description = body.description
    project.features = body.features
    project.entities = json.dumps(entities)
    project.status = "draft"
    await db.commit()
    await db.refresh(project)
    return ProjectResponse.model_validate(project)


@router.post("/{project_id}/refine", response_model=ProjectResponse)
async def refine_project_entities(project_id: int, body: RefineRequest, user=Depends(_get_user), db: AsyncSession = Depends(get_db)):
    project = await _get_project(project_id, user, db)
    try:
        entities = await refine_entities(body.entities, body.instruction)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"AI refinement failed: {e}")

    project.entities = json.dumps(entities)
    project.status = "draft"
    await db.commit()
    await db.refresh(project)
    return ProjectResponse.model_validate(project)


@router.post("/{project_id}/finalize", response_model=ProjectResponse)
async def finalize_project(project_id: int, user=Depends(_get_user), db: AsyncSession = Depends(get_db)):
    project = await _get_project(project_id, user, db)
    project.status = "finalized"
    await db.commit()
    await db.refresh(project)
    return ProjectResponse.model_validate(project)


@router.post("/{project_id}/unlock", response_model=ProjectResponse)
async def unlock_project(project_id: int, user=Depends(_get_user), db: AsyncSession = Depends(get_db)):
    project = await _get_project(project_id, user, db)
    project.status = "draft"
    await db.commit()
    await db.refresh(project)
    return ProjectResponse.model_validate(project)


@router.get("/{project_id}/download-sql")
async def download_sql(project_id: int, user=Depends(_get_user), db: AsyncSession = Depends(get_db)):
    project = await _get_project(project_id, user, db)
    if not project.entities:
        raise HTTPException(status_code=400, detail="No entities to export")
    entities = json.loads(project.entities)
    sql = generate_sql(entities)
    filename = f"{project.name.lower().replace(' ', '_')}_schema.sql"
    return Response(content=sql, media_type="application/sql",
                    headers={"Content-Disposition": f'attachment; filename="{filename}"'})


@router.get("/{project_id}/download-json")
async def download_json(project_id: int, user=Depends(_get_user), db: AsyncSession = Depends(get_db)):
    project = await _get_project(project_id, user, db)
    if not project.entities:
        raise HTTPException(status_code=400, detail="No entities to export")
    formatted = json.dumps(json.loads(project.entities), indent=2)
    filename = f"{project.name.lower().replace(' ', '_')}_schema.json"
    return Response(content=formatted, media_type="application/json",
                    headers={"Content-Disposition": f'attachment; filename="{filename}"'})


@router.post("/{project_id}/generate-validation", response_model=ProjectResponse)
async def gen_validation(project_id: int, body: GenerateValidationRequest, user=Depends(_get_user), db: AsyncSession = Depends(get_db)):
    project = await _get_project(project_id, user, db)
    entities = json.loads(project.entities) if project.entities else None
    try:
        code = await generate_validation_code(
            rules=body.rules, entities=entities, language=project.language or "Python",
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Validation generation failed: {e}")

    project.validation_rules = body.rules
    project.validation_code = code
    await db.commit()
    await db.refresh(project)
    return ProjectResponse.model_validate(project)


@router.post("/{project_id}/generate-ui", response_model=ProjectResponse)
async def gen_ui(project_id: int, body: GenerateUIRequest, user=Depends(_get_user), db: AsyncSession = Depends(get_db)):
    project = await _get_project(project_id, user, db)
    entities = json.loads(project.entities) if project.entities else None
    try:
        code = await generate_ui_code(
            description=body.description, entities=entities, language=project.language or "Python",
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"UI generation failed: {e}")

    project.ui_description = body.description
    project.ui_code = code
    await db.commit()
    await db.refresh(project)
    return ProjectResponse.model_validate(project)


@router.post("/{project_id}/save-to-mongo")
async def save_to_mongo(project_id: int, user=Depends(_get_user), db: AsyncSession = Depends(get_db)):
    project = await _get_project(project_id, user, db)
    collection = get_projects_collection()

    doc = {
        "pg_id": project.id,
        "user_id": user.id,
        "name": project.name,
        "description": project.description,
        "features": project.features,
        "language": project.language,
        "status": project.status,
        "entities": json.loads(project.entities) if project.entities else None,
        "validation": {
            "rules": project.validation_rules,
            "generated_code": project.validation_code,
        } if project.validation_rules else None,
        "ui": {
            "description": project.ui_description,
            "generated_code": project.ui_code,
        } if project.ui_description else None,
        "saved_at": datetime.now(timezone.utc),
    }

    await collection.update_one(
        {"pg_id": project.id, "user_id": user.id},
        {"$set": doc},
        upsert=True,
    )
    return {"message": "Project saved to MongoDB", "project_id": project.id}
