from __future__ import annotations

import asyncio
import json
from datetime import datetime
from typing import Literal

from fastapi import Depends, FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .config import get_settings
from .database import (
    delete_vehicle,
    get_blocked_road_count,
    get_incident,
    get_vehicle,
    init_db,
    insert_alert,
    insert_field_report,
    insert_incident,
    insert_vehicle,
    insert_vehicle_location,
    list_fcm_tokens,
    list_field_reports,
    list_incidents,
    list_vehicles,
    register_fcm_token,
    update_incident_status,
    update_vehicle,
    now_iso,
)
from .services import copernicus_service, firebase_service, flood_service, osrm_service, risk_service, weather_service


app = FastAPI(title="NER Logistics Intelligence API", version="0.3.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

connected_clients: list[WebSocket] = []


@app.on_event("startup")
async def startup():
    init_db()
    _seed_demo_data()


def _seed_demo_data():
    existing = list_vehicles()
    if existing:
        return
    demo_vehicles = [
        {"vehicle_number": "TRUCK-104", "type": "Truck", "driver_name": "Lalrinmawia", "status": "in_transit",
         "origin": "Silchar", "destination": "Aizawl Medical Store", "load_type": "Medicine",
         "current_lat": 24.65, "current_lon": 92.75, "speed": 42, "eta": "3h 15m", "risk_score": 74},
        {"vehicle_number": "VAN-221", "type": "Van", "driver_name": "R. Debbarma", "status": "in_transit",
         "origin": "Agartala", "destination": "Relief warehouse", "load_type": "Food",
         "current_lat": 23.90, "current_lon": 91.30, "speed": 36, "eta": "2h 05m", "risk_score": 38},
        {"vehicle_number": "AMB-017", "type": "Ambulance", "driver_name": "N. Singh", "status": "priority",
         "origin": "Imphal East", "destination": "District Hospital", "load_type": "Emergency",
         "current_lat": 24.82, "current_lon": 93.94, "speed": 51, "eta": "48m", "risk_score": 58},
        {"vehicle_number": "TRUCK-312", "type": "Truck", "driver_name": "P. Chutia", "status": "in_transit",
         "origin": "Guwahati", "destination": "Construction depot", "load_type": "Materials",
         "current_lat": 26.14, "current_lon": 91.74, "speed": 44, "eta": "4h 30m", "risk_score": 46},
        {"vehicle_number": "JEEP-088", "type": "Jeep", "driver_name": "K. Syiem", "status": "survey",
         "origin": "Shillong", "destination": "Field unit", "load_type": "Field team",
         "current_lat": 25.58, "current_lon": 91.89, "speed": 28, "eta": "1h 10m", "risk_score": 67},
    ]
    for v in demo_vehicles:
        insert_vehicle(v)


class Coordinate(BaseModel):
    lat: float = Field(..., ge=-90, le=90)
    lon: float = Field(..., ge=-180, le=180)


class RouteRequest(BaseModel):
    origin: Coordinate
    destination: Coordinate


class FieldReport(BaseModel):
    type: str
    severity: Literal["Low", "Medium", "Moderate", "High", "Critical"]
    description: str
    location: Coordinate
    road_status: Literal["Open", "Restricted", "Blocked", "Unknown"] = "Unknown"
    corridor: str | None = None
    photo_url: str | None = None
    district: str | None = None


class AlertRequest(BaseModel):
    title: str
    message: str
    severity: Literal["LOW", "MODERATE", "ELEVATED", "HIGH", "CRITICAL"] = "HIGH"
    target_role: str | None = None


class FcmTokenRequest(BaseModel):
    token: str
    role: str | None = None
    district: str | None = None


class VehicleCreate(BaseModel):
    vehicle_number: str
    type: str = "Truck"
    driver_name: str = "Unknown"
    status: str = "available"
    origin: str = ""
    destination: str = ""
    load_type: str = ""
    current_lat: float = 23.727
    current_lon: float = 92.717
    speed: float = 0
    heading: float = 0
    risk_score: int = 0
    eta: str = ""


class VehicleUpdate(BaseModel):
    vehicle_number: str | None = None
    type: str | None = None
    driver_name: str | None = None
    status: str | None = None
    origin: str | None = None
    destination: str | None = None
    load_type: str | None = None
    current_lat: float | None = None
    current_lon: float | None = None
    speed: float | None = None
    heading: float | None = None
    risk_score: int | None = None
    eta: str | None = None


class IncidentStatusUpdate(BaseModel):
    status: Literal["REPORTED", "UNDER_REVIEW", "VERIFIED", "ACTIVE", "RESOLVED"]


class GpsUpdate(BaseModel):
    vehicle_id: str
    lat: float
    lon: float
    speed: float = 0
    heading: float = 0


async def optional_user(authorization: str | None = Header(default=None)) -> dict | None:
    if not authorization or not authorization.lower().startswith("bearer "):
        return None
    token = authorization.split(" ", 1)[1].strip()
    return await firebase_service.verify_id_token(token)


async def broadcast(message: dict) -> None:
    dead = []
    for ws in connected_clients:
        try:
            await ws.send_json(message)
        except Exception:
            dead.append(ws)
    for ws in dead:
        connected_clients.remove(ws)


@app.get("/api/health")
async def health() -> dict:
    settings = get_settings()
    return {
        "status": "ok",
        "service": "NER Logistics Intelligence",
        "timestamp": datetime.utcnow().isoformat() + "Z",
        "integrations": {
            "firebase_admin": firebase_service.is_admin_configured(settings),
            "copernicus": copernicus_service.is_configured(settings),
            "open_meteo": True,
            "open_meteo_flood": True,
            "osrm": bool(settings.osrm_base_url),
        },
    }


@app.get("/api/config")
async def public_config() -> dict:
    settings = get_settings()
    return {
        "api_version": app.version,
        "environment": settings.app_environment,
        "integrations": {
            "firebase_admin": firebase_service.is_admin_configured(settings),
            "copernicus": copernicus_service.is_configured(settings),
            "open_meteo": True,
            "open_meteo_flood": True,
            "osrm": bool(settings.osrm_base_url),
        },
    }


@app.get("/api/dashboard")
async def dashboard() -> dict:
    active = list_incidents()
    blocked = get_blocked_road_count()
    vehicles = list_vehicles()
    return {
        "active_vehicles": len(vehicles),
        "active_incidents": len([i for i in active if i["status"] != "RESOLVED"]),
        "blocked_roads": blocked,
        "weather_risk_areas": 6,
        "deliveries_in_transit": len([v for v in vehicles if v["status"] == "in_transit"]),
        "critical_corridors": len([i for i in active if i.get("severity") in ("High", "Critical") and i["status"] != "RESOLVED"]),
    }


@app.get("/api/weather")
async def weather(lat: float, lon: float) -> dict:
    return await weather_service.get_weather(lat=lat, lon=lon)


@app.get("/api/flood")
async def flood(lat: float, lon: float) -> dict:
    return await flood_service.get_flood(lat=lat, lon=lon)


@app.get("/api/satellite/latest")
async def latest_satellite(lat: float, lon: float, days: int = 30) -> dict:
    return await copernicus_service.search_latest_observations(lat=lat, lon=lon, days=days)


@app.post("/api/risk")
async def risk(report: FieldReport) -> dict:
    weather_payload = await weather_service.get_weather(lat=report.location.lat, lon=report.location.lon)
    flood_payload = await flood_service.get_flood(lat=report.location.lat, lon=report.location.lon)
    return risk_service.score_report(
        report=report.model_dump(),
        weather=weather_payload,
        flood=flood_payload,
        active_reports=list_incidents(),
    )


@app.post("/api/routes/calculate")
async def calculate_route(payload: RouteRequest) -> dict:
    weather_payload = await weather_service.get_weather(lat=payload.origin.lat, lon=payload.origin.lon)
    flood_payload = await flood_service.get_flood(lat=payload.origin.lat, lon=payload.origin.lon)
    result = await osrm_service.calculate_ranked_routes(
        origin=payload.origin.model_dump(),
        destination=payload.destination.model_dump(),
        weather=weather_payload,
        flood=flood_payload,
        active_reports=list_incidents(),
    )
    await broadcast({"type": "route_updated", "data": result})
    return result


@app.post("/api/reports")
async def create_report(report: FieldReport, user: dict | None = Depends(optional_user)) -> dict:
    risk_payload = await risk(report)
    item = insert_incident({
        "type": report.type,
        "severity": report.severity,
        "description": report.description,
        "lat": report.location.lat,
        "lon": report.location.lon,
        "road_status": report.road_status,
        "corridor": report.corridor or "",
        "district": report.district or "",
        "reported_by": user.get("uid") if user else "anonymous",
        "status": "REPORTED",
        "risk_score": risk_payload.get("score", 0),
    })
    item["risk"] = risk_payload
    await broadcast({"type": "incident_created", "data": item})
    return item


@app.get("/api/incidents")
async def incidents(status: str | None = None) -> dict:
    return {"items": list_incidents(status)}


@app.get("/api/incidents/{incident_id}")
async def get_incident_detail(incident_id: str) -> dict:
    item = get_incident(incident_id)
    if not item:
        raise HTTPException(status_code=404, detail="Incident not found")
    return item


@app.patch("/api/incidents/{incident_id}/status")
async def change_incident_status(incident_id: str, update: IncidentStatusUpdate) -> dict:
    item = update_incident_status(incident_id, update.status)
    if not item:
        raise HTTPException(status_code=404, detail="Incident not found")
    await broadcast({"type": "incident_updated", "data": item})
    return item


@app.post("/api/vehicles")
async def create_vehicle_endpoint(vehicle: VehicleCreate) -> dict:
    item = insert_vehicle(vehicle.model_dump())
    await broadcast({"type": "vehicle_created", "data": item})
    return item


@app.get("/api/vehicles")
async def list_vehicles_endpoint() -> dict:
    return {"items": list_vehicles()}


@app.get("/api/vehicles/{vehicle_id}")
async def get_vehicle_endpoint(vehicle_id: str) -> dict:
    item = get_vehicle(vehicle_id)
    if not item:
        raise HTTPException(status_code=404, detail="Vehicle not found")
    return item


@app.patch("/api/vehicles/{vehicle_id}")
async def update_vehicle_endpoint(vehicle_id: str, update: VehicleUpdate) -> dict:
    data = {k: v for k, v in update.model_dump().items() if v is not None}
    item = update_vehicle(vehicle_id, data)
    if not item:
        raise HTTPException(status_code=404, detail="Vehicle not found")
    await broadcast({"type": "vehicle_updated", "data": item})
    return item


@app.delete("/api/vehicles/{vehicle_id}")
async def delete_vehicle_endpoint(vehicle_id: str) -> dict:
    ok = delete_vehicle(vehicle_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Vehicle not found")
    await broadcast({"type": "vehicle_deleted", "data": {"id": vehicle_id}})
    return {"deleted": True}


@app.post("/api/vehicles/gps")
async def receive_gps(update: GpsUpdate) -> dict:
    insert_vehicle_location(update.vehicle_id, update.lat, update.lon, update.speed, update.heading)
    vehicle = get_vehicle(update.vehicle_id)
    await broadcast({"type": "vehicle_location", "data": {
        "vehicle_id": update.vehicle_id,
        "lat": update.lat, "lon": update.lon,
        "speed": update.speed, "heading": update.heading,
    }})
    return {"ok": True, "vehicle": vehicle}


@app.post("/api/alerts/register-token")
async def register_fcm_token_endpoint(payload: FcmTokenRequest) -> dict:
    count = register_fcm_token(payload.token, payload.role or "", payload.district or "")
    return {"registered": True, "token_count": count}


@app.post("/api/alerts/broadcast")
async def broadcast_alert(payload: AlertRequest) -> dict:
    insert_alert({
        "type": "alert",
        "title": payload.title,
        "message": payload.message,
        "severity": payload.severity,
        "target_role": payload.target_role,
    })
    tokens = list_fcm_tokens()
    if not tokens:
        await broadcast({"type": "alert", "data": {"title": payload.title, "message": payload.message, "severity": payload.severity}})
        return {"sent": 0, "message": "No FCM tokens registered. Alert broadcast via WebSocket."}
    result = await firebase_service.send_multicast(
        tokens=[t["token"] for t in tokens],
        title=payload.title,
        body=payload.message,
        data={"severity": payload.severity, "target_role": payload.target_role or "all"},
    )
    await broadcast({"type": "alert", "data": {"title": payload.title, "message": payload.message, "severity": payload.severity}})
    return result


@app.get("/api/field-reports")
async def get_field_reports() -> dict:
    return {"items": list_field_reports()}


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    connected_clients.append(websocket)
    try:
        while True:
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_json({"type": "pong"})
    except WebSocketDisconnect:
        connected_clients.remove(websocket)
    except Exception:
        if websocket in connected_clients:
            connected_clients.remove(websocket)
