import certifi
from motor.motor_asyncio import AsyncIOMotorClient
from app.config import MONGODB_URI, MONGODB_DB_NAME

client: AsyncIOMotorClient = None
db = None


def get_projects_collection():
    if db is None:
        raise RuntimeError("MongoDB not connected. Check your MONGODB_URI in .env")
    return db["projects"]


async def init_mongo():
    global client, db
    if not MONGODB_URI:
        print("MONGODB_URI not set, skipping MongoDB connection")
        return
    try:
        client = AsyncIOMotorClient(
            MONGODB_URI,
            tlsCAFile=certifi.where(),
            serverSelectionTimeoutMS=10000,
        )
        db = client[MONGODB_DB_NAME]
        await client.admin.command("ping")
        collection = get_projects_collection()
        await collection.create_index("user_id")
        await collection.create_index([("user_id", 1), ("status", 1)])
        print("MongoDB Atlas connected successfully")
    except Exception as e:
        print(f"MongoDB connection failed (app will still run): {e}")
        client = None
        db = None


async def close_mongo():
    global client
    if client:
        client.close()
