from fastapi import APIRouter, Depends, Header, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.schemas import GenerateFromTemplateRequest, GenerateFromTemplateResponse
from app.services.auth_service import get_current_user
from app.services.ai_service import generate_ui_xml, generate_html_from_xml

router = APIRouter(prefix="/generate", tags=["generate"])


async def _get_user(authorization: str = Header(...), db: AsyncSession = Depends(get_db)):
    token = authorization.replace("Bearer ", "")
    return await get_current_user(db, token)


@router.post("/from-template", response_model=GenerateFromTemplateResponse)
async def generate_from_template(
    body: GenerateFromTemplateRequest,
    user=Depends(_get_user),
):
    try:
        xml = await generate_ui_xml(description=body.template, entities=None)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Screen generation failed: {e}")
    try:
        html = await generate_html_from_xml(xml=xml, frontend_lang="HTML/CSS")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Preview generation failed: {e}")
    return GenerateFromTemplateResponse(xml=xml, html=html)
