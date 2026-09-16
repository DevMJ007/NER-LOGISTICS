from __future__ import annotations

import asyncio

import httpx

from ..config import get_settings


DEMO_FLOOD = {
    "source": "demo",
    "location": {"lat": 23.727, "lon": 92.717},
    "river_discharge": 412,
    "risk_score": 71,
    "risk_level": "HIGH",
    "daily": [],
}


def classify_flood(discharge: float, values: list[float]) -> tuple[int, str]:
    if not values:
        return 50, "MODERATE"
    peak = max(values)
    if peak <= 0:
        return 10, "LOW"
    score = min(100, round((discharge / peak) * 100))
    if score >= 80:
        return score, "CRITICAL"
    if score >= 65:
        return score, "HIGH"
    if score >= 45:
        return score, "ELEVATED"
    if score >= 25:
        return score, "MODERATE"
    return score, "LOW"


def _fetch_flood_sync(lat: float, lon: float) -> dict:
    settings = get_settings()
    params = {
        "latitude": lat,
        "longitude": lon,
        "daily": "river_discharge",
        "forecast_days": 7,
    }

    with httpx.Client(timeout=15) as client:
        response = client.get(f"{settings.open_meteo_flood_base_url}/v1/flood", params=params)
        response.raise_for_status()
        payload = response.json()

    daily = payload.get("daily", {})
    values = [float(value or 0) for value in daily.get("river_discharge", [])]
    discharge = values[0] if values else 0
    score, level = classify_flood(discharge, values)

    return {
        "source": "open-meteo-flood",
        "location": {"lat": lat, "lon": lon},
        "river_discharge": round(discharge, 2),
        "risk_score": score,
        "risk_level": level,
        "daily": [
            {"date": date_value, "river_discharge": values[index]}
            for index, date_value in enumerate(daily.get("time", [])[:7])
        ],
    }


async def get_flood(lat: float, lon: float) -> dict:
    try:
        return await asyncio.to_thread(_fetch_flood_sync, lat, lon)
    except Exception as exc:
        return {**DEMO_FLOOD, "location": {"lat": lat, "lon": lon}, "error": str(exc)}
