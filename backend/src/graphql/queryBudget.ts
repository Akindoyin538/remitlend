import {
  GraphQLError,
  Kind,
  getNamedType,
  isObjectType,
  type FragmentDefinitionNode,
  type GraphQLCompositeType,
  type SelectionSetNode,
  type ValidationContext,
  type ValidationRule,
} from 'graphql';

export interface QueryBudgetLimits {
  maxDepth: number;
  maxAliases: number;
  maxCost: number;
}

export const DEFAULT_QUERY_BUDGET: QueryBudgetLimits = {
  maxDepth: 6,
  maxAliases: 10,
  maxCost: 1000,
};

/** Default page size assumed for collection fields when `limit` is absent or not a literal. */
const DEFAULT_LIST_SIZE = 50;

/** Per-field weights keyed by "Type.field"; unlisted fields cost 1. */
const FIELD_WEIGHTS: Record<string, number> = {
  'Query.loans': 10,
  'Query.scores': 10,
  'Query.remittances': 10,
  'Query.poolBalance': 25, // chain-backed
  'Query.totalOutstanding': 25, // chain-backed
};

/** Fields whose result is a collection; their `limit` multiplies the child cost. */
const LIST_FIELDS = new Set(['Query.loans', 'Query.scores', 'Query.remittances']);

const parsePositiveInt = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  // Malformed, zero or negative values fall back to defaults so limits can never be disabled.
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

export const loadQueryBudgetLimits = (env: NodeJS.ProcessEnv = process.env): QueryBudgetLimits => ({
  maxDepth: parsePositiveInt(env.GRAPHQL_MAX_DEPTH, DEFAULT_QUERY_BUDGET.maxDepth),
  maxAliases: parsePositiveInt(env.GRAPHQL_MAX_ALIASES, DEFAULT_QUERY_BUDGET.maxAliases),
  maxCost: parsePositiveInt(env.GRAPHQL_MAX_COST, DEFAULT_QUERY_BUDGET.maxCost),
});

export interface QueryBudgetResult {
  depth: number;
  aliases: number;
  cost: number;
}

export const measureOperation = (
  context: ValidationContext,
  selectionSet: SelectionSetNode,
  rootType: GraphQLCompositeType,
): QueryBudgetResult => {
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const def of context.getDocument().definitions) {
    if (def.kind === Kind.FRAGMENT_DEFINITION) fragments.set(def.name.value, def);
  }
  let aliases = 0;
  let maxDepth = 0;

  const walk = (
    set: SelectionSetNode,
    parent: GraphQLCompositeType,
    depth: number,
    seen: Set<string>,
  ): number => {
    let total = 0;
    for (const sel of set.selections) {
      if (sel.kind === Kind.FIELD) {
        if (sel.name.value.startsWith('__')) continue;
        if (sel.alias) aliases++;
        maxDepth = Math.max(maxDepth, depth);
        const key = `${parent.name}.${sel.name.value}`;
        let cost = FIELD_WEIGHTS[key] ?? 1;
        if (sel.selectionSet) {
          const field = isObjectType(parent) ? parent.getFields()[sel.name.value] : undefined;
          const child = field ? getNamedType(field.type) : undefined;
          if (child && isObjectType(child)) {
            let multiplier = 1;
            if (LIST_FIELDS.has(key)) {
              const arg = sel.arguments?.find((a) => a.name.value === 'limit');
              multiplier =
                arg && arg.value.kind === Kind.INT
                  ? Math.max(1, parseInt(arg.value.value, 10))
                  : DEFAULT_LIST_SIZE;
            }
            cost += multiplier * walk(sel.selectionSet, child, depth + 1, seen);
          }
        }
        total += cost;
      } else if (sel.kind === Kind.INLINE_FRAGMENT) {
        total += walk(sel.selectionSet, parent, depth, seen);
      } else {
        const name = sel.name.value;
        const frag = fragments.get(name);
        if (!frag || seen.has(name)) continue; // cycles are reported by standard validation
        const type = context.getSchema().getType(frag.typeCondition.name.value);
        if (!type || !isObjectType(type)) continue;
        total += walk(frag.selectionSet, type, depth, new Set(seen).add(name));
      }
    }
    return total;
  };

  const cost = walk(selectionSet, rootType, 1, new Set());
  return { depth: maxDepth, aliases, cost };
};

/** Validation rule: runs before execution, so no resolver or database work happens on rejection. */
export const createQueryBudgetRule =
  (limits: QueryBudgetLimits, correlationId: string): ValidationRule =>
  (context) => ({
    OperationDefinition(node) {
      const rootType = context.getSchema().getQueryType();
      if (node.operation !== 'query' || !rootType) return;
      const m = measureOperation(context, node.selectionSet, rootType);
      if (m.depth > limits.maxDepth || m.aliases > limits.maxAliases || m.cost > limits.maxCost) {
        // Generic message only: no schema internals or measured values are exposed.
        context.reportError(
          new GraphQLError(
            `Query exceeds the allowed complexity budget. (code: QUERY_BUDGET_EXCEEDED, correlationId: ${correlationId})`,
            {
              extensions: { code: 'QUERY_BUDGET_EXCEEDED', correlationId },
            },
          ),
        );
      }
    },
  });
