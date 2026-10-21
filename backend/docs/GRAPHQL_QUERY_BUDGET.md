# GraphQL query budget

Every GraphQL query is measured by a validation rule (`backend/src/graphql/queryBudget.ts`), so
over-budget requests are rejected during validation, before any resolver or database work runs.

## Cost model
- Each field costs 1 unless weighted: collections (`loans`, `scores`, `remittances`) cost 10,
  chain-backed fields (`poolBalance`, `totalOutstanding`) cost 25.
- Children of a collection are multiplied by the literal `limit` argument (50 when absent or a variable).
- Depth is the deepest field nesting; aliases are counted across the whole operation.
- Fragments are expanded. The calculation is deterministic.

## Limits
| Env var | Default |
| --- | --- |
| `GRAPHQL_MAX_DEPTH` | 6 |
| `GRAPHQL_MAX_ALIASES` | 10 |
| `GRAPHQL_MAX_COST` | 1000 |

Values must be positive integers. Malformed, zero, or negative values fall back to the default,
so limits cannot be disabled.

## Rejection
The response is an HTTP 400 with a generic message, `extensions.code = QUERY_BUDGET_EXCEEDED`, and
the request's correlation id (`requestId`). Measured values and schema details are not exposed.
Use the correlation id to find the request in logs.

## Tuning safely
Raise one limit at a time, based on real client queries and database load. Update `FIELD_WEIGHTS`
when adding resolvers that are collection-valued or chain-backed.
