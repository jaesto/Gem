# Security Policy

## Supported versions

This repository currently publishes a static MVP. Security updates will be delivered on a best-effort basis.

## Reporting a vulnerability

If you discover a security issue:

1. Do **not** create a public issue.
2. Email the maintainers privately at `security@example.com` with steps to reproduce.
3. Allow a reasonable time for investigation and remediation before disclosure.

## Data handling

- The application works entirely offline. Tableau workbooks are parsed client-side only.
- No data leaves the browser and no telemetry is collected.
- Bundled dependencies are vendored locally to avoid CDN requests.
