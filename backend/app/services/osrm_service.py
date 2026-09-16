from __future__ import annotations

import asyncio

import httpx

from ..config import get_settings
from .risk_service import classify


DEMO_ROUTES = [
    {
        "id": "A",
        "name": "Fastest hill corridor",
        "distance_km": 150,
        "duration_minutes": 240,
        "risk_score": 88,
        "final_score": 132,
        "recommended": False,
        "reason": "Fast, but affected by rainfall and active landslide report.",
        "geometry": None,
    },
    {
        "id": "B",
        "name": "Balanced district road",
        "distance_km": 165,
        "duration_minutes": 270,
        "risk_score": 42,
        "final_score": 91,
        "recommended": False,
        "reason": "Moderate rainfall and fewer recent incidents.",
        "geometry": None,
    },
    {
        "id": "C",
        "name": "Emergency-safe corridor",
        "distance_km": 180,
        "duration_minutes": 300,
        "risk_score": 20,
        "final_score": 82,
        "recommended": True,
        "reason": "Longer travel time but safer corridor exposure.",
        "geometry": None,
    },
]


def route_risk(index: int, weather: dict, flood: dict, active_reports: list[dict]) -> int:
    rainfall = float(weather.get("rainfall") or 0)
    rain_probability = float(weather.get("precipitation_probability") or 0)
    flood_score = float(flood.get("risk_score") or 0)
    blockage_bonus = sum(
        14
        for item in active_reports
        if item.get("report", item).get("road_status") == "Blocked" or item.get("road_status") == "Blocked"
    )
    route_bias = [26, 8, -10, 3][index] if index < 4 else 6
    return max(0, min(100, round(rainfall * 0.2 + rain_probability * 0.12 + flood_score * 0.22 + blockage_bonus + route_bias)))


def _fetch_routes_sync(origin: dict, destination: dict, weather: dict, flood: dict, active_reports: list[dict]) -> dict:
    settings = get_settings()
    coordinates = f"{origin['lon']},{origin['lat']};{destination['lon']},{destination['lat']}"
    params = {
        "alternatives": "true",
        "steps": "false",
        "geometries": "geojson",
        "overview": "full",
    }

    with httpx.Client(timeout=20) as client:
        response = client.get(f"{settings.osrm_base_url}/route/v1/driving/{coordinates}", params=params)
        response.raise_for_status()
        payload = response.json()

    if payload.get("code") != "Ok" or not payload.get("routes"):
        raise RuntimeError(payload.get("message") or "OSRM did not return routes")

    routes = []
    for index, route in enumerate(payload["routes"][:3]):
        risk_score = route_risk(index, weather, flood, active_reports)
        distance_km = round(float(route.get("distance", 0)) / 1000, 1)
        duration_minutes = round(float(route.get("duration", 0)) / 60)
        final_score = round(duration_minutes * 0.18 + risk_score + distance_km * 0.08)
        routes.append(
            {
                "id": chr(ord("A") + index),
                "name": ["Fastest candidate", "Alternative corridor", "Safety-biased corridor"][index]
                if index < 3
                else "Route candidate",
                "distance_km": distance_km,
                "duration_minutes": duration_minutes,
                "risk_score": risk_score,
                "risk_classification": classify(risk_score),
                "final_score": final_score,
                "recommended": False,
                "reason": "Ranked by travel time plus weather, flood, road and incident risk.",
                "geometry": route.get("geometry"),
            }
        )

    best = min(routes, key=lambda item: item["final_score"])
    best["recommended"] = True
    best["reason"] = "Recommended because it has the lowest combined travel and disruption-risk score."
    return {"source": "osrm", "routes": routes, "recommended_route_id": best["id"]}


async def calculate_ranked_routes(origin: dict, destination: dict, weather: dict, flood: dict, active_reports: list[dict]) -> dict:
    try:
        return await asyncio.to_thread(_fetch_routes_sync, origin, destination, weather, flood, active_reports)
    except Exception as exc:
        return {"source": "demo", "routes": DEMO_ROUTES, "recommended_route_id": "C", "error": str(exc)}
