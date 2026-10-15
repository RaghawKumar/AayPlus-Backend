# Separate project repositories

Keep these three checkouts next to each other in an ordinary workspace folder:

```text
AayPlus/                       # workspace only; no parent Git repository
  AayPlus-App/                  # github.com/RaghawKumar/AayPlus
  AayPlus-Admin/                # github.com/RaghawKumar/AayPlus-Admin
  AayPlus-Backend/              # github.com/RaghawKumar/AayPlus-Backend
```

Run Git commands inside the project they belong to. Each repository has its own commit history, origin and main branch. Do not initialize Git in the parent folder or commit these repositories as nested folders.

The app and admin use the backend over HTTP; their Git repositories do not need to be merged. Shared workflow/setup notes are included in each repository's docs folder so they remain available when a project is checked out by itself.

Read [INTEGRATION.md](INTEGRATION.md) for startup instructions and [APP-FLOW.md](APP-FLOW.md) for user journeys. Keep .env files, runtime SQLite databases, uploads, node_modules and build output out of commits.

The backend's optional cross-client test exercises the actual admin adapter when the sibling admin checkout is present. It is skipped when running the backend alone; all backend-only tests continue to run.
