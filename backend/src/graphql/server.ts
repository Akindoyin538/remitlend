import { graphqlHTTP } from 'express-graphql';
import { typeDefs } from './schema.js';
import { resolvers } from './resolvers.js';
import { createQueryBudgetRule, loadQueryBudgetLimits } from './queryBudget.js';
import { createDataLoaders, type DataLoaders } from './dataLoaders.js';

export interface GraphQLContext {
  loaders: DataLoaders;
}

export const createGraphQLMiddleware = () => {
  const limits = loadQueryBudgetLimits();
  return graphqlHTTP((req) => {
    const loaders = createDataLoaders();
    return {
      schema: typeDefs,
      rootValue: resolvers,
      validationRules: [
        createQueryBudgetRule(limits, (req as { requestId?: string }).requestId ?? 'unknown'),
      ],
      context: {
        loaders,
      },
      graphiql: true,
      pretty: true,
    };
  });
};
