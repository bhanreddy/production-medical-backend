/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src/__tests__'],
  setupFilesAfterEnv: ['<rootDir>/jest.setup.env.ts'],
  testTimeout: 30000,
  collectCoverageFrom: [
    'src/routes/**/*.ts',
    'src/services/**/*.ts',
    'src/middleware/**/*.ts',
    'src/lib/fifoStock.ts',
    '!src/**/*.d.ts',
  ],
  moduleFileExtensions: ['ts', 'js', 'json'],
  testPathIgnorePatterns: ['/node_modules/', 'integrationEnv\\.ts'],
  moduleNameMapper: {
    '^uuid$': '<rootDir>/jest.uuid.mock.js',
  },
};
