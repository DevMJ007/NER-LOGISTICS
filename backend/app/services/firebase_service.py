from __future__ import annotations

from ..config import Settings, get_settings


def is_admin_configured(settings: Settings | None = None) -> bool:
    settings = settings or get_settings()
    if settings.firebase_service_account_file:
        import os
        return os.path.isfile(settings.firebase_service_account_file)
    return bool(
        settings.firebase_project_id
        and settings.firebase_client_email
        and settings.firebase_private_key
        and len(settings.firebase_private_key.strip()) > 20
    )


def _get_firebase_app():
    settings = get_settings()
    if not is_admin_configured(settings):
        return None

    try:
        import firebase_admin
        from firebase_admin import credentials
    except ImportError:
        return None

    if firebase_admin._apps:
        return firebase_admin.get_app()

    try:
        if settings.firebase_service_account_file:
            import os
            if not os.path.isfile(settings.firebase_service_account_file):
                return None
            cred = credentials.Certificate(settings.firebase_service_account_file)
        else:
            cred = credentials.Certificate(
                {
                    "type": "service_account",
                    "project_id": settings.firebase_project_id,
                    "private_key_id": "",
                    "private_key": settings.firebase_private_key,
                    "client_email": settings.firebase_client_email,
                    "client_id": "",
                    "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                    "token_uri": "https://oauth2.googleapis.com/token",
                    "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
                    "client_x509_cert_url": f"https://www.googleapis.com/robot/v1/metadata/x509/{settings.firebase_client_email}",
                }
            )
        return firebase_admin.initialize_app(cred, {"projectId": settings.firebase_project_id})
    except Exception:
        return None


async def verify_id_token(token: str) -> dict | None:
    app = _get_firebase_app()
    if app is None:
        return None
    try:
        from firebase_admin import auth
        return auth.verify_id_token(token, app=app)
    except Exception:
        return None


async def send_multicast(tokens: list[str], title: str, body: str, data: dict) -> dict:
    app = _get_firebase_app()
    if app is None:
        return {"configured": False, "sent": 0, "failed": len(tokens), "message": "Firebase Admin SDK not configured."}

    try:
        from firebase_admin import messaging
        message = messaging.MulticastMessage(
            tokens=tokens,
            notification=messaging.Notification(title=title, body=body),
            data={key: str(value) for key, value in data.items()},
        )
        response = messaging.send_each_for_multicast(message, app=app)
        return {"configured": True, "sent": response.success_count, "failed": response.failure_count}
    except Exception as exc:
        return {"configured": True, "sent": 0, "failed": len(tokens), "error": str(exc)}
