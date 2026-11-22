import csv
import io
import logging
import os
import re
from datetime import date, datetime, time, timedelta, timezone
from typing import Literal

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, model_validator
from supabase import Client, create_client

load_dotenv()
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("ot-management")

SUPABASE_URL = os.getenv("SUPABASE_URL", "").strip()
SUPABASE_KEY = os.getenv("SUPABASE_KEY", "").strip()
FRONTEND_ORIGINS = [
    origin.strip()
    for origin in os.getenv(
        "FRONTEND_ORIGINS",
        "http://localhost:5173,http://127.0.0.1:5173",
    ).split(",")
    if origin.strip()
]
supabase: Client | None = (
    create_client(SUPABASE_URL, SUPABASE_KEY)
    if SUPABASE_URL and SUPABASE_KEY
    else None
)

app = FastAPI(title="OT Management System", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=FRONTEND_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)

ResidentStatus = Literal["active", "discharged", "hospitalized"]
AttendanceStatus = Literal["scheduled", "attended", "absent", "refused"]
TransferType = Literal["落人", "PT過OT", "OT過PT", "無"]
TransferStatus = Literal["pending", "in_progress", "completed"]


class SecurityAgent:
    """Local-only input checks; resident information is never sent to an LLM."""

    suspicious_patterns = (
        r"ignore\s+(all|previous|prior)\s+instructions",
        r"reveal\s+(api\s+)?key",
        r"bypass\s+security",
        r"jailbreak",
    )

    @classmethod
    def verify_input(cls, text: str) -> bool:
        return not any(
            re.search(pattern, text, flags=re.IGNORECASE)
            for pattern in cls.suspicious_patterns
        )


class ResidentCreate(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    room_number: str = Field(min_length=1, max_length=30)
    bed_number: int | None = Field(default=None, ge=0)
    has_dementia: bool = False
    requires_wheelchair: bool = False
    status: ResidentStatus = "active"


class ResidentUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=160)
    room_number: str | None = Field(default=None, min_length=1, max_length=30)
    bed_number: int | None = Field(default=None, ge=0)
    has_dementia: bool | None = None
    requires_wheelchair: bool | None = None
    status: ResidentStatus | None = None


class ClinicalProfileCreate(BaseModel):
    assessment_date: date
    hkbc_score: int | None = Field(default=None, ge=0)
    moca_score: int | None = Field(default=None, ge=0, le=30)
    restraint_status: str | None = Field(default=None, max_length=500)
    mental_health_notes: str | None = Field(default=None, max_length=5000)


class ClinicalProfileUpdate(BaseModel):
    assessment_date: date | None = None
    hkbc_score: int | None = Field(default=None, ge=0)
    moca_score: int | None = Field(default=None, ge=0, le=30)
    restraint_status: str | None = Field(default=None, max_length=500)
    mental_health_notes: str | None = Field(default=None, max_length=5000)


class DietaryRequirementCreate(BaseModel):
    food_texture: str = Field(default="Normal", min_length=1, max_length=80)
    fluid_consistency: str = Field(default="Regular", min_length=1, max_length=80)
    food_allergies: str | None = Field(default=None, max_length=2000)
    adaptive_equipment: str | None = Field(default=None, max_length=500)
    effective_date: date


class DietaryRequirementUpdate(BaseModel):
    food_texture: str | None = Field(default=None, min_length=1, max_length=80)
    fluid_consistency: str | None = Field(default=None, min_length=1, max_length=80)
    food_allergies: str | None = Field(default=None, max_length=2000)
    adaptive_equipment: str | None = Field(default=None, max_length=500)
    effective_date: date | None = None


class TherapyGroupCreate(BaseModel):
    group_name: str = Field(min_length=1, max_length=160)
    group_code: str = Field(min_length=1, max_length=30)
    location: str = Field(min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=1000)


class SessionCreate(BaseModel):
    group_id: int = Field(gt=0)
    scheduled_date: date
    start_time: time
    end_time: time
    therapist: str | None = Field(default=None, max_length=160)
    capacity: int | None = Field(default=None, gt=0)

    @model_validator(mode="after")
    def end_after_start(self):
        if self.end_time <= self.start_time:
            raise ValueError("end_time must be after start_time")
        return self


class EnrollmentCreate(BaseModel):
    resident_id: int = Field(gt=0)
    transfer_type: TransferType = "無"
    attendance_status: AttendanceStatus = "scheduled"
    performance_notes: str | None = Field(default=None, max_length=3000)


class EnrollmentUpdate(BaseModel):
    transfer_type: TransferType | None = None
    transfer_status: TransferStatus | None = None
    attendance_status: AttendanceStatus | None = None
    performance_notes: str | None = Field(default=None, max_length=3000)


def database() -> Client:
    if supabase is None:
        raise HTTPException(
            status_code=503,
            detail="Supabase is not configured. Set SUPABASE_URL and SUPABASE_KEY in .env.",
        )
    return supabase


def execute(query):
    try:
        response = query.execute()
        return response.data or []
    except Exception as exc:
        logger.exception("Database operation failed")
        raise HTTPException(status_code=502, detail="Database operation failed.") from exc


def get_one(table: str, column: str, value: int):
    rows = execute(
        database().table(table).select("*").eq(column, value).limit(1)
    )
    if not rows:
        raise HTTPException(status_code=404, detail=f"{table.rstrip('s').capitalize()} not found.")
    return rows[0]


def ensure_bed_available(
    room_number: str,
    bed_number: int | None,
    *,
    exclude_resident_id: int | None = None,
):
    if bed_number is None:
        return
    query = (
        database()
        .table("residents")
        .select("resident_id,name")
        .eq("room_number", room_number)
        .eq("bed_number", bed_number)
        .eq("status", "active")
    )
    if exclude_resident_id is not None:
        query = query.neq("resident_id", exclude_resident_id)
    conflicts = execute(query.limit(1))
    if conflicts:
        raise HTTPException(
            status_code=409,
            detail=f"Room {room_number}, bed {bed_number} is already assigned to {conflicts[0]['name']}.",
        )


def json_payload(model: BaseModel, *, exclude_unset: bool = False):
    return model.model_dump(
        mode="json",
        exclude_none=True,
        exclude_unset=exclude_unset,
    )


def csv_safe_cell(value):
    text = "" if value is None else str(value)
    if text.lstrip(" \t\r").startswith(("=", "+", "-", "@")):
        return f"'{text}"
    return text


def check_text(text: str):
    if not SecurityAgent.verify_input(text):
        logger.warning("Local safety check blocked an input.")
        execute(
            database()
            .table("security_logs")
            .insert({"event_type": "blocked_input"})
        )
        raise HTTPException(status_code=400, detail="Input blocked by the local safety check.")


@app.get("/")
def root():
    return {
        "status": "healthy",
        "message": "OT Management System API is running",
        "modules": ["residents", "clinical-profiles", "dietary", "sessions", "logistics", "analytics"],
    }


@app.get("/health")
def health():
    if supabase is None:
        return {"status": "degraded", "database": "not_configured", "safety_check": "local"}
    execute(database().table("residents").select("resident_id").limit(1))
    return {"status": "healthy", "database": "connected", "safety_check": "local"}


@app.post("/security/check")
def check_security(payload: dict):
    text = payload.get("text", "")
    if not isinstance(text, str):
        raise HTTPException(status_code=422, detail="'text' must be a string.")
    is_safe = SecurityAgent.verify_input(text)
    if not is_safe:
        execute(
            database()
            .table("security_logs")
            .insert({"event_type": "blocked_input"})
        )
    return {"is_safe": is_safe, "method": "local_rules"}


@app.get("/dashboard")
def dashboard(on_date: date = Query(default_factory=date.today)):
    db = database()
    session_rows = execute(
        db.table("sessions")
        .select("*")
        .eq("scheduled_date", on_date.isoformat())
        .order("start_time")
    )
    session_ids = [row["session_id"] for row in session_rows]
    group_ids = sorted({row["group_id"] for row in session_rows})
    groups = (
        execute(db.table("therapy_groups").select("*").in_("group_id", group_ids))
        if group_ids
        else []
    )
    group_by_id = {group["group_id"]: group for group in groups}
    enrollments = (
        execute(db.table("session_enrollments").select("*").in_("session_id", session_ids))
        if session_ids
        else []
    )
    residents = execute(
        db.table("residents")
        .select("resident_id,name,room_number,bed_number,status")
        .eq("status", "active")
        .limit(1000)
    )
    resident_by_id = {resident["resident_id"]: resident for resident in residents}
    resident_ids = sorted({row["resident_id"] for row in enrollments})
    diet_rows = (
        execute(
            db.table("dietary_requirements")
            .select("*")
            .in_("resident_id", resident_ids)
            .lte("effective_date", on_date.isoformat())
            .order("effective_date", desc=True)
        )
        if resident_ids
        else []
    )
    latest_diet = {}
    for row in diet_rows:
        latest_diet.setdefault(row["resident_id"], row)

    session_views = []
    alerts = []
    bed_occupants = {}
    for resident in residents:
        bed_number = resident.get("bed_number")
        if bed_number is not None:
            key = (resident["room_number"], bed_number)
            bed_occupants.setdefault(key, []).append(resident)
    for (room_number, bed_number), occupants in bed_occupants.items():
        if len(occupants) > 1:
            alerts.append(
                {
                    "type": "bed_occupancy",
                    "resident": ", ".join(row["name"] for row in occupants),
                    "room_number": room_number,
                    "message": f"Bed {bed_number} is assigned to {len(occupants)} residents",
                }
            )

    for session in session_rows:
        group = group_by_id.get(session["group_id"], {})
        session_enrollments = [
            row for row in enrollments if row["session_id"] == session["session_id"]
        ]
        session_views.append(
            {
                **session,
                "group_name": group.get("group_name", "Therapy group"),
                "group_code": group.get("group_code", ""),
                "location": group.get("location", ""),
                "enrollment_count": len(session_enrollments),
            }
        )
        is_food_group = any(
            word in group.get("group_name", "").lower()
            for word in ("kitchen", "cooking", "feeding")
        )
        for enrollment in session_enrollments:
            resident = resident_by_id.get(enrollment["resident_id"], {})
            diet = latest_diet.get(enrollment["resident_id"], {})
            if enrollment.get("transfer_type") != "無" and enrollment.get("transfer_status") != "completed":
                alerts.append(
                    {
                        "type": "transfer",
                        "resident": resident.get("name", "Resident"),
                        "room_number": resident.get("room_number", ""),
                        "message": "Transfer is not marked complete",
                    }
                )
            if is_food_group and (
                diet.get("food_allergies")
                or diet.get("food_texture", "Normal").lower() != "normal"
                or diet.get("fluid_consistency", "Regular").lower() != "regular"
            ):
                alerts.append(
                    {
                        "type": "dietary",
                        "resident": resident.get("name", "Resident"),
                        "room_number": resident.get("room_number", ""),
                        "message": "Review dietary requirements before this session",
                    }
                )

    for index, first in enumerate(session_views):
        for second in session_views[index + 1 :]:
            if (
                first["location"]
                and first["location"] == second["location"]
                and first["start_time"] < second["end_time"]
                and second["start_time"] < first["end_time"]
            ):
                alerts.append(
                    {
                        "type": "schedule",
                        "resident": first["group_name"],
                        "room_number": first["location"],
                        "message": f"Overlaps with {second['group_name']} at this location",
                    }
                )

    return {
        "on_date": on_date.isoformat(),
        "active_residents": len(residents),
        "sessions_today": len(session_rows),
        "residents_scheduled": len(enrollments),
        "transfers_pending": sum(alert["type"] == "transfer" for alert in alerts),
        "dietary_alerts": sum(alert["type"] == "dietary" for alert in alerts),
        "scheduling_conflicts": sum(alert["type"] == "schedule" for alert in alerts),
        "bed_occupancy_conflicts": sum(alert["type"] == "bed_occupancy" for alert in alerts),
        "sessions": session_views,
        "alerts": alerts,
    }


@app.get("/residents")
def list_residents(
    search: str | None = None,
    status: ResidentStatus | None = None,
):
    db = database()
    query = db.table("residents").select("*").order("name").limit(500)
    if search:
        check_text(search)
        query = query.ilike("name", f"%{search}%")
    if status:
        query = query.eq("status", status)
    return execute(query)


@app.get("/residents/candidates")
def resident_candidates(
    session_id: int,
    has_dementia: bool | None = None,
    moca_below: int | None = Query(default=None, ge=0, le=30),
):
    get_one("sessions", "session_id", session_id)
    db = database()
    candidates = execute(
        db.table("residents")
        .select("*")
        .eq("status", "active")
        .order("name")
        .limit(500)
    )
    existing = execute(
        db.table("session_enrollments")
        .select("resident_id")
        .eq("session_id", session_id)
    )
    enrolled_ids = {row["resident_id"] for row in existing}
    candidates = [row for row in candidates if row["resident_id"] not in enrolled_ids]
    if has_dementia is not None:
        candidates = [
            row for row in candidates if row["has_dementia"] == has_dementia
        ]
    if moca_below is not None and candidates:
        candidate_ids = [row["resident_id"] for row in candidates]
        profiles = execute(
            db.table("clinical_profiles")
            .select("resident_id,moca_score,assessment_date")
            .in_("resident_id", candidate_ids)
            .order("assessment_date", desc=True)
        )
        latest_scores = {}
        for profile in profiles:
            latest_scores.setdefault(profile["resident_id"], profile.get("moca_score"))
        candidates = [
            {**row, "latest_moca_score": latest_scores[row["resident_id"]]}
            for row in candidates
            if latest_scores.get(row["resident_id"]) is not None
            and latest_scores[row["resident_id"]] < moca_below
        ]
    return candidates


@app.post("/residents", status_code=201)
def create_resident(resident: ResidentCreate):
    if resident.status == "active":
        ensure_bed_available(resident.room_number, resident.bed_number)
    rows = execute(
        database()
        .table("residents")
        .insert(json_payload(resident))
    )
    return rows[0]


@app.get("/residents/{resident_id}")
def resident_summary(resident_id: int):
    resident = get_one("residents", "resident_id", resident_id)
    enrollment_rows = execute(
        database()
        .table("session_enrollments")
        .select("session_id")
        .eq("resident_id", resident_id)
    )
    session_ids = sorted({row["session_id"] for row in enrollment_rows})
    sessions = (
        execute(
            database()
            .table("sessions")
            .select("session_id,group_id,scheduled_date,start_time,therapist")
            .in_("session_id", session_ids)
            .order("scheduled_date")
            .order("start_time")
        )
        if session_ids
        else []
    )
    group_ids = sorted({row["group_id"] for row in sessions})
    groups = (
        execute(
            database()
            .table("therapy_groups")
            .select("group_id,group_name,group_code")
            .in_("group_id", group_ids)
        )
        if group_ids
        else []
    )
    group_by_id = {group["group_id"]: group for group in groups}
    profiles = execute(
        database()
        .table("clinical_profiles")
        .select("*")
        .eq("resident_id", resident_id)
        .order("assessment_date", desc=True)
        .limit(1)
    )
    diets = execute(
        database()
        .table("dietary_requirements")
        .select("*")
        .eq("resident_id", resident_id)
        .order("effective_date", desc=True)
        .limit(1)
    )
    return {
        **resident,
        "latest_profile": profiles[0] if profiles else None,
        "latest_diet": diets[0] if diets else None,
        "cognitive_groups": [
            {
                **group_by_id.get(session["group_id"], {}),
                "session_id": session["session_id"],
                "scheduled_date": session["scheduled_date"],
                "start_time": session["start_time"],
                "therapist": session["therapist"],
            }
            for session in sessions
        ],
    }


@app.patch("/residents/{resident_id}")
def update_resident(resident_id: int, updates: ResidentUpdate):
    resident = get_one("residents", "resident_id", resident_id)
    payload = updates.model_dump(mode="json", exclude_unset=True)
    if not payload:
        raise HTTPException(status_code=400, detail="No resident fields were provided.")
    if any(field in payload for field in ("room_number", "bed_number", "status")):
        room_number = payload.get("room_number", resident["room_number"])
        bed_number = payload.get("bed_number", resident.get("bed_number"))
        status = payload.get("status", resident["status"])
        if status == "active":
            ensure_bed_available(
                room_number,
                bed_number,
                exclude_resident_id=resident_id,
            )
    payload["updated_at"] = datetime.now(timezone.utc).isoformat()
    rows = execute(
        database()
        .table("residents")
        .update(payload)
        .eq("resident_id", resident_id)
    )
    return rows[0] if rows else get_one("residents", "resident_id", resident_id)


@app.patch("/clinical-profiles/{profile_id}")
def update_clinical_profile(profile_id: int, updates: ClinicalProfileUpdate):
    get_one("clinical_profiles", "profile_id", profile_id)
    payload = updates.model_dump(mode="json", exclude_unset=True)
    if not payload:
        raise HTTPException(status_code=400, detail="No clinical profile fields were provided.")
    rows = execute(
        database()
        .table("clinical_profiles")
        .update(payload)
        .eq("profile_id", profile_id)
        .select("*")
    )
    return rows[0] if rows else get_one("clinical_profiles", "profile_id", profile_id)


@app.patch("/residents/{resident_id}/clinical-profiles/latest")
def update_latest_clinical_profile(resident_id: int, updates: ClinicalProfileUpdate):
    get_one("residents", "resident_id", resident_id)
    profiles = execute(
        database()
        .table("clinical_profiles")
        .select("profile_id")
        .eq("resident_id", resident_id)
        .order("assessment_date", desc=True)
        .limit(1)
    )
    if not profiles:
        raise HTTPException(
            status_code=404,
            detail=f"No clinical assessment found for resident {resident_id}.",
        )
    return update_clinical_profile(profiles[0]["profile_id"], updates)


@app.get("/residents/{resident_id}/clinical-profiles")
def list_clinical_profiles(resident_id: int):
    get_one("residents", "resident_id", resident_id)
    return execute(
        database()
        .table("clinical_profiles")
        .select("*")
        .eq("resident_id", resident_id)
        .order("assessment_date", desc=True)
    )


@app.post("/residents/{resident_id}/clinical-profiles", status_code=201)
def add_clinical_profile(resident_id: int, profile: ClinicalProfileCreate):
    get_one("residents", "resident_id", resident_id)
    payload = {**json_payload(profile), "resident_id": resident_id}
    rows = execute(database().table("clinical_profiles").insert(payload))
    return rows[0]


@app.get("/residents/{resident_id}/dietary-requirements")
def list_dietary_requirements(resident_id: int):
    get_one("residents", "resident_id", resident_id)
    return execute(
        database()
        .table("dietary_requirements")
        .select("*")
        .eq("resident_id", resident_id)
        .order("effective_date", desc=True)
    )


@app.post("/residents/{resident_id}/dietary-requirements", status_code=201)
def add_dietary_requirement(resident_id: int, requirement: DietaryRequirementCreate):
    get_one("residents", "resident_id", resident_id)
    payload = {**json_payload(requirement), "resident_id": resident_id}
    rows = execute(database().table("dietary_requirements").insert(payload))
    return rows[0]


@app.patch("/dietary-requirements/{diet_id}")
def update_dietary_requirement(diet_id: int, updates: DietaryRequirementUpdate):
    get_one("dietary_requirements", "diet_id", diet_id)
    payload = updates.model_dump(mode="json", exclude_unset=True)
    if not payload:
        raise HTTPException(status_code=400, detail="No dietary requirement fields were provided.")
    rows = execute(
        database()
        .table("dietary_requirements")
        .update(payload)
        .eq("diet_id", diet_id)
    )
    return rows[0] if rows else get_one("dietary_requirements", "diet_id", diet_id)


@app.get("/therapy-groups")
def list_therapy_groups():
    return execute(
        database().table("therapy_groups").select("*").order("group_name")
    )


@app.post("/therapy-groups", status_code=201)
def create_therapy_group(group: TherapyGroupCreate):
    rows = execute(
        database()
        .table("therapy_groups")
        .insert(json_payload(group))
    )
    return rows[0]


@app.get("/sessions")
def list_sessions(
    scheduled_date: date | None = None,
    start_date: date | None = None,
    end_date: date | None = None,
):
    query = database().table("sessions").select("*").order("scheduled_date").order("start_time")
    if scheduled_date:
        query = query.eq("scheduled_date", scheduled_date.isoformat())
    if start_date:
        query = query.gte("scheduled_date", start_date.isoformat())
    if end_date:
        query = query.lte("scheduled_date", end_date.isoformat())
    sessions = execute(query.limit(500))
    group_ids = sorted({row["group_id"] for row in sessions})
    groups = (
        execute(database().table("therapy_groups").select("*").in_("group_id", group_ids))
        if group_ids
        else []
    )
    session_ids = [row["session_id"] for row in sessions]
    enrollment_rows = (
        execute(
            database()
            .table("session_enrollments")
            .select("session_id")
            .in_("session_id", session_ids)
        )
        if session_ids
        else []
    )
    enrollment_counts = {}
    for enrollment in enrollment_rows:
        enrollment_counts[enrollment["session_id"]] = (
            enrollment_counts.get(enrollment["session_id"], 0) + 1
        )
    group_by_id = {group["group_id"]: group for group in groups}
    return [
        {
            **session,
            "group_name": group_by_id.get(session["group_id"], {}).get("group_name", "Therapy group"),
            "group_code": group_by_id.get(session["group_id"], {}).get("group_code", ""),
            "location": group_by_id.get(session["group_id"], {}).get("location", ""),
            "enrollment_count": enrollment_counts.get(session["session_id"], 0),
        }
        for session in sessions
    ]


@app.post("/sessions", status_code=201)
def create_session(session: SessionCreate):
    rows = execute(database().table("sessions").insert(json_payload(session)))
    return rows[0]


@app.get("/sessions/{session_id}/enrollments")
def list_enrollments(session_id: int):
    get_one("sessions", "session_id", session_id)
    rows = execute(
        database()
        .table("session_enrollments")
        .select("*")
        .eq("session_id", session_id)
        .order("enrollment_id")
    )
    resident_ids = sorted({row["resident_id"] for row in rows})
    residents = (
        execute(
            database()
            .table("residents")
            .select("resident_id,name,room_number,bed_number,requires_wheelchair")
            .in_("resident_id", resident_ids)
        )
        if resident_ids
        else []
    )
    resident_by_id = {resident["resident_id"]: resident for resident in residents}
    return [
        {**row, **resident_by_id.get(row["resident_id"], {})}
        for row in rows
    ]


@app.post("/sessions/{session_id}/enrollments", status_code=201)
def enroll_resident(session_id: int, enrollment: EnrollmentCreate):
    session = get_one("sessions", "session_id", session_id)
    resident = get_one("residents", "resident_id", enrollment.resident_id)
    if resident["status"] != "active":
        raise HTTPException(status_code=409, detail="Only active residents can be enrolled.")
    if session.get("capacity") is not None:
        current = execute(
            database()
            .table("session_enrollments")
            .select("enrollment_id")
            .eq("session_id", session_id)
        )
        if len(current) >= session["capacity"]:
            raise HTTPException(status_code=409, detail="The session has reached capacity.")
    existing = execute(
        database()
        .table("session_enrollments")
        .select("enrollment_id")
        .eq("session_id", session_id)
        .eq("resident_id", enrollment.resident_id)
    )
    if existing:
        raise HTTPException(status_code=409, detail="Resident is already enrolled in this session.")
    rows = execute(
        database()
        .table("session_enrollments")
        .insert(
            {
                **json_payload(enrollment),
                "session_id": session_id,
            }
        )
    )
    return rows[0]


@app.patch("/enrollments/{enrollment_id}")
def update_enrollment(enrollment_id: int, updates: EnrollmentUpdate):
    get_one("session_enrollments", "enrollment_id", enrollment_id)
    payload = json_payload(updates, exclude_unset=True)
    if not payload:
        raise HTTPException(status_code=400, detail="No enrollment fields were provided.")
    payload["updated_at"] = datetime.now(timezone.utc).isoformat()
    rows = execute(
        database()
        .table("session_enrollments")
        .update(payload)
        .eq("enrollment_id", enrollment_id)
    )
    return rows[0] if rows else get_one("session_enrollments", "enrollment_id", enrollment_id)


@app.get("/analytics/engagement")
def engagement_report(
    start_date: date,
    end_date: date,
):
    if end_date < start_date:
        raise HTTPException(status_code=400, detail="end_date must be on or after start_date.")
    sessions = execute(
        database()
        .table("sessions")
        .select("session_id")
        .gte("scheduled_date", start_date.isoformat())
        .lte("scheduled_date", end_date.isoformat())
    )
    session_ids = [row["session_id"] for row in sessions]
    enrollments = (
        execute(
            database()
            .table("session_enrollments")
            .select("attendance_status")
            .in_("session_id", session_ids)
        )
        if session_ids
        else []
    )
    attended = sum(row["attendance_status"] == "attended" for row in enrollments)
    count = len(enrollments)
    return {
        "start_date": start_date.isoformat(),
        "end_date": end_date.isoformat(),
        "sessions": len(sessions),
        "enrollments": count,
        "attended": attended,
        "attendance_rate": round(attended / count * 100, 1) if count else 0,
    }


@app.get("/analytics/residents/{resident_id}/trend")
def resident_trend(resident_id: int, years: int = Query(default=5, ge=1, le=20)):
    get_one("residents", "resident_id", resident_id)
    cutoff = date.today() - timedelta(days=years * 365)
    rows = execute(
        database()
        .table("clinical_profiles")
        .select("assessment_date,hkbc_score,moca_score")
        .eq("resident_id", resident_id)
        .gte("assessment_date", cutoff.isoformat())
        .order("assessment_date")
    )
    return rows


@app.get("/reports/monthly.csv")
def monthly_report(month: str = Query(pattern=r"^\d{4}-\d{2}$")):
    try:
        first_day = date.fromisoformat(f"{month}-01")
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="month must be a valid YYYY-MM value.") from exc
    next_month = (
        date(first_day.year + 1, 1, 1)
        if first_day.month == 12
        else date(first_day.year, first_day.month + 1, 1)
    )
    sessions = execute(
        database()
        .table("sessions")
        .select("*")
        .gte("scheduled_date", first_day.isoformat())
        .lt("scheduled_date", next_month.isoformat())
        .order("scheduled_date")
    )
    session_ids = [row["session_id"] for row in sessions]
    enrollments = (
        execute(
            database()
            .table("session_enrollments")
            .select("*")
            .in_("session_id", session_ids)
        )
        if session_ids
        else []
    )
    group_ids = sorted({row["group_id"] for row in sessions})
    groups = (
        execute(database().table("therapy_groups").select("*").in_("group_id", group_ids))
        if group_ids
        else []
    )
    resident_ids = sorted({row["resident_id"] for row in enrollments})
    residents = (
        execute(
            database()
            .table("residents")
            .select("resident_id,name,room_number,bed_number")
            .in_("resident_id", resident_ids)
        )
        if resident_ids
        else []
    )
    by_session = {row["session_id"]: row for row in sessions}
    by_group = {row["group_id"]: row for row in groups}
    by_resident = {row["resident_id"]: row for row in residents}
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(
        [
            "Date", "Start time", "Group", "Location", "Resident", "Room", "Bed",
            "Attendance", "Transfer type", "Transfer status", "Performance notes",
        ]
    )
    for enrollment in enrollments:
        session = by_session.get(enrollment["session_id"], {})
        group = by_group.get(session.get("group_id"), {})
        resident = by_resident.get(enrollment["resident_id"], {})
        writer.writerow(
            [
                csv_safe_cell(value)
                for value in [
                session.get("scheduled_date", ""),
                session.get("start_time", ""),
                group.get("group_name", ""),
                group.get("location", ""),
                resident.get("name", ""),
                resident.get("room_number", ""),
                resident.get("bed_number", ""),
                enrollment.get("attendance_status", ""),
                enrollment.get("transfer_type", ""),
                enrollment.get("transfer_status", ""),
                enrollment.get("performance_notes", ""),
                ]
            ]
        )
    filename = f"ot-treatment-record-{month}.csv"
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000)
