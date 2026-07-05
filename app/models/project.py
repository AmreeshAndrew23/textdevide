from sqlalchemy import Column, Integer, String, Text, ForeignKey, DateTime
from sqlalchemy.sql import func
from app.database import Base


class Project(Base):
    __tablename__ = "projects"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    description = Column(String, nullable=True)
    features = Column(Text, nullable=True)
    language = Column(String, default="Python")
    entities = Column(Text, nullable=True)
    status = Column(String, default="draft")
    validation_rules = Column(Text, nullable=True)
    validation_code = Column(Text, nullable=True)
    ui_description = Column(Text, nullable=True)
    ui_code = Column(Text, nullable=True)
    frontend_language = Column(String, default="React")
    ui_xml = Column(Text, nullable=True)
    ui_html = Column(Text, nullable=True)
    ui_api = Column(Text, nullable=True)
    er_diagram = Column(Text, nullable=True)
    ui_screens = Column(Text, nullable=True)
    github_repo = Column(String, nullable=True)
    github_repo_url = Column(String, nullable=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
