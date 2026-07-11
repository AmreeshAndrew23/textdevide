from sqlalchemy import Column, Integer, String, Boolean, DateTime
from sqlalchemy.sql import func
from app.database import Base


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    email = Column(String, unique=True, index=True, nullable=False)
    hashed_password = Column(String, nullable=True)
    full_name = Column(String, nullable=True)
    picture = Column(String, nullable=True)
    auth_provider = Column(String, default="email")
    is_active = Column(Boolean, default=True)
    github_token = Column(String, nullable=True)
    # User configuration
    date_format = Column(String, nullable=True, default="YYYY-MM-DD")
    language = Column(String, nullable=True, default="en")
    created_at = Column(DateTime(timezone=True), server_default=func.now())
