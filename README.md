# i-Witness — Civic Intelligence Platform

A working hackathon prototype that turns individual civic reports into evidence-backed incidents. The platform detects demo hazards, merges nearby matching reports, calculates explainable risk, maps safety signals, exposes deterioration/hotspot analytics, and supports a full authority lifecycle.

## Run with Docker (recommended)

1. Copy `.env.example` to `.env` and set a strong `JWT_SECRET`.
2. Run:

```powershell
docker compose up --build
```

3. Open `http://localhost:5173`. Interactive API docs are at `http://localhost:8000/docs`.

To stop the stack: `docker compose down`. Add `-v` only if you intentionally want to delete the local database volume.

## Run without Docker

Use PostgreSQL, create an `iwitness` database, and set `DATABASE_URL` (for example `postgresql+psycopg://postgres:postgres@localhost:5432/iwitness`). Then:

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
$env:DATABASE_URL='postgresql+psycopg://postgres:postgres@localhost:5432/iwitness'
$env:JWT_SECRET='replace-me'
uvicorn app.main:app --reload
```

In another terminal:

```powershell
cd frontend
npm install
npm run dev
```

The PostgreSQL baseline schema is in `backend/alembic/versions/001_initial.sql`; the demo app also creates missing tables on first startup for hackathon simplicity.

## Demo accounts

All use password `Demo123!`:

| Role | Email |
| --- | --- |
| Citizen | citizen@iwitness.demo |
| Authority | authority@iwitness.demo |
| Admin | admin@iwitness.demo |

The seed contains three reports merged into a verified, high-risk MG Road pothole; a recurring waterlogging hotspot; and a streetlight incident which was resolved then reopened. Submit another pothole report around latitude `12.9716`, longitude `77.5946` to see live evidence merging and risk growth.

## Environment variables

- `DATABASE_URL`: PostgreSQL SQLAlchemy URL; required outside Docker.
- `JWT_SECRET`: signing secret; required outside development.
- `VITE_API_URL`: frontend API base (default `http://localhost:8000/api`).
- `VITE_GOOGLE_MAPS_API_KEY`: optional Google Maps browser key. The prototype shows an interactive coordinate-based map fallback until a production Google Maps component is connected.
- `DEMO_MODE`: defaults to deterministic local AI behavior.

## AI and scaling notes

The current no-cost fallback classifies hazard/severity from report text and merges incidents using active-state, hazard, and 120m proximity. It intentionally returns its mode to the client and displays the risk explanation: severity, evidence count, and workflow state. It is a real, deterministic workflow—not fabricated API results—but it is not computer vision.

For production, replace `classify` and the duplicate predicate with adapters for a vision classifier, embedding service (text/image), speech-to-text provider, and geospatial/PostGIS query. Storage is already represented as a URL boundary (`image_url`); replace the local upload implementation with S3/Cloudinary without changing the report API. Google Maps key must be domain-restricted.

## GPU image-classifier training

The civic-image dataset is folder-labelled, not bounding-box annotated, so it trains as an EfficientNet-B0 image classifier rather than YOLO. The GPU script creates a CUDA PyTorch environment on its first run, keeps augmented copies of each source image in the same split, trains for at least 10 epochs, and then stops after three non-improving macro-F1 epochs. `Mixed Issues` is intentionally excluded because it is a catch-all label rather than one visual hazard.

```powershell
cd backend\ml
.\train_gpu.ps1 -Epochs 20 -BatchSize 8 -Patience 3
```

The trained deployment checkpoint is written to `backend/models/civic_hazard_classifier.pt`; restart the API after training to load it. Until that file exists, the API uses deterministic text classification.

## Tests

```powershell
cd backend
python -m pytest tests -q
```

The logic tests cover classification, evidence-driven risk increase, and geo-distance behavior. API routes provide OpenAPI documentation at `/docs`.
