# ScanGuru Web — Doctor Portal Frontend

Static HTML pages for the ScanGuru doctor portal. These pages call the
portal backend at `API_BASE` (defined inline in each HTML file).

## Pages

- `portal-login.html` — JWT login form
- `dashboard-main.html` — main dashboard with stat tiles, recent studies table, New Analysis upload modal
- `patient-detail.html` — per-patient profile with study timeline
- `patients.html` — patient list with search + Add Patient modal

## Configuration

Each HTML file has this near the top of its `<script>` block:

```js
const API_BASE = 'http://localhost:8001/api/v1';
```

For production, change to:
```js
const API_BASE = 'https://api.scanguru.net/api/v1';
```

(Or wherever the deployed backend lives. See the backend repo's
DEVELOPER_DEPLOYMENT_GUIDE.md for full deployment steps.)

## Local development

These files need to be served via HTTP (file:// won't work due to CORS).
Simplest:

```bash
python3 -m http.server 3000
# then open http://localhost:3000/portal-login.html
```

The portal backend must be running separately at the URL in API_BASE.

## Companion repo

Backend: https://github.com/sap-amador/scanguru-portal-api
