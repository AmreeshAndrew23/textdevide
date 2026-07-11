from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy.orm import DeclarativeBase
from app.config import DATABASE_URL

engine = create_async_engine(DATABASE_URL, echo=True)
async_session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


async def get_db():
    async with async_session() as session:
        yield session


def _add_missing_columns(conn):
    """Add columns that exist on the models but not yet in the live tables.

    SQLAlchemy's create_all only creates missing *tables*, never alters an
    existing one. Since this project has no migration tool, we bridge schema
    drift here by ALTER-ing in any newly added (nullable) columns on startup.
    """
    from sqlalchemy import inspect as sa_inspect

    inspector = sa_inspect(conn)
    existing_tables = set(inspector.get_table_names())
    for table in Base.metadata.sorted_tables:
        if table.name not in existing_tables:
            continue
        live_columns = {c["name"] for c in inspector.get_columns(table.name)}
        for column in table.columns:
            if column.name in live_columns:
                continue
            col_type = column.type.compile(dialect=conn.dialect)
            conn.exec_driver_sql(
                f'ALTER TABLE "{table.name}" ADD COLUMN "{column.name}" {col_type}'
            )


async def init_db():
    from app.models.user import User  # noqa: F401
    from app.models.project import Project  # noqa: F401
    from app.models.prompt_log import PromptLog  # noqa: F401
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await conn.run_sync(_add_missing_columns)
