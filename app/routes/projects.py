import json
import uuid
from fastapi import APIRouter, Depends, Header, HTTPException
from fastapi.responses import Response
from sqlalchemy import select, delete as sa_delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.project import Project
from app.models.prompt_log import PromptLog
from app.models.schemas import (
    ProjectCreate, ProjectUpdate, ProjectResponse, ProjectListResponse,
    ExtractRequest, RefineRequest, GenerateValidationRequest, GenerateUIRequest,
    GenerateUIXmlRequest, GenerateFromXmlRequest, ScreenCreate, ScreenUpdate,
    PromptLogResponse, WorkbenchInterpretRequest, WorkbenchInterpretResponse,
    WorkbenchConfirmRequest, RefineUIRequest, SchemaAssistantRequest, SchemaAssistantResponse,
    PreviewRowsRequest,
)
from app.services.auth_service import get_current_user
from app.services.ai_service import (
    extract_entities, refine_entities, generate_sql,
    generate_entity_code, edit_validation_code, generate_ui_code,
    generate_ui_xml, generate_html_from_xml, generate_api_from_xml,
    generate_er_diagram, detect_screen_intents, interpret_requirement,
    refine_ui_xml, schema_assistant_edit_table,
)
from app.services.github_service import create_repo, push_files, build_push_files, build_commit_message
from app.services import preview_db_service

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


async def _log_prompt(db: AsyncSession, user_id: int, project_id: int, kind: str, prompt: str, response: str):
    db.add(PromptLog(user_id=user_id, project_id=project_id, kind=kind, prompt=prompt, response=response))
    await db.commit()


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
        frontend_language=body.frontend_language,
        user_id=user.id,
    )
    db.add(project)
    await db.commit()
    await db.refresh(project)

    if user.github_token:
        try:
            backend_repo = await create_repo(user.github_token, f"{body.name}-backend", body.description or "")
            project.github_repo = backend_repo["full_name"]
            project.github_repo_url = backend_repo["html_url"]
            frontend_repo = await create_repo(user.github_token, f"{body.name}-frontend", body.description or "")
            project.github_frontend_repo = frontend_repo["full_name"]
            project.github_frontend_repo_url = frontend_repo["html_url"]
            await db.commit()
            await db.refresh(project)
        except Exception:
            pass  # GitHub failure must not block project creation

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
    await db.execute(sa_delete(PromptLog).where(PromptLog.project_id == project_id))
    await db.delete(project)
    await db.commit()


@router.post("/{project_id}/extract", response_model=ProjectResponse)
async def extract_project_entities(project_id: int, body: ExtractRequest, user=Depends(_get_user), db: AsyncSession = Depends(get_db)):
    project = await _get_project(project_id, user, db)
    try:
        result = await extract_entities(body.description, body.features)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"AI extraction failed: {e}")
    unresolved = result.pop("unresolved", []) if isinstance(result, dict) else []
    entities = {"tables": result.get("tables", [])} if isinstance(result, dict) else result
    await _log_prompt(db, user.id, project.id, "extract_entities",
                       f"Description: {body.description}\n\nFeatures: {body.features}", json.dumps(entities))

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
    resp = ProjectResponse.model_validate(project)
    resp.unresolved = unresolved
    return resp


@router.post("/{project_id}/refine", response_model=ProjectResponse)
async def refine_project_entities(project_id: int, body: RefineRequest, user=Depends(_get_user), db: AsyncSession = Depends(get_db)):
    project = await _get_project(project_id, user, db)
    try:
        result = await refine_entities(body.entities, body.instruction)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"AI refinement failed: {e}")
    unresolved = result.pop("unresolved", []) if isinstance(result, dict) else []
    entities = {"tables": result.get("tables", [])} if isinstance(result, dict) else result
    await _log_prompt(db, user.id, project.id, "refine_entities", body.instruction, json.dumps(entities))

    project.entities = json.dumps(entities)
    project.status = "draft"
    await db.commit()
    await db.refresh(project)
    resp = ProjectResponse.model_validate(project)
    resp.unresolved = unresolved
    return resp


def _schema_suggestions(table: dict, other_tables: list) -> list[str]:
    """Cheap, deterministic follow-up suggestions for the Schema Assistant chips —
    no AI call needed, just heuristics over the table's current shape."""
    cols = table.get("columns", [])
    suggestions = []
    for c in cols:
        name = c.get("name", "")
        if ("code" in name or name.endswith("_no") or name.endswith("_number")) and not c.get("unique"):
            suggestions.append(f"Make {name} unique")
            break
    for c in cols:
        if c.get("type", "").upper().startswith("BOOL") and c.get("default") in (None, ""):
            suggestions.append(f"Add a default for {c['name']}")
            break
    if not table.get("audit_enabled"):
        suggestions.append("Turn on auditing")
    elif not table.get("history_enabled"):
        suggestions.append("Keep a full change history")
    if other_tables and not any(c.get("fk") for c in cols):
        suggestions.append(f"Add a foreign key to {other_tables[0]['name']}")
    if not suggestions:
        suggestions = ["Add a new column", "Add a validation rule", "Rename a column"]
    return suggestions[:3]


@router.post("/{project_id}/schema-assistant/{table_name}", response_model=SchemaAssistantResponse)
async def schema_assistant(project_id: int, table_name: str, body: SchemaAssistantRequest, user=Depends(_get_user), db: AsyncSession = Depends(get_db)):
    project = await _get_project(project_id, user, db)
    if not project.entities:
        raise HTTPException(status_code=400, detail="No schema yet — extract entities first")
    entities = json.loads(project.entities)
    tables = entities.get("tables", [])
    idx = next((i for i, t in enumerate(tables) if t.get("name") == table_name), None)
    if idx is None:
        raise HTTPException(status_code=404, detail="Table not found")
    table = tables[idx]
    other_tables = [t for t in tables if t.get("name") != table_name]
    try:
        result = await schema_assistant_edit_table(table, other_tables, body.instruction)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Schema assistant failed: {e}")

    updated_table = result.get("table") or table
    tables[idx] = updated_table
    entities["tables"] = tables
    project.entities = json.dumps(entities)
    await db.commit()
    await db.refresh(project)
    await _log_prompt(db, user.id, project.id, "schema_assistant", f"[{table_name}] {body.instruction}", result.get("summary", ""))

    return SchemaAssistantResponse(
        table=updated_table,
        summary=result.get("summary") or "Done — check the Schema tab.",
        suggestions=_schema_suggestions(updated_table, other_tables),
        entities=project.entities,
        unresolved=result.get("unresolved") or [],
    )


@router.post("/{project_id}/workbench/interpret", response_model=WorkbenchInterpretResponse)
async def workbench_interpret(project_id: int, body: WorkbenchInterpretRequest, user=Depends(_get_user), db: AsyncSession = Depends(get_db)):
    project = await _get_project(project_id, user, db)

    # A follow-up refinement call passes back the current (unsaved) draft so nothing
    # is persisted until the user confirms; the first call in a session falls back
    # to whatever is already saved on the project.
    if body.current_entities is not None or body.current_screens is not None or body.current_validation_rules is not None:
        entities = body.current_entities
        screens = body.current_screens
        validation_rules = body.current_validation_rules
    else:
        entities = json.loads(project.entities) if project.entities else None
        screens = _get_screens(project)
        validation_rules = project.validation_rules

    try:
        result = await interpret_requirement(body.requirement, entities, screens, validation_rules)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Requirement interpretation failed: {e}")

    await _log_prompt(db, user.id, project.id, "workbench_interpret", body.requirement, json.dumps(result))
    return WorkbenchInterpretResponse(**result)


@router.post("/{project_id}/workbench/confirm", response_model=ProjectResponse)
async def workbench_confirm(project_id: int, body: WorkbenchConfirmRequest, user=Depends(_get_user), db: AsyncSession = Depends(get_db)):
    project = await _get_project(project_id, user, db)
    entities = body.entities

    project.entities = json.dumps(entities)
    project.status = "draft"

    try:
        entity_code = await generate_entity_code(entities, project.language or "Python")
    except Exception:
        entity_code = None

    validation_code = entity_code
    if body.validation_rules and body.validation_rules.strip():
        try:
            validation_code = await edit_validation_code(
                instruction=body.validation_rules,
                existing_code=entity_code or "",
                entities=entities,
                language=project.language or "Python",
            )
            await _log_prompt(db, user.id, project.id, "workbench_validation_code", body.validation_rules, validation_code)
        except Exception:
            pass  # fall back to the plain entity code if rule-layering fails

    project.validation_rules = body.validation_rules
    if validation_code:
        project.validation_code = validation_code

    existing_screens = _get_screens(project)
    by_name = {s.get("name", "").strip().lower(): s for s in existing_screens}
    new_screens = []
    for item in body.screens:
        name = (item.get("name") or "Screen").strip()
        desc = item.get("description") or ""
        prior = by_name.get(name.lower())
        screen_id = prior["id"] if prior else str(uuid.uuid4())[:8]

        try:
            xml = await generate_ui_xml(description=desc, entities=entities)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"XML generation failed for screen '{name}': {e}")
        await _log_prompt(db, user.id, project.id, "workbench_screen_xml", desc, xml)

        try:
            # Always plain HTML for the preview iframe — see comment on gen_screen_html
            # for why the project's real frontend framework must never land here.
            html = await generate_html_from_xml(xml=xml, frontend_lang="HTML/CSS")
        except Exception:
            html = ""
        if html:
            await _log_prompt(db, user.id, project.id, "workbench_screen_html", xml, html)

        new_screens.append({"id": screen_id, "name": name, "description": desc, "xml": xml, "html": html, "api": ""})

    _save_screens(project, new_screens)
    await _log_prompt(db, user.id, project.id, "workbench_confirm", "confirmed",
                       json.dumps({"screen_count": len(new_screens)}))

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


@router.get("/{project_id}/prompt-logs", response_model=list[PromptLogResponse])
async def list_prompt_logs(project_id: int, user=Depends(_get_user), db: AsyncSession = Depends(get_db)):
    await _get_project(project_id, user, db)
    result = await db.execute(
        select(PromptLog).where(PromptLog.project_id == project_id, PromptLog.user_id == user.id)
        .order_by(PromptLog.created_at.desc())
    )
    return [PromptLogResponse.model_validate(p) for p in result.scalars().all()]


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
        # Always plain HTML for the preview iframe — see comment on gen_screen_html.
        html = await generate_html_from_xml(xml=body.xml, frontend_lang="HTML/CSS")
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


@router.post("/{project_id}/screens/detect-intents")
async def detect_screens(project_id: int, body: GenerateUIXmlRequest, user=Depends(_get_user), db: AsyncSession = Depends(get_db)):
    await _get_project(project_id, user, db)
    try:
        return await detect_screen_intents(body.description)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Screen intent detection failed: {e}")


@router.post("/{project_id}/screens", response_model=ProjectResponse)
async def create_screen(project_id: int, body: ScreenCreate, user=Depends(_get_user), db: AsyncSession = Depends(get_db)):
    project = await _get_project(project_id, user, db)
    screens = _get_screens(project)
    primary_entities = body.primary_entities if body.primary_entities is not None else ([body.primary_entity] if body.primary_entity else [])
    screens.append({
        "id": str(uuid.uuid4())[:8], "name": body.name, "description": body.description, "xml": "", "html": "", "api": "",
        "primary_entities": primary_entities, "joined_entities": body.joined_entities or [],
    })
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
    if body.primary_entities is not None:
        screen["primary_entities"] = body.primary_entities
    elif body.primary_entity is not None:
        screen["primary_entities"] = [body.primary_entity] if body.primary_entity else []
    if body.joined_entities is not None:
        screen["joined_entities"] = body.joined_entities
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
    # Multiple primary entities selected signals a navigation/hub/landing screen (routes to
    # other screens) rather than a single-entity CRUD screen — point it at screens that are
    # actually built already, not made-up placeholders.
    is_hub = len(screen.get("primary_entities") or []) > 1
    existing_screens = None
    if is_hub:
        existing_screens = [
            {"name": s["name"], "purpose": (s.get("description") or "")[:150]}
            for s in screens
            if s.get("id") != screen_id and s.get("xml")
        ]
    screen_entities = None
    if not is_hub:
        screen_entities = (screen.get("primary_entities") or []) + (screen.get("joined_entities") or [])
    try:
        xml = await generate_ui_xml(description=body.description, entities=entities, existing_screens=existing_screens,
                                     screen_name=screen.get("name", ""), screen_entities=screen_entities)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"XML generation failed: {e}")
    await _log_prompt(db, user.id, project.id, "screen_generate_xml", body.description, xml)
    screen["description"] = body.description
    screen["xml"] = xml
    screen["html"] = ""
    screen["api"] = ""
    screen["ui_chat"] = []  # a fresh base generation invalidates chat history tied to the old XML
    screen["ui_notes"] = []
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
        # Always plain HTML/CSS/vanilla-JS here, regardless of the project's chosen
        # frontend framework (React/Vue/Angular/...). This is a preview rendered
        # directly in an iframe via srcDoc — real JSX/Vue-SFC/etc. output requires a
        # build step (or CDN Babel transpilation) that's fragile and, when the AI's
        # generated code has any syntax slip, fails mid-parse and dumps raw source
        # text onto the page instead of rendering. Plain HTML has no transpile step,
        # so browsers render it correctly even with minor imperfections. The actual
        # framework-specific deliverable code lives separately in the Frontend Code
        # tab (generate_api_from_xml's page_component file) and is unaffected by this.
        html = await generate_html_from_xml(xml=body.xml, frontend_lang="HTML/CSS", extra_instructions=screen.get("ui_notes"))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"HTML generation failed: {e}")
    await _log_prompt(db, user.id, project.id, "screen_generate_html", body.xml, html)
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
    await _log_prompt(db, user.id, project.id, "screen_generate_api", body.xml, api_code)
    screen["api"] = api_code
    screens[idx] = screen
    _save_screens(project, screens)
    await db.commit()
    await db.refresh(project)
    return ProjectResponse.model_validate(project)


@router.post("/{project_id}/screens/{screen_id}/refine-ui", response_model=ProjectResponse)
async def refine_screen_ui(project_id: int, screen_id: str, body: RefineUIRequest, user=Depends(_get_user), db: AsyncSession = Depends(get_db)):
    project = await _get_project(project_id, user, db)
    screens = _get_screens(project)
    idx, screen = _find_screen(screens, screen_id)
    if screen is None:
        raise HTTPException(status_code=404, detail="Screen not found")
    if not screen.get("xml"):
        raise HTTPException(status_code=400, detail="Generate the initial screen first")
    # Every instruction is kept as a running note, not just the ones that change XML
    # structure — requests like "remove the button's background color" have no XML
    # attribute to attach to, so without replaying the full list on every regeneration
    # they'd be silently lost (or reverted) the next time HTML regenerates from XML.
    notes = (screen.get("ui_notes") or []) + [body.instruction]
    try:
        refine_result = await refine_ui_xml(xml=screen["xml"], instruction=body.instruction)
        new_xml = refine_result.get("xml") or screen["xml"]
        summary = refine_result.get("summary") or "Applied your change — check the preview."
        new_html = await generate_html_from_xml(xml=new_xml, frontend_lang="HTML/CSS", extra_instructions=notes)  # see gen_screen_html
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"UI refinement failed: {e}")
    await _log_prompt(db, user.id, project.id, "screen_refine_ui", body.instruction, new_xml)

    screen["xml"] = new_xml
    screen["html"] = new_html
    screen["ui_notes"] = notes
    # Stale API code no longer matches the updated UI — clear it rather than show
    # backend/frontend code that's silently out of sync with what the user just changed.
    screen["api"] = ""
    chat = screen.get("ui_chat") or []
    chat.append({"role": "user", "text": body.instruction})
    chat.append({"role": "assistant", "text": summary})
    screen["ui_chat"] = chat
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
        diagram = generate_er_diagram(entities)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"ER diagram generation failed: {e}")

    project.er_diagram = diagram
    await db.commit()
    await db.refresh(project)
    return ProjectResponse.model_validate(project)


@router.post("/{project_id}/push-to-github")
async def push_to_github(project_id: int, user=Depends(_get_user), db: AsyncSession = Depends(get_db)):
    if not user.github_token:
        raise HTTPException(status_code=400, detail="No GitHub token saved. Go to Settings to add your token.")
    project = await _get_project(project_id, user, db)

    if not project.github_repo:
        try:
            repo = await create_repo(user.github_token, f"{project.name}-backend", project.description or "")
            project.github_repo = repo["full_name"]
            project.github_repo_url = repo["html_url"]
            await db.commit()
            await db.refresh(project)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to create backend GitHub repo: {e}")

    if not project.github_frontend_repo:
        try:
            repo = await create_repo(user.github_token, f"{project.name}-frontend", project.description or "")
            project.github_frontend_repo = repo["full_name"]
            project.github_frontend_repo_url = repo["html_url"]
            await db.commit()
            await db.refresh(project)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to create frontend GitHub repo: {e}")

    backend_files, frontend_files, screen_names = build_push_files(project)
    if not backend_files and not frontend_files:
        raise HTTPException(status_code=400, detail="Nothing to push yet. Generate some code first.")
    commit_msg = build_commit_message(project, screen_names)
    try:
        if len(backend_files) > 1:  # more than just the README
            await push_files(user.github_token, project.github_repo, backend_files, commit_message=commit_msg)
        if len(frontend_files) > 1:
            await push_files(user.github_token, project.github_frontend_repo, frontend_files, commit_message=commit_msg)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Push failed: {e}")
    return {
        "message": f"Pushed: {commit_msg}",
        "repo_url": project.github_repo_url,
        "frontend_repo_url": project.github_frontend_repo_url,
    }


@router.post("/{project_id}/preview-db/sync-schema")
async def sync_preview_schema(project_id: int, user=Depends(_get_user), db: AsyncSession = Depends(get_db)):
    """Creates/updates real tables in this project's own Postgres schema (proj_<id>) to
    match project.entities, so the Studio's UI Preview can read/write real data instead of
    fake sampleData — see app/services/preview_db_service.py."""
    project = await _get_project(project_id, user, db)
    if not project.entities:
        raise HTTPException(status_code=400, detail="No schema yet — extract entities first")
    entities = json.loads(project.entities)
    try:
        await preview_db_service.sync_schema(db, project_id, entities)
        await db.commit()
    except Exception as e:
        await db.rollback()
        raise HTTPException(status_code=500, detail=f"Schema sync failed: {e}")
    return {"message": "Preview database schema synced.", "schema": preview_db_service.schema_name(project_id)}


@router.get("/{project_id}/preview-db/{entity}")
async def get_preview_rows(project_id: int, entity: str, user=Depends(_get_user), db: AsyncSession = Depends(get_db)):
    project = await _get_project(project_id, user, db)
    if not project.entities:
        return {"rows": []}
    entities = json.loads(project.entities)
    try:
        rows = await preview_db_service.list_rows(db, project_id, entities, entity)
    except Exception:
        await db.rollback()
        rows = []
    return {"rows": rows}


@router.put("/{project_id}/preview-db/{entity}")
async def put_preview_rows(project_id: int, entity: str, body: PreviewRowsRequest, user=Depends(_get_user), db: AsyncSession = Depends(get_db)):
    """Replaces all rows for this entity in the project's real preview schema — called
    whenever a screen's preview broadcasts a data change. Simple "replace all" rather than
    incremental insert/update/delete: good enough for a single-user testing/preview aid."""
    project = await _get_project(project_id, user, db)
    if not project.entities:
        raise HTTPException(status_code=400, detail="No schema yet")
    entities = json.loads(project.entities)
    try:
        await preview_db_service.sync_schema(db, project_id, entities)
        await preview_db_service.replace_all_rows(db, project_id, entities, entity, body.rows)
        await db.commit()
    except Exception as e:
        await db.rollback()
        raise HTTPException(status_code=500, detail=f"Preview data sync failed: {e}")
    return {"message": "ok"}
