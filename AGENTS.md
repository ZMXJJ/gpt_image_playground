# AGENTS.md

## Cursor Cloud specific instructions

This is a **client-side SPA** (React 19 + Vite + TypeScript + Tailwind CSS 3 + Zustand). There is no backend server in this codebase — all API calls go directly from the browser to external endpoints.

### Key commands

| Action | Command |
|--------|---------|
| Install deps | `npm install` |
| Dev server | `npm run dev` (port 5173) |
| Type check | `npx tsc -b` |
| Unit tests | `npm test` (Vitest, 95 tests) |
| Build | `npm run build` |
| Mock API | `npm run mock:api` (port 8787) |

### Development notes

- The dev server runs on port **5173** with HMR.
- The mock API at port **8787** simulates OpenAI-compatible endpoints. Use `http://localhost:8787/b64` as the API URL in settings to test the full generation flow without a real API key (set any string as the API key).
- No database or external services are required for development — data is stored in browser IndexedDB.
- The `npm run build` command runs `tsc -b` followed by `vite build`. A chunk-size warning for the main JS bundle is expected and harmless.
- There is no ESLint config in this project; type checking via `tsc -b` is the primary static analysis tool.
- For CORS proxy testing during development, copy `dev-proxy.config.example.json` to `dev-proxy.config.json` and configure the `target` field.
