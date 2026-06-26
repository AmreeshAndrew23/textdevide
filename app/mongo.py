from motor.motor_asyncio import AsyncIOMotorClient
from app.config import MONGODB_URI, MONGODB_DB_NAME

client: AsyncIOMotorClient = None
db = None


def get_projects_collection():
    return db["projects"]


async def init_mongo():
    global client, db
    client = AsyncIOMotorClient(MONGODB_URI)
    db = client[MONGODB_DB_NAME]
    collection = get_projects_collection()
    await collection.create_index("user_id")
    await collection.create_index([("user_id", 1), ("status", 1)])


async def close_mongo():
    global client
    if client:
        client.close()
