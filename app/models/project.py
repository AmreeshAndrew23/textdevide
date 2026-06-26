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
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
