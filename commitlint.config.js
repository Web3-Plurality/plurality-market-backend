module.exports = {
    extends: ['@commitlint/config-conventional'],
    rules: {
      // Disable the body-max-line-length rule
      'body-max-line-length': [0]
    },
  };