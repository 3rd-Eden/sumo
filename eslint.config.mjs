import jsdoc from 'eslint-plugin-jsdoc';

const SOURCE_FILES = [
  'src/**/*.mjs',
  'packages/*/src/**/*.mjs',
  'packages/*/reference/**/*.mjs',
  'plugins/**/*.mjs',
  'scripts/**/*.mjs',
  'journeys/**/*.mjs',
];

const FUNCTION_CONTEXTS = [
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'MethodDefinition',
];

const RETURN_CONTEXTS = [
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'MethodDefinition:not([kind="constructor"])',
];

const DOC_CONTEXTS = [...FUNCTION_CONTEXTS, 'ClassDeclaration', 'ClassExpression'];

const NO_GENERATED_BOILERPLATE =
  '^(?!.*(?:Computed result|Run the callback|Map one item|Select matching items|' +
  'Test whether an item matches|Nothing is returned|Value for `|Value supplied for `|' +
  'Result produced by the operation|Promise for the operation result|' +
  'Current item being processed|Arguments passed to the operation|' +
  'Value returned by|No value is returned|Run the .* operation|Parameter value|' +
  'Structured value returned by|Numeric value returned by|List returned by|' +
  'Options that control the operation|Options that configure the operation)).+';

const NO_GENERATED_BOILERPLATE_MESSAGE =
  'JSDoc descriptions must describe the attached contract, not generated boilerplate.';

const TYPE_PREFERENCES = {
  Boolean: 'boolean',
  Number: 'number',
  String: 'string',
  Array: 'Array',
  function: 'Function',
};

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/coverage*/**',
      '**/types/**',
      '**/fixtures/**',
      '**/test/**',
      '**/*.test.mjs',
      '**/*.serial.mjs',
      'spike/**',
    ],
  },
  {
    linterOptions: {
      reportUnusedDisableDirectives: false,
    },
  },
  {
    files: SOURCE_FILES,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    plugins: {
      jsdoc,
    },
    settings: {
      jsdoc: {
        mode: 'typescript',
        preferredTypes: TYPE_PREFERENCES,
        tagNamePreference: {
          return: 'returns',
        },
      },
    },
    rules: {
      'jsdoc/check-access': 'error',
      'jsdoc/check-param-names': ['error', { checkDestructured: false }],
      'jsdoc/check-tag-names': 'error',
      'jsdoc/check-types': 'error',
      'jsdoc/informative-docs': ['error', { excludedTags: ['access'] }],
      'jsdoc/match-description': [
        'error',
        {
          contexts: DOC_CONTEXTS,
          mainDescription: {
            match: NO_GENERATED_BOILERPLATE,
            message: NO_GENERATED_BOILERPLATE_MESSAGE,
          },
          tags: {
            param: {
              match: NO_GENERATED_BOILERPLATE,
              message: NO_GENERATED_BOILERPLATE_MESSAGE,
            },
            returns: {
              match: NO_GENERATED_BOILERPLATE,
              message: NO_GENERATED_BOILERPLATE_MESSAGE,
            },
          },
        },
      ],
      'jsdoc/require-description': [
        'error',
        { contexts: DOC_CONTEXTS },
      ],
      'jsdoc/reject-any-type': 'error',
      'jsdoc/require-jsdoc': [
        'error',
        {
          checkAllFunctionExpressions: true,
          checkConstructors: true,
          checkGetters: true,
          checkSetters: true,
          contexts: FUNCTION_CONTEXTS,
          require: {
            ArrowFunctionExpression: true,
            ClassDeclaration: true,
            ClassExpression: true,
            FunctionDeclaration: true,
            FunctionExpression: true,
            MethodDefinition: true,
          },
        },
      ],
      'jsdoc/require-param': [
        'error',
        {
          checkDestructured: false,
          checkDestructuredRoots: false,
          contexts: FUNCTION_CONTEXTS,
        },
      ],
      'jsdoc/require-param-description': 'error',
      'jsdoc/require-param-name': 'error',
      'jsdoc/require-param-type': 'error',
      'jsdoc/require-returns': [
        'error',
        {
          checkGetters: true,
          contexts: RETURN_CONTEXTS,
          forceRequireReturn: true,
          forceReturnsWithAsync: true,
        },
      ],
      'jsdoc/require-returns-description': 'error',
      'jsdoc/require-returns-type': 'error',
      'jsdoc/require-tags': [
        'error',
        {
          tags: [
            { context: 'ClassDeclaration', tag: 'class' },
            { context: 'ClassExpression', tag: 'class' },
            ...FUNCTION_CONTEXTS.map((context) => ({ context, tag: 'access' })),
            { context: 'ClassDeclaration', tag: 'access' },
            { context: 'ClassExpression', tag: 'access' },
          ],
        },
      ],
      'jsdoc/valid-types': 'error',
    },
  },
];
