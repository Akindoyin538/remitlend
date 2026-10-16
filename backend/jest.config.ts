import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/*.test.ts', '**/*.spec.ts'],
  setupFilesAfterEnv: ['<rootDir>/src/tests/jest.setup.js'],
  moduleFileExtensions: ['ts', 'js', 'json', 'node'],
  transform: {
    '^.+\\.(ts|tsx)$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: {
          module: 'esnext',
          moduleResolution: 'bundler',
        },
      },
    ],
  },
  extensionsToTreatAsEsm: ['.ts'],
  globals: {
    'ts-jest': {
      useESM: true,
    },
  },
  moduleNameMapper: {
    // Correct pattern - strips .js so Jest finds the .ts source file
    '^(./|../)(.*)\\.js$': '$1$2',
  },
  // Backend latency/resource budget benchmarks (issue #575) run in a
  // dedicated, reproducible project so they can be invoked from the
  // load-test workflow without polluting the default unit-test run.
  projects: [
    '<rootDir>',
    {
      displayName: 'perf-budgets',
      preset: 'ts-jest',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/src/tests/perf/**/*.perf.ts'],
      setupFilesAfterEnv: ['<rootDir>/src/tests/perf/perf.setup.ts'],
      moduleFileExtensions: ['ts', 'js', 'json', 'node'],
      transform: {
        '^.+\\.(ts|tsx)$': [
          'ts-jest',
          {
            useESM: true,
            tsconfig: {
              module: 'esnext',
              moduleResolution: 'bundler',
            },
          },
        ],
      },
      extensionsToTreatAsEsm: ['.ts'],
      globals: {
        'ts-jest': {
          useESM: true,
        },
      },
      moduleNameMapper: {
        '^(./|../)(.*)\\.js$': '$1$2',
      },
    },
    // Hermetic full-stack journeys (issue #578) run against a local
    // deterministic Stellar/Soroban test ledger with controlled contract
    // deployments and wallet fixtures. Kept in its own project so the
    // journeys can be invoked from CI without public RPC or production
    // credentials and without polluting the default unit-test run.
    {
      displayName: 'hermetic-e2e',
      preset: 'ts-jest',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/src/tests/hermetic/**/*.e2e.ts'],
      setupFilesAfterEnv: ['<rootDir>/src/tests/hermetic/hermetic.setup.ts'],
      moduleFileExtensions: ['ts', 'js', 'json', 'node'],
      transform: {
        '^.+\\.(ts|tsx)$': [
          'ts-jest',
          {
            useESM: true,
            tsconfig: {
              module: 'esnext',
              moduleResolution: 'bundler',
            },
          },
        ],
      },
      extensionsToTreatAsEsm: ['.ts'],
      globals: {
        'ts-jest': {
          useESM: true,
        },
      },
      moduleNameMapper: {
        '^(./|../)(.*)\\.js$': '$1$2',
      },
    },
  ],
};

export default config;
