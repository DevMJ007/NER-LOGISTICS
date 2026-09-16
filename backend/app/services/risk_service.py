from __future__ import annotations


def classify(score: int) -> str:
    if score >= 81:
        return "CRITICAL"
    if score >= 61:
        return "HIGH"
    if score >= 41:
        return "ELEVATED"
    if score >= 21:
        return "MODERATE"
    return "LOW"


def score_report(report: dict, weather: dict, flood: dict, active_reports: list[dict] | None = None) -> dict:
    severity_bonus = {"Low": 8, "Medium": 14, "Moderate": 18, "High": 26, "Critical": 36}
    road_bonus = {"Open": 0, "Restricted": 14, "Blocked": 30, "Unknown": 8}

    rainfall = float(weather.get("rainfall") or 0)
    rain_probability = float(weather.get("precipitation_probability") or 0)
    flood_score = float(flood.get("risk_score") or 0)
    incident_pressure = min(22, len(active_reports or []) * 4)

    score = round(
        min(
            100,
            rainfall * 0.25
            + rain_probability * 0.18
            + flood_score * 0.22
            + severity_bonus.get(report.get("severity"), 10)
            + road_bonus.get(report.get("road_status"), 8)
            + incident_pressure,
        )
    )

    return {
        "score": score,
        "classification": classify(score),
        "explanation": [
            "Weather, flood, road status and field severity were included in the prototype score.",
            "Satellite catalog metadata is exposed separately and can be folded into the score after validation.",
            "This is AI-assisted risk assessment, not a validated landslide prediction model.",
        ],
    }
