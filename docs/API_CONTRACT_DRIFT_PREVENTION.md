# API Contract Drift Prevention

This document describes the tools and processes for preventing frontend/backend API contract drift.

## Overview

API contract drift occurs when the backend API changes in ways that break the frontend. This can happen when:

- Response fields are removed or renamed
- Required fields become optional or vice versa
- New required fields are added
- Endpoints are removed or changed
- Response status codes change

## Tools

### 1. OpenAPI Type Generation (`npm run generate:api-types`)

Generates TypeScript types and Zod schemas from the backend's OpenAPI spec.

```bash
cd frontend
npm run generate:api-types
```

This creates:
- `src/types/api/api.ts` - TypeScript interfaces
- `src/types/api/api-schemas.ts` - Zod validation schemas

### 2. Contract Drift Detection (`npm run validate:api-contract`)

Compares current OpenAPI spec against a baseline to detect breaking changes.

```bash
cd frontend
npm run validate:api-contract
```

Options:
- `--baseline=<path>` - Baseline spec file (default: `backend/openapi-baseline.json`)
- `--current=<path>` - Current spec file (default: fetches from running backend)
- `--fail-on-breaking` - Exit with error code if breaking changes found
- `--output=<path>` - Output report path

### 3. Runtime Validation (`apiValidator`)

Validates API responses at runtime in development/staging.

```typescript
import { apiValidator } from "@/lib/api-validator";

// Register schemas for endpoints
apiValidator.registerSchema("GET:/api/v1/loans", loanListSchema);

// Validate responses
const validation = apiValidator.validate(endpointKey, responseData, {
  path: "/api/v1/loans",
  method: "GET",
  statusCode: 200,
});
```

## Workflow

### For Backend Developers

1. **Before merging API changes:**
   ```bash
   cd backend
   npm run build
   # Generate updated OpenAPI spec
   node -e "const { generateOpenApiSpec } = require('./src/config/swagger.js'); fs.writeFileSync('openapi-current.json', JSON.stringify(generateOpenApiSpec(), null, 2));"
   ```

2. **Run drift check:**
   ```bash
   cd frontend
   npm run validate:api-contract -- --current=../backend/openapi-current.json --fail-on-breaking
   ```

3. **If breaking changes are intentional:**
   - Update the baseline: `cp backend/openapi-current.json backend/openapi-baseline.json`
   - Commit the baseline update
   - Run `npm run generate:api-types` in frontend to update types

### For Frontend Developers

1. **After pulling backend changes:**
   ```bash
   cd frontend
   npm run generate:api-types
   npm run typecheck
   ```

2. **Fix any TypeScript errors** - these indicate contract drift

3. **Use generated types in your code:**
   ```typescript
   import type { LoanDetailsResponse } from "@/types/api/api";
   
   const { data } = useQuery({
     queryKey: queryKeys.loans.detail(id),
     queryFn: () => api.get<LoanDetailsResponse>(`/loans/${id}`),
   });
   ```

### CI/CD Pipeline

The GitHub Actions workflow (`.github/workflows/contract-drift.yml`) automatically:

1. Generates OpenAPI spec from backend source
2. Compares against baseline
3. Reports breaking changes on PRs
4. Generates and validates frontend types
5. Allows manual baseline updates via workflow_dispatch

## Baseline Management

The baseline spec (`backend/openapi-baseline.json`) represents the "contract" that the frontend expects.

### When to Update Baseline

- After intentional breaking changes are merged
- After releasing a new API version
- When frontend has been updated to handle changes

### Updating Baseline

```bash
# Automatic (via CI)
gh workflow run update-baseline

# Manual
cd backend
cp openapi-current.json openapi-baseline.json
git add openapi-baseline.json
git commit -m "chore: update OpenAPI baseline spec"
```

## Best Practices

### Backend

1. **Never remove fields** - mark as deprecated instead
2. **Never change field types** - add new fields with new names
3. **Never remove endpoints** - mark as deprecated
4. **Always add new fields as optional**
5. **Use semantic versioning** for API

### Frontend

1. **Always use generated types** - don't manually define API types
2. **Handle optional fields gracefully** - use optional chaining
3. **Validate responses at runtime** in development
4. **Run typecheck before committing**

### Both

1. **Communicate API changes** in PR descriptions
2. **Use structured error codes** for programmatic handling
3. **Test against staging** before production

## Troubleshooting

### Type Generation Fails

1. Ensure backend builds successfully: `cd backend && npm run build`
2. Check OpenAPI spec is valid JSON
3. Verify no circular references in schemas

### Drift Detection False Positives

1. Check if changes are actually breaking (e.g., adding optional fields is OK)
2. Verify baseline is up to date
3. Check for spec generation issues

### Runtime Validation Errors

1. Check if backend response matches OpenAPI spec
2. Verify schema registration is correct
3. Check for serialization differences (dates, numbers)

## Related Files

- `scripts/generate-api-types.ts` - Type generation script
- `scripts/check-contract-drift.ts` - Drift detection script
- `frontend/src/lib/api-validator.ts` - Runtime validator
- `.github/workflows/contract-drift.yml` - CI workflow
- `frontend/src/types/api/` - Generated types (gitignored)
- `backend/openapi-baseline.json` - Baseline spec

## Issue References

This implementation addresses:
- #171: Frontend and backend contracts drift
- #172: API changes break the UI without warning
- #173: No automated contract validation
- #174: Missing runtime response validation
## Deprecation Window and Removal Evidence

Legacy `/api/*` routes (superseded by `/api/v1/*`) respond with `Deprecation: true`,
a `Sunset` date (override with `API_LEGACY_SUNSET`), and
`Link: </api/v1>; rel="successor-version"`.

Usage telemetry: counter `deprecated_api_requests_total{route, client_version}`.
`route` is the matched route template (never raw paths, so no wallet addresses or ids;
unmatched requests are `unmatched`). `client_version` is the `major.minor` of the optional
`X-Client-Version` header; invalid values become `other`, missing become `unknown`, and at most
20 distinct cohorts are tracked per process. No tokens or user identifiers are recorded.

Active usage over an observation window (e.g. 30d):

```promql
sum by (route, client_version) (increase(deprecated_api_requests_total[30d])) > 0
```

Removal gate for public financial APIs:
1. Deprecation headers have been live for at least 90 days and the Sunset date has passed.
2. The query above shows zero requests for the route over a full observation window (default 30 days),
   with no `unknown`/`other` cohort traffic remaining on it.
3. Remaining cohorts, if any, were notified and confirmed migrated; evidence is attached to the removal PR.
4. Contract tests for the successor route pass, and a rollback plan exists.
