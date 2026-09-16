from __future__ import annotations

import asyncio

import httpx

from ..config import get_settings


DEMO_WEATHER = {
    "source": "demo",
    "location": {"lat": 23.727, "lon": 92.717},
    "temperature": 24,
    "humidity": 86,
    "rainfall": 58,
    "wind_speed": 18,
    "precipitation_probability": 82,
    "weather_code": 63,
    "warning": "Heavy rainfall likely across hill corridors",
    "hourly": [
        {"hour": "09", "rain": 32},
        {"hour": "10", "rain": 44},
        {"hour": "11", "rain": 58},
        {"hour": "12", "rain": 66},
        {"hour": "13", "rain": 74},
        {"hour": "14", "rain": 69},
        {"hour": "15", "rain": 56},
        {"hour": "16", "rain": 41},
    ],
}


def _fetch_weather_sync(lat: float, lon: float) -> dict:
    settings = get_settings()
    params = {
        "latitude": lat,
        "longitude": lon,
        "current": "temperature_2m,relative_humidity_2m,precipitation,rain,weather_code,wind_speed_10m",
        "hourly": "precipitation,precipitation_probability,rain",
        "forecast_days": 2,
        "timezone": "auto",
    }

    with httpx.Client(timeout=15) as client:
        response = client.get(f"{settings.open_meteo_base_url}/v1/forecast", params=params)
        response.raise_for_status()
        payload = response.json()

    current = payload.get("current", {})
    hourly_payload = payload.get("hourly", {})
    hourly_times = hourly_payload.get("time", [])[:8]
    hourly_rain = hourly_payload.get("rain", [])[:8] or hourly_payload.get("precipitation", [])[:8]

    rainfall = float(current.get("rain") or current.get("precipitation") or 0)
    rain_probability_values = hourly_payload.get("precipitation_probability", [])[:8]
    rain_probability = max(rain_probability_values or [0])

    warning = "Normal weather conditions"
    if rain_probability >= 70 or rainfall >= 20:
        warning = "Heavy rainfall likely across hill corridors"
    elif rain_probability >= 45:
        warning = "Rainfall watch for exposed road corridors"

    return {
        "source": "open-meteo",
        "location": {"lat": lat, "lon": lon},
        "temperature": round(float(current.get("temperature_2m") or 0)),
        "humidity": round(float(current.get("relative_humidity_2m") or 0)),
        "rainfall": round(rainfall, 1),
        "wind_speed": round(float(current.get("wind_speed_10m") or 0), 1),
        "precipitation_probability": round(float(rain_probability)),
        "weather_code": current.get("weather_code"),
        "warning": warning,
        "hourly": [
            {
                "hour": str(time_value)[11:13] if len(str(time_value)) >= 13 else str(index),
                "rain": round(float(hourly_rain[index] if index < len(hourly_rain) else 0), 1),
            }
            for index, time_value in enumerate(hourly_times)
        ],
    }


async def get_weather(lat: float, lon: float) -> dict:
    try:
        return await asyncio.to_thread(_fetch_weather_sync, lat, lon)
    except Exception as exc:
        return {**DEMO_WEATHER, "location": {"lat": lat, "lon": lon}, "error": str(exc)}
