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
    created_at: datetime
    updated_at: datetime

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


class GenerateValidationRequest(BaseModel):
    rules: str


class GenerateUIRequest(BaseModel):
    description: str


class GenerateUIXmlRequest(BaseModel):
    description: str


class GenerateFromXmlRequest(BaseModel):
    xml: str
    frontend_lang: str = "HTML/CSS"


class PushToGithubRequest(BaseModel):
    commit_message: str = "Update from Text Dev IDE"


class ScreenCreate(BaseModel):
    name: str
    description: str = ""


class ScreenUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None


class PromptLogResponse(BaseModel):
    id: int
    project_id: Optional[int] = None
    kind: str
    prompt: str
    response: Optional[str] = None
    created_at: datetime

    class Config:
        from_attributes = True
