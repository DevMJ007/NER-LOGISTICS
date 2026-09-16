from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv


ENV_PATH = Path(__file__).resolve().parents[1] / ".env"
load_dotenv(ENV_PATH)


@dataclass(frozen=True)
class Settings:
    app_environment: str = os.getenv("APP_ENVIRONMENT", "local")
    osrm_base_url: str = os.getenv("OSRM_BASE_URL", "https://router.project-osrm.org")
    open_meteo_base_url: str = os.getenv("OPEN_METEO_BASE_URL", "https://api.open-meteo.com")
    open_meteo_flood_base_url: str = os.getenv("OPEN_METEO_FLOOD_BASE_URL", "https://flood-api.open-meteo.com")

    copernicus_client_id: str = os.getenv("COPERNICUS_CLIENT_ID", "")
    copernicus_client_secret: str = os.getenv("COPERNICUS_CLIENT_SECRET", "")
    copernicus_token_url: str = os.getenv(
        "COPERNICUS_TOKEN_URL",
        "https://services.sentinel-hub.com/auth/realms/main/protocol/openid-connect/token",
    )
    copernicus_catalog_url: str = os.getenv(
        "COPERNICUS_CATALOG_URL",
        "https://services.sentinel-hub.com/api/v1/catalog/1.0.0/search",
    )

    firebase_project_id: str = os.getenv("FIREBASE_PROJECT_ID", "")
    firebase_client_email: str = os.getenv("FIREBASE_CLIENT_EMAIL", "")
    firebase_private_key: str = os.getenv("FIREBASE_PRIVATE_KEY", "").replace("\\n", "\n")
    firebase_service_account_file: str = os.getenv("FIREBASE_SERVICE_ACCOUNT_FILE", "")


@lru_cache
def get_settings() -> Settings:
    return Settings()
