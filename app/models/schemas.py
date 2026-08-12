from datetime import datetime
from pydantic import BaseModel, EmailStr, field_validator
from typing import Optional


class UserRegister(BaseModel):
    email: EmailStr
    password: str
    full_name: Optional[str] = None


class UserLogin(BaseModel):
    email: EmailStr
    password: str


class GoogleTokenRequest(BaseModel):
    credential: str


class GithubCodeRequest(BaseModel):
    code: str
    redirect_uri: Optional[str] = None


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: "UserResponse"


class UserResponse(BaseModel):
    id: int
    email: str
    full_name: Optional[str] = None
    picture: Optional[str] = None
    auth_provider: str
    github_token: Optional[str] = None
    date_format: str = "YYYY-MM-DD"
    language: str = "en"

    @field_validator("date_format", mode="before")
    @classmethod
    def _default_date_format(cls, v):
        return v or "YYYY-MM-DD"

    @field_validator("language", mode="before")
    @classmethod
    def _default_language(cls, v):
        return v or "en"

    class Config:
        from_attributes = True


class UserUpdate(BaseModel):
    full_name: Optional[str] = None
    github_token: Optional[str] = None
    date_format: Optional[str] = None
    language: Optional[str] = None


class ConfigOptionsResponse(BaseModel):
    date_formats: list[str]
    languages: list[dict]


class ProjectCreate(BaseModel):
    name: str
    description: Optional[str] = None
    features: Optional[str] = None
    language: str = "Python"
    frontend_language: str = "React"


class ProjectUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    features: Optional[str] = None
    entities: Optional[str] = None
    status: Optional[str] = None
    language: Optional[str] = None
    validation_rules: Optional[str] = None
    validation_code: Optional[str] = None
    ui_description: Optional[str] = None
    ui_code: Optional[str] = None
    ui_xml: Optional[str] = None
    ui_html: Optional[str] = None
    ui_api: Optional[str] = None
    frontend_language: Optional[str] = None
    er_diagram: Optional[str] = None
    ui_screens: Optional[str] = None


class ProjectResponse(BaseModel):
    id: int
    name: str
    description: Optional[str] = None
    features: Optional[str] = None
    entities: Optional[str] = None
    language: str = "Python"
    frontend_language: str = "React"
    status: str = "draft"
    validation_rules: Optional[str] = None
    validation_code: Optional[str] = None
    ui_description: Optional[str] = None
    ui_code: Optional[str] = None
    ui_xml: Optional[str] = None
    ui_html: Optional[str] = None
    ui_api: Optional[str] = None
    er_diagram: Optional[str] = None
    ui_screens: Optional[str] = None
    github_repo: Optional[str] = None
    github_repo_url: Optional[str] = None
    github_frontend_repo: Optional[str] = None
    github_frontend_repo_url: Optional[str] = None
    created_at: datetime
    updated_at: datetime
    # Transient — only populated in the response right after an extract/refine call that hit
    # genuine ambiguity; never persisted, so it's absent (empty) on every other fetch of the project.
    unresolved: list = []

    class Config:
        from_attributes = True


class ProjectListResponse(BaseModel):
    id: int
    name: str
    description: Optional[str] = None
    status: str = "draft"
    language: str = "Python"
    entities: Optional[str] = None
    github_repo_url: Optional[str] = None
    updated_at: datetime

    class Config:
        from_attributes = True


class ExtractRequest(BaseModel):
    description: str
    features: str


class RefineRequest(BaseModel):
    entities: str
    instruction: str


class SchemaAssistantRequest(BaseModel):
    instruction: str


class PreviewRowsRequest(BaseModel):
    rows: list[dict]


class SchemaAssistantResponse(BaseModel):
    table: dict
    summary: str
    suggestions: list[str]
    entities: str  # the project's full updated entities JSON, so the client can refresh in one round trip
    unresolved: list = []


class GenerateValidationRequest(BaseModel):
    rules: str


class GenerateUIRequest(BaseModel):
    description: str


class GenerateUIXmlRequest(BaseModel):
    description: str


class GenerateFromXmlRequest(BaseModel):
    xml: str
    frontend_lang: str = "HTML/CSS"


class RefineUIRequest(BaseModel):
    instruction: str


class PushToGithubRequest(BaseModel):
    commit_message: str = "Update from Text Dev IDE"


class ScreenCreate(BaseModel):
    name: str
    description: str = ""
    primary_entity: Optional[str] = None  # deprecated, use primary_entities
    primary_entities: Optional[list[str]] = None
    joined_entities: Optional[list[str]] = None


class ScreenUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    primary_entity: Optional[str] = None  # deprecated, use primary_entities
    primary_entities: Optional[list[str]] = None
    joined_entities: Optional[list[str]] = None


class PromptLogResponse(BaseModel):
    id: int
    project_id: Optional[int] = None
    kind: str
    prompt: str
    response: Optional[str] = None
    created_at: datetime

    class Config:
        from_attributes = True


class WorkbenchInterpretRequest(BaseModel):
    requirement: str
    current_entities: Optional[dict] = None
    current_screens: Optional[list] = None
    current_validation_rules: Optional[str] = None


class WorkbenchInterpretResponse(BaseModel):
    summary: str
    summary_detail: str
    changes: dict
    entities: dict
    screens: list
    validation_rules: str
    suggestions: list[str]


class WorkbenchConfirmRequest(BaseModel):
    entities: dict
    screens: list
    validation_rules: str

    class Config:
        from_attributes = True


class GenerateFromTemplateRequest(BaseModel):
    template: str


class GenerateFromTemplateResponse(BaseModel):
    xml: str
    html: str
