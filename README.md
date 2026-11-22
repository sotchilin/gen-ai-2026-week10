# Chilin OT Management System

A FastAPI, Supabase/PostgreSQL, and React application for occupational therapy operations. The system replaces spreadsheet-based resident profiles and session transfer lists with relational resident, clinical, dietary, group, session, and enrollment records.

## Features

- Daily dashboard for group participation, pending transfers, and dietary review alerts.
- Resident directory with room/bed, dementia and wheelchair flags, assessment history, and dietary requirements.
- Therapy group and session scheduling.
- Session enrollment, transfer progress, and attendance tracking.
- MoCA/HKBC history for longitudinal review and date-range engagement reporting.
- Monthly OT treatment-record CSV export.
- Local rule-based input safety checks. Clinical information is not sent to OpenRouter or another LLM.

## Setup

### 1. Configure Supabase

Create a Supabase project and run [`createTable.sql`](./createTable.sql) in its SQL Editor. The API expects the tables in that schema.

Create a root `.env` file using the existing variable format:

```env
SUPABASE_URL="https://your-project.supabase.co"
SUPABASE_KEY="your-supabase-key"
FRONTEND_ORIGINS="http://localhost:5173,http://127.0.0.1:5173"
```

Keep `.env` private and never commit credentials. The backend currently relies on server-side Supabase access; do not expose a service-role key to the browser. This is a local development prototype: do not enter real resident/health information or deploy it until authenticated user accounts, role-based authorization, audit controls, and appropriate Supabase RLS policies are implemented.

### 2. Run the backend

```bash
pip install fastapi uvicorn supabase python-dotenv pydantic
python main.py
```

The API runs at `http://localhost:8000`. Interactive API documentation is available at `http://localhost:8000/docs`.

### 3. Run the frontend

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`. Vite proxies `/api` requests to the FastAPI server.

## API overview

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Check API and database readiness |
| `GET`, `POST` | `/residents` | List and create residents |
| `GET`, `PATCH` | `/residents/{id}` | View and update a resident |
| `GET`, `POST` | `/residents/{id}/clinical-profiles` | Read or add assessment history |
| `GET`, `POST` | `/residents/{id}/dietary-requirements` | Read or add dietary history |
| `GET`, `POST` | `/therapy-groups` | List or create therapy groups |
| `GET`, `POST` | `/sessions` | List or schedule sessions |
| `GET`, `POST` | `/sessions/{id}/enrollments` | View or enroll residents |
| `PATCH` | `/enrollments/{id}` | Update transfer and attendance status |
| `GET` | `/dashboard?on_date=YYYY-MM-DD` | Daily dashboard and alerts |
| `GET` | `/analytics/engagement` | Attendance rate for a date range |
| `GET` | `/analytics/residents/{id}/trend` | Up to 20 years of assessment records |
| `GET` | `/reports/monthly.csv?month=YYYY-MM` | Download a monthly CSV treatment record |

Database errors are returned explicitly rather than presented as empty resident or session lists. Apply the schema before using the application.
