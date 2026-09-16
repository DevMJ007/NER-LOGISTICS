from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import httpx

from ..config import Settings, get_settings


DEMO_OBSERVATION = {
    "source": "demo",
    "configured": False,
    "risk_score": 54,
    "summary": "Copernicus credentials not configured. Showing prototype satellite intelligence.",
    "items": [
        {
            "id": "DEMO-S2-L2A",
            "collection": "sentinel-2-l2a",
            "datetime": "latest available",
            "cloud_cover": 18,
        }
    ],
}


def is_configured(settings: Settings | None = None) -> bool:
    settings = settings or get_settings()
    return bool(settings.copernicus_client_id and settings.copernicus_client_secret)


def bbox_around(lat: float, lon: float, delta: float = 0.18) -> list[float]:
    return [round(lon - delta, 5), round(lat - delta, 5), round(lon + delta, 5), round(lat + delta, 5)]


def satellite_risk(items: list[dict]) -> int:
    if not items:
        return 42
    cloud_values = [
        float(item.get("properties", {}).get("eo:cloud_cover") or item.get("properties", {}).get("cloud_cover") or 0)
        for item in items
    ]
    average_cloud = sum(cloud_values) / max(1, len(cloud_values))
    freshness_bonus = min(18, len(items) * 4)
    return max(20, min(78, round(62 - average_cloud * 0.25 + freshness_bonus)))


def _fetch_satellite_sync(lat: float, lon: float, days: int) -> dict:
    settings = get_settings()
    if not is_configured(settings):
        return {**DEMO_OBSERVATION, "location": {"lat": lat, "lon": lon}}

    start = datetime.now(timezone.utc) - timedelta(days=days)
    end = datetime.now(timezone.utc)
    request_body = {
        "bbox": bbox_around(lat, lon),
        "datetime": f"{start.isoformat().replace('+00:00', 'Z')}/{end.isoformat().replace('+00:00', 'Z')}",
        "collections": ["sentinel-2-l2a", "sentinel-1-grd"],
        "limit": 8,
        "fields": {
            "include": [
                "id",
                "collection",
                "properties.datetime",
                "properties.eo:cloud_cover",
                "properties.s1:polarization",
                "assets.thumbnail",
            ]
        },
    }

    with httpx.Client(timeout=25) as client:
        token_response = client.post(
            settings.copernicus_token_url,
            data={
                "grant_type": "client_credentials",
                "client_id": settings.copernicus_client_id,
                "client_secret": settings.copernicus_client_secret,
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        token_response.raise_for_status()
        token = token_response.json()["access_token"]

        response = client.post(
            settings.copernicus_catalog_url,
            json=request_body,
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        )
        response.raise_for_status()
        payload = response.json()

    features = payload.get("features", [])
    items = []
    for feature in features:
        properties = feature.get("properties", {})
        items.append(
            {
                "id": feature.get("id"),
                "collection": feature.get("collection"),
                "datetime": properties.get("datetime"),
                "cloud_cover": properties.get("eo:cloud_cover"),
                "thumbnail": feature.get("assets", {}).get("thumbnail", {}).get("href"),
            }
        )

    return {
        "source": "sentinel-hub-catalog",
        "configured": True,
        "location": {"lat": lat, "lon": lon},
        "risk_score": satellite_risk(features),
        "summary": f"Found {len(items)} Sentinel observations in the latest {days} days.",
        "items": items,
    }


async def search_latest_observations(lat: float, lon: float, days: int = 30) -> dict:
    try:
        return await asyncio.to_thread(_fetch_satellite_sync, lat, lon, days)
    except Exception as exc:
        return {**DEMO_OBSERVATION, "location": {"lat": lat, "lon": lon}, "configured": is_configured(), "error": str(exc)}
