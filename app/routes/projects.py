import json
import uuid
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
    GenerateUIXmlRequest, GenerateFromXmlRequest, ScreenCreate, ScreenUpdate,
)
from app.services.auth_service import get_current_user
from app.services.ai_service import (
    extract_entities, refine_entities, generate_sql,
    generate_entity_code, edit_validation_code, generate_ui_code,
    generate_ui_xml, generate_html_from_xml, generate_api_from_xml,
    generate_er_diagram,
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

    try:
        entity_code = await generate_entity_code(entities, project.language or "Python")
    except Exception:
        entity_code = None

    project.description = body.description
    project.features = body.features
    project.entities = json.dumps(entities)
    project.status = "draft"
    if entity_code:
        project.validation_code = entity_code
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
    existing_code = project.validation_code or ""
    try:
        code = await edit_validation_code(
            instruction=body.rules,
            existing_code=existing_code,
            entities=entities,
            language=project.language or "Python",
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Validation generation failed: {e}")

    project.validation_rules = (project.validation_rules or "") + "\n" + body.rules
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


@router.post("/{project_id}/generate-ui-xml", response_model=ProjectResponse)
async def gen_ui_xml(project_id: int, body: GenerateUIXmlRequest, user=Depends(_get_user), db: AsyncSession = Depends(get_db)):
    project = await _get_project(project_id, user, db)
    entities = json.loads(project.entities) if project.entities else None
    try:
        xml = await generate_ui_xml(description=body.description, entities=entities)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"XML generation failed: {e}")

    project.ui_description = body.description
    project.ui_xml = xml
    project.ui_html = None
    project.ui_api = None
    await db.commit()
    await db.refresh(project)
    return ProjectResponse.model_validate(project)


@router.post("/{project_id}/generate-ui-html", response_model=ProjectResponse)
async def gen_ui_html(project_id: int, body: GenerateFromXmlRequest, user=Depends(_get_user), db: AsyncSession = Depends(get_db)):
    project = await _get_project(project_id, user, db)
    try:
        html = await generate_html_from_xml(xml=body.xml, frontend_lang=body.frontend_lang)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"HTML generation failed: {e}")

    project.ui_html = html
    await db.commit()
    await db.refresh(project)
    return ProjectResponse.model_validate(project)


@router.post("/{project_id}/generate-ui-api", response_model=ProjectResponse)
async def gen_ui_api(project_id: int, body: GenerateFromXmlRequest, user=Depends(_get_user), db: AsyncSession = Depends(get_db)):
    project = await _get_project(project_id, user, db)
    try:
        api_code = await generate_api_from_xml(
            xml=body.xml,
            backend_lang=project.language or "Python",
            frontend_lang=project.frontend_language or "React",
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"API generation failed: {e}")

    project.ui_api = api_code
    await db.commit()
    await db.refresh(project)
    return ProjectResponse.model_validate(project)


def _get_screens(project) -> list:
    if not project.ui_screens:
        return []
    try:
        return json.loads(project.ui_screens)
    except Exception:
        return []


def _save_screens(project, screens: list):
    project.ui_screens = json.dumps(screens)


def _find_screen(screens: list, screen_id: str):
    for i, s in enumerate(screens):
        if s.get("id") == screen_id:
            return i, s
    return -1, None


@router.post("/{project_id}/screens", response_model=ProjectResponse)
async def create_screen(project_id: int, body: ScreenCreate, user=Depends(_get_user), db: AsyncSession = Depends(get_db)):
    project = await _get_project(project_id, user, db)
    screens = _get_screens(project)
    screens.append({"id": str(uuid.uuid4())[:8], "name": body.name, "description": body.description, "xml": "", "html": "", "api": ""})
    _save_screens(project, screens)
    await db.commit()
    await db.refresh(project)
    return ProjectResponse.model_validate(project)


@router.put("/{project_id}/screens/{screen_id}", response_model=ProjectResponse)
async def update_screen(project_id: int, screen_id: str, body: ScreenUpdate, user=Depends(_get_user), db: AsyncSession = Depends(get_db)):
    project = await _get_project(project_id, user, db)
    screens = _get_screens(project)
    idx, screen = _find_screen(screens, screen_id)
    if screen is None:
        raise HTTPException(status_code=404, detail="Screen not found")
    if body.name is not None:
        screen["name"] = body.name
    if body.description is not None:
        screen["description"] = body.description
    screens[idx] = screen
    _save_screens(project, screens)
    await db.commit()
    await db.refresh(project)
    return ProjectResponse.model_validate(project)


@router.delete("/{project_id}/screens/{screen_id}", response_model=ProjectResponse)
async def delete_screen(project_id: int, screen_id: str, user=Depends(_get_user), db: AsyncSession = Depends(get_db)):
    project = await _get_project(project_id, user, db)
    screens = _get_screens(project)
    screens = [s for s in screens if s.get("id") != screen_id]
    _save_screens(project, screens)
    await db.commit()
    await db.refresh(project)
    return ProjectResponse.model_validate(project)


@router.post("/{project_id}/screens/{screen_id}/generate-xml", response_model=ProjectResponse)
async def gen_screen_xml(project_id: int, screen_id: str, body: GenerateUIXmlRequest, user=Depends(_get_user), db: AsyncSession = Depends(get_db)):
    project = await _get_project(project_id, user, db)
    screens = _get_screens(project)
    idx, screen = _find_screen(screens, screen_id)
    if screen is None:
        raise HTTPException(status_code=404, detail="Screen not found")
    entities = json.loads(project.entities) if project.entities else None
    try:
        xml = await generate_ui_xml(description=body.description, entities=entities)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"XML generation failed: {e}")
    screen["description"] = body.description
    screen["xml"] = xml
    screen["html"] = ""
    screen["api"] = ""
    screens[idx] = screen
    _save_screens(project, screens)
    await db.commit()
    await db.refresh(project)
    return ProjectResponse.model_validate(project)


@router.post("/{project_id}/screens/{screen_id}/generate-html", response_model=ProjectResponse)
async def gen_screen_html(project_id: int, screen_id: str, body: GenerateFromXmlRequest, user=Depends(_get_user), db: AsyncSession = Depends(get_db)):
    project = await _get_project(project_id, user, db)
    screens = _get_screens(project)
    idx, screen = _find_screen(screens, screen_id)
    if screen is None:
        raise HTTPException(status_code=404, detail="Screen not found")
    try:
        html = await generate_html_from_xml(xml=body.xml, frontend_lang=body.frontend_lang)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"HTML generation failed: {e}")
    screen["html"] = html
    screens[idx] = screen
    _save_screens(project, screens)
    await db.commit()
    await db.refresh(project)
    return ProjectResponse.model_validate(project)


@router.post("/{project_id}/screens/{screen_id}/generate-api", response_model=ProjectResponse)
async def gen_screen_api(project_id: int, screen_id: str, body: GenerateFromXmlRequest, user=Depends(_get_user), db: AsyncSession = Depends(get_db)):
    project = await _get_project(project_id, user, db)
    screens = _get_screens(project)
    idx, screen = _find_screen(screens, screen_id)
    if screen is None:
        raise HTTPException(status_code=404, detail="Screen not found")
    try:
        api_code = await generate_api_from_xml(xml=body.xml, backend_lang=project.language or "Python", frontend_lang=project.frontend_language or "React")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"API generation failed: {e}")
    screen["api"] = api_code
    screens[idx] = screen
    _save_screens(project, screens)
    await db.commit()
    await db.refresh(project)
    return ProjectResponse.model_validate(project)


@router.post("/{project_id}/generate-er-diagram", response_model=ProjectResponse)
async def gen_er_diagram(project_id: int, user=Depends(_get_user), db: AsyncSession = Depends(get_db)):
    project = await _get_project(project_id, user, db)
    if not project.entities:
        raise HTTPException(status_code=400, detail="Extract a database schema first")

    try:
        entities = json.loads(project.entities)
        diagram = await generate_er_diagram(entities)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"ER diagram generation failed: {e}")

    project.er_diagram = diagram
    await db.commit()
    await db.refresh(project)
    return ProjectResponse.model_validate(project)
